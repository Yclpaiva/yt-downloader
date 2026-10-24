import { VideoPlaybackAbrRequest } from "googlevideo/protos";
import { configKey, parsePlayer, type DownloadPlan, type SabrContext } from "./youtube";

const captures = new Map<number, Map<string, { context: SabrContext; expires: number; renewed: boolean }>>();
const plans = new Map<string, { plan: DownloadPlan; expires: number }>();
const pending = new Map<string, Promise<DownloadPlan>>();
const contextTimers = new Map<number, ReturnType<typeof setTimeout>>();
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

// Observe only SABR requests from YouTube tabs. Tokens stay in extension memory.
chrome.webRequest.onBeforeRequest.addListener((request) => {
  if (request.tabId < 0 || request.method !== "POST" || !request.url.includes("/videoplayback?")
    || request.initiator !== "https://www.youtube.com") return;
  const parts = request.requestBody?.raw?.flatMap((part) => part.bytes ? [new Uint8Array(part.bytes)] : []) ?? [];
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (!length || length > 262_144) return;
  const body = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  try {
    const data = VideoPlaybackAbrRequest.decode(body);
    if (!data.videoPlaybackUstreamerConfig || !data.streamerContext?.clientInfo) return;
    const config = base64(data.videoPlaybackUstreamerConfig);
    const poToken = data.streamerContext.poToken ? base64(data.streamerContext.poToken) : undefined;
    const tabCaptures = captures.get(request.tabId) ?? new Map();
    const previous = tabCaptures.get(configKey(config));
    for (const [key, value] of tabCaptures) if (value.expires < Date.now()) tabCaptures.delete(key);
    if (tabCaptures.size >= 8) tabCaptures.delete(tabCaptures.keys().next().value ?? "");
    tabCaptures.set(configKey(config), {
      expires: Date.now() + 120_000,
      renewed: previous?.renewed || !!previous && previous.context.poToken !== poToken,
      context: {
        url: request.url,
        config,
        clientInfo: data.streamerContext.clientInfo,
        poToken,
      },
    });
    captures.set(request.tabId, tabCaptures);
  } catch { /* Unrelated or unsupported requests are not download contexts. */ }
}, { urls: ["https://*.googlevideo.com/videoplayback*"] }, ["requestBody"]);

chrome.tabs.onRemoved.addListener((tabId) => {
  captures.delete(tabId);
  clearTimeout(contextTimers.get(tabId));
  contextTimers.delete(tabId);
});

/** Runs in MAIN so it reads the same player response as the authenticated tab. */
function readPlayerResponse() {
  const player = document.querySelector("#movie_player, #shorts-player");
  return player && "getPlayerResponse" in player && typeof player.getPlayerResponse === "function"
    ? player.getPlayerResponse() : null;
}

function startMutedPlayer() {
  const media = document.querySelector("video");
  if (media) {
    media.muted = true;
    void media.play().catch(() => {});
  }
  const player = document.querySelector("#movie_player");
  if (player && "mute" in player && typeof player.mute === "function") player.mute();
  if (player && "playVideo" in player && typeof player.playVideo === "function") player.playVideo();
}

async function planInTab(tabId: number, videoId: string, wait: boolean, previousToken?: string, requireRenewed = false, keepWaiting = () => true): Promise<DownloadPlan | null> {
  const deadline = Date.now() + (wait ? 25_000 : 1500);
  let started = false;
  do {
    if (!keepWaiting()) return null;
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: readPlayerResponse }).catch((error: unknown) => {
      if (!wait) throw error;
      return [];
    });
    const [injection] = results;
    const player = parsePlayer(injection?.result, videoId);
    if (player) {
      if (!started && contextTimers.has(tabId)) {
        await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: startMutedPlayer });
        started = true;
      }
      const captured = captures.get(tabId)?.get(configKey(player.config));
      if (captured && captured.expires > Date.now()
        && (!previousToken || captured.context.poToken !== previousToken)
        && (!requireRenewed || captured.renewed)) {
        return { ...player, transport: captured.context, contextTabId: tabId, ownsContextTab: contextTimers.has(tabId) };
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  } while (true);
  return null;
}

async function inResolver(videoId: string, previousToken?: string, keepWaiting = () => true): Promise<DownloadPlan> {
  if (!keepWaiting()) throw new Error("Download encerrado.");
  const resolver = await chrome.tabs.create({ url: "about:blank", active: false });
  if (resolver.id === undefined) throw new Error("Não consegui preparar o vídeo no navegador.");
  const tabId = resolver.id;
  contextTimers.set(tabId, setTimeout(() => { void releaseContext(tabId, videoId); }, 60_000));
  try {
    await chrome.tabs.update(tabId, { muted: true });
    await chrome.tabs.update(tabId, { url: `https://www.youtube.com/watch?v=${videoId}` });
    const plan = await planInTab(tabId, videoId, true, previousToken, !!previousToken, keepWaiting);
    if (!plan) throw new Error("O player não liberou o download. Abra o vídeo, conclua qualquer verificação do YouTube e tente novamente.");
    return plan;
  } catch (error) {
    await releaseContext(tabId, videoId);
    throw error;
  }
}

async function resolve(videoId: string, sourceTabId: number): Promise<DownloadPlan> {
  const here = await chrome.tabs.get(sourceTabId).catch(() => null);
  if (here?.url && new URL(here.url).searchParams.get("v") === videoId) {
    const current = await planInTab(sourceTabId, videoId, false);
    if (current) return current;
  }

  // A muted, inactive YouTube tab supplies the real player context for thumbnails
  // and players that had already stopped requesting media before extension reload.
  return inResolver(videoId);
}

export function retainContext(plan: DownloadPlan) {
  if (plan.ownsContextTab) clearTimeout(contextTimers.get(plan.contextTabId));
}

export async function releaseContext(tabId: number, videoId: string) {
  clearTimeout(contextTimers.get(tabId));
  contextTimers.delete(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && !tab.active && tab.url && new URL(tab.url).searchParams.get("v") === videoId) {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** Let the genuine player replace its provisional token with its attested token. */
export async function refreshContext(videoId: string, tabId: number, previousToken?: string, keepWaiting = () => true) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const current = tab?.url && new URL(tab.url).searchParams.get("v") === videoId
    ? await planInTab(tabId, videoId, true, previousToken, false, keepWaiting) : null;
  const plan = current ?? await inResolver(videoId, previousToken, keepWaiting);
  retainContext(plan);
  return { transport: plan.transport, contextTabId: plan.contextTabId, ownsContextTab: plan.ownsContextTab };
}

export function resolvePlan(videoId: string, sourceTabId: number): Promise<DownloadPlan> {
  const key = `${sourceTabId}:${videoId}`;
  const cached = plans.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.plan);
  const existing = pending.get(key);
  if (existing) return existing;
  const result = resolve(videoId, sourceTabId).then((plan) => {
    for (const [key, value] of plans) if (value.expires < Date.now()) plans.delete(key);
    if (plans.size >= 20) plans.delete(plans.keys().next().value ?? "");
    plans.set(key, { plan, expires: Date.now() + 45_000 });
    return plan;
  }).finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

export function forgetPlan(videoId: string, sourceTabId: number) {
  plans.delete(`${sourceTabId}:${videoId}`);
}
