import { forgetPlan, refreshContext, releaseContext, resolvePlan, retainContext } from "./browser-player";
import { errorMessage, isActive, type BrowserRequest, type BrowserResponse, type DownloadJob, type Target } from "./messages";
import type { RunnerEvent, RunnerRequest } from "./offscreen";
import { isVideoId, qualitiesFrom, record } from "./youtube";

const jobs = new Map<string, DownloadJob>();
const owners = new Map<string, number>();
const restored = chrome.storage.session.get("jobs").then((stored) => {
  const values: DownloadJob[] = Array.isArray(stored.jobs) ? stored.jobs : [];
  for (const job of values) jobs.set(job.id, job);
});
let creatingOffscreen: Promise<void> | undefined;

async function runner(message: RunnerRequest) {
  await chrome.runtime.sendMessage(message);
}

async function publish(job: DownloadJob) {
  jobs.set(job.id, job);
  const recent = [...jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  for (const old of jobs.values()) if (!recent.includes(old)) { jobs.delete(old.id); owners.delete(old.id); }
  await chrome.storage.session.set({ jobs: recent });
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  await Promise.all(tabs.map((tab) => tab.id === undefined ? Promise.resolve()
    : chrome.tabs.sendMessage(tab.id, { type: "job-update", job }).catch(() => {})));
  const active = recent.find(isActive);
  await chrome.action.setBadgeText({ text: active ? active.progress === undefined ? "…" : `${Math.floor(active.progress * 100)}` : "" });
}

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Baixar as trilhas, montar o arquivo e manter o download ativo ao trocar de aba.",
    });
  })().finally(() => { creatingOffscreen = undefined; });
  return creatingOffscreen;
}

function targetFrom(value: unknown): Target | null {
  const target = record(value);
  if (target.kind === "thumbnail") return { kind: "thumbnail" };
  if (target.kind === "video" && (target.height === null || typeof target.height === "number" && Number.isInteger(target.height) && target.height > 0)) {
    return { kind: "video", height: target.height };
  }
  return target.kind === "subtitles" && typeof target.lang === "string" && /^[A-Za-z0-9_-]{1,35}$/.test(target.lang) && typeof target.auto === "boolean"
    ? { kind: "subtitles", lang: target.lang, auto: target.auto } : null;
}

function requestFrom(value: unknown): BrowserRequest | null {
  const request = record(value);
  if (request.type === "jobs") return { type: "jobs" };
  if (request.type === "cancel" && typeof request.jobId === "string") return { type: "cancel", jobId: request.jobId };
  if (!isVideoId(request.videoId)) return null;
  if (request.type === "info") return { type: "info", videoId: request.videoId };
  const target = targetFrom(request.target);
  return request.type === "download" && target ? { type: "download", videoId: request.videoId, target } : null;
}

async function start(job: DownloadJob, tabId: number, target: Target) {
  try {
    await ensureOffscreen();
    const plan = target.kind === "thumbnail" ? undefined : await resolvePlan(job.videoId, tabId);
    if (jobs.get(job.id)?.phase === "cancelled") {
      if (plan?.ownsContextTab) await releaseContext(plan.contextTabId, plan.videoId);
      return;
    }
    if (plan) retainContext(plan);
    job.title = plan?.title ?? job.title;
    await publish(job);
    await runner({ destination: "offscreen", type: "run", job, target, plan });
    if (jobs.get(job.id)?.phase === "cancelled") await runner({ destination: "offscreen", type: "cancel", jobId: job.id });
  } catch (error) {
    if (jobs.get(job.id)?.phase === "cancelled") return;
    forgetPlan(job.videoId, tabId);
    await publish({ ...job, phase: "error", error: errorMessage(error), progress: undefined, updatedAt: Date.now() });
  }
}

async function handle(request: BrowserRequest, tabId: number): Promise<BrowserResponse> {
  await restored;
  if (request.type === "jobs") return { type: "jobs", jobs: [...jobs.values()] };
  if (request.type === "cancel") {
    const job = jobs.get(request.jobId);
    if (job && isActive(job)) {
      await publish({ ...job, phase: "cancelled", progress: undefined, updatedAt: Date.now() });
      if (job.downloadId !== undefined) await chrome.downloads.cancel(job.downloadId).catch(() => {});
      await runner({ destination: "offscreen", type: "cancel", jobId: job.id }).catch(() => {});
    }
    return { type: "ok" };
  }
  if (request.type === "info") {
    const plan = await resolvePlan(request.videoId, tabId);
    return { type: "info", title: plan.title, qualities: qualitiesFrom(plan), subtitles: plan.captions.map(({ lang, name, auto }) => ({ lang, name, auto })) };
  }
  const active = [...jobs.values()].find(isActive);
  if (active) throw new Error("Já há um download em andamento. Aguarde ou cancele pelo botão desse vídeo.");
  const job: DownloadJob = {
    id: crypto.randomUUID(), videoId: request.videoId, title: request.videoId,
    phase: "preparing", bytes: 0, updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  owners.set(job.id, tabId);
  await publish(job);
  void start(job, tabId, request.target);
  return { type: "started", job };
}

async function fromRunner(message: RunnerEvent) {
  await restored;
  if (message.type === "release-context") {
    await releaseContext(message.tabId, message.videoId);
    return;
  }
  if (message.type === "refresh") {
    const job = jobs.get(message.jobId);
    if (!job || !isActive(job)) throw new Error("Download cancelado.");
    return refreshContext(job.videoId, message.tabId, message.previousToken, () => {
      const latest = jobs.get(job.id);
      return !!latest && isActive(latest);
    });
  }
  if (message.type === "progress") {
    const previous = jobs.get(message.job.id);
    if (!previous || !isActive(previous) || message.job.updatedAt < previous.updatedAt) return;
    if (message.job.phase === "error") {
      const owner = owners.get(message.job.id);
      if (owner !== undefined) forgetPlan(message.job.videoId, owner);
    }
    await publish({ ...previous, ...message.job });
    return;
  }
  const job = jobs.get(message.jobId);
  if (!job || !isActive(job)) {
    await runner({ destination: "offscreen", type: "release", jobId: message.jobId });
    return;
  }
  if (!message.url.startsWith(`blob:${chrome.runtime.getURL("")}`)) throw new Error("Arquivo de download inesperado.");
  try {
    const downloadId = await chrome.downloads.download({
      url: message.url, filename: `YouTube/${message.filename}`, conflictAction: "uniquify", saveAs: false,
    });
    const cancelled = jobs.get(job.id)?.phase === "cancelled";
    await publish({ ...job, phase: cancelled ? "cancelled" : "saving", downloadId, updatedAt: Date.now() });
    if (cancelled) await chrome.downloads.cancel(downloadId).catch(() => {});
    const [download] = await chrome.downloads.search({ id: downloadId });
    if (download && download.state !== "in_progress") await settle(downloadId, download.state, download.error);
  } catch (error) {
    await publish({ ...job, phase: "error", error: errorMessage(error), updatedAt: Date.now() });
    await runner({ destination: "offscreen", type: "release", jobId: job.id });
  }
}

async function settle(downloadId: number, state: string, error?: string) {
  await restored;
  const job = [...jobs.values()].find((job) => job.downloadId === downloadId);
  if (!job) return;
  await publish({ ...job,
    phase: job.phase === "cancelled" || error === "USER_CANCELED" ? "cancelled" : state === "complete" ? "complete" : "error",
    progress: state === "complete" ? 1 : undefined,
    error: state === "complete" ? undefined : error === "USER_CANCELED" ? undefined : `O Chrome interrompeu o download (${error ?? "erro de gravação"}).`,
    updatedAt: Date.now(),
  });
  await runner({ destination: "offscreen", type: "release", jobId: job.id }).catch(() => {});
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current && delta.state.current !== "in_progress") void settle(delta.id, delta.state.current, delta.error?.current);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (sender.url === chrome.runtime.getURL("offscreen.html") && !sender.tab) {
    // The runner is a bundled extension document, never page-controlled data.
    const event = message as RunnerEvent;
    if (event?.destination !== "background") return;
    void fromRunner(event).then((result) => respond(result ?? { ok: true }), (error: unknown) => respond({ type: "error", message: errorMessage(error) }));
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined || !sender.url?.startsWith("https://www.youtube.com/") || sender.frameId !== 0) return;
  const request = requestFrom(message);
  if (!request) return;
  void handle(request, tabId).then(respond, (error: unknown) => respond({ type: "error", message: errorMessage(error) }));
  return true;
});
