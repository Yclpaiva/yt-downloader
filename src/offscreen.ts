import { SabrStream } from "googlevideo/sabr-stream";
import { Logger } from "googlevideo/utils";
import { mergeTracks } from "./media";
import { captionsToSrt, captionUrl, filenameFor, mediaUrl, selectFormats, type DownloadPlan, type SabrContext } from "./youtube";
import { errorMessage, type DownloadJob, type Target } from "./messages";

export type RunnerRequest =
  | { destination: "offscreen"; type: "run"; job: DownloadJob; target: Target; plan?: DownloadPlan }
  | { destination: "offscreen"; type: "cancel" | "release"; jobId: string };
export type RunnerEvent =
  | { destination: "background"; type: "progress"; job: DownloadJob }
  | { destination: "background"; type: "refresh"; jobId: string; tabId: number; previousToken?: string }
  | { destination: "background"; type: "release-context"; tabId: number; videoId: string }
  | { destination: "background"; type: "file-ready"; jobId: string; url: string; filename: string };

type Running = { abort: AbortController; stream?: SabrStream; url?: string; plan?: DownloadPlan };
const running = new Map<string, Running>();
Logger.getInstance().setLogLevels();
const workspace = navigator.storage.getDirectory().then(async (root) => {
  await root.removeEntry("ytdl-jobs", { recursive: true }).catch(() => {});
  return root.getDirectoryHandle("ytdl-jobs", { create: true });
});

async function cleanup(jobId: string) {
  const state = running.get(jobId);
  state?.abort.abort();
  if (state?.url) URL.revokeObjectURL(state.url);
  if (state?.plan?.ownsContextTab) {
    const message: RunnerEvent = { destination: "background", type: "release-context", tabId: state.plan.contextTabId, videoId: state.plan.videoId };
    await chrome.runtime.sendMessage(message).catch(() => {});
  }
  running.delete(jobId);
  await (await workspace).removeEntry(jobId, { recursive: true }).catch(() => {});
}

async function run(job: DownloadJob, target: Target, plan?: DownloadPlan) {
  const state: Running = { abort: new AbortController(), plan };
  running.set(job.id, state);
  const signal = state.abort.signal;
  let lastProgress = 0;
  let protectionError: Error | undefined;
  const update = (change: Partial<DownloadJob>, force = false) => {
    Object.assign(job, change, { updatedAt: Date.now() });
    if (!force && Date.now() - lastProgress < 500) return;
    lastProgress = Date.now();
    const message: RunnerEvent = { destination: "background", type: "progress", job: { ...job } };
    void chrome.runtime.sendMessage(message).catch(() => {});
  };
  try {
    const directory = await (await workspace).getDirectoryHandle(job.id, { create: true });
    signal.throwIfAborted();
    let file: Blob;
    let filename: string;
    if (target.kind === "video") {
      if (!plan) throw new Error("O contexto do vídeo expirou. Tente novamente.");
      mediaUrl(plan.transport.url);
      const formats = selectFormats(plan.formats, target.height);
      const total = (formats.video.contentLength ?? 0) + (formats.audio.contentLength ?? 0);
      const quota = await navigator.storage.estimate();
      if (total && quota.quota && total * 2.2 > quota.quota - (quota.usage ?? 0)) {
        throw new Error("Não há espaço temporário suficiente no navegador para este vídeo. Libere espaço ou escolha uma qualidade menor.");
      }
      let initialTokenUsed = false;
      const stream = new SabrStream({
        videoId: plan.videoId,
        formats: plan.formats,
        serverAbrStreamingUrl: plan.transport.url,
        videoPlaybackUstreamerConfig: plan.transport.config,
        clientInfo: plan.transport.clientInfo,
        poToken: plan.transport.poToken,
        callbacks: {
          onMintPoToken: async () => {
            try {
              // SabrStream calls this at startup as well as after server rejection.
              if (!initialTokenUsed && plan.transport.poToken) {
                initialTokenUsed = true;
                return Uint8Array.from(atob(plan.transport.poToken), (c) => c.charCodeAt(0));
              }
              initialTokenUsed = true;
              const message: RunnerEvent = { destination: "background", type: "refresh", jobId: job.id, tabId: plan.contextTabId, previousToken: plan.transport.poToken };
              const result: { transport: SabrContext; contextTabId: number; ownsContextTab: boolean } | { type: "error"; message: string } = await chrome.runtime.sendMessage(message);
              if ("type" in result) throw new Error(result.message);
              if (!result.transport.poToken) throw new Error("A verificação do YouTube não terminou. Abra o vídeo e tente novamente.");
              signal.throwIfAborted();
              if (plan.ownsContextTab && result.contextTabId !== plan.contextTabId) {
                const release: RunnerEvent = { destination: "background", type: "release-context", tabId: plan.contextTabId, videoId: plan.videoId };
                await chrome.runtime.sendMessage(release);
              }
              const ownsContextTab = result.contextTabId === plan.contextTabId
                ? plan.ownsContextTab || result.ownsContextTab : result.ownsContextTab;
              Object.assign(plan, result, { ownsContextTab });
              stream.setStreamingURL(mediaUrl(result.transport.url));
              stream.setUstreamerConfig(result.transport.config);
              return Uint8Array.from(atob(result.transport.poToken), (c) => c.charCodeAt(0));
            } catch (error) {
              protectionError = new Error(`Não consegui renovar a verificação do YouTube. Abra o vídeo e tente novamente. ${errorMessage(error)}`);
              await stream.abort();
              throw protectionError;
            }
          },
        },
        fetchFunction: Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          mediaUrl(String(input));
          return fetch(input, { ...init, credentials: "include" });
        }, fetch),
      });
      state.stream = stream;
      // SABR errors also reject its readable streams; avoid leaking signed URLs via its default logger.
      stream.on("error", () => {});
      update({ phase: "downloading", progress: 0 }, true);
      const { videoStream, audioStream } = stream.start({
        videoFormat: formats.video, audioFormat: formats.audio,
        isPostLiveDvr: false, maxRetries: 2, stallDetectionMs: 15_000,
      });
      const saveTrack = async (name: string, source: ReadableStream<ArrayBufferView>) => {
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          for await (const chunk of source) {
            signal.throwIfAborted();
            await writable.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
            update({ bytes: job.bytes + chunk.byteLength, progress: total ? Math.min(0.85, (job.bytes + chunk.byteLength) / total * 0.85) : undefined });
          }
          await writable.close();
          return handle.getFile();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      };
      const [videoResult, audioResult] = await Promise.allSettled([
        saveTrack("video", videoStream).catch(async (error: unknown) => { await stream.abort(); throw error; }),
        saveTrack("audio", audioStream).catch(async (error: unknown) => { await stream.abort(); throw error; }),
      ]);
      if (videoResult.status === "rejected") throw videoResult.reason;
      if (audioResult.status === "rejected") throw audioResult.reason;
      const video = videoResult.value;
      const audio = audioResult.value;
      update({ phase: "merging", progress: 0.85 }, true);
      const output = await directory.getFileHandle("output.mp4", { create: true });
      await mergeTracks(video, audio, await output.createWritable(), plan.duration, signal,
        (seconds) => update({ progress: 0.85 + (plan.duration ? Math.min(1, seconds / plan.duration) : 0) * 0.1 }));
      file = await output.getFile();
      filename = filenameFor(plan.title, plan.videoId, "mp4");
    } else if (target.kind === "subtitles") {
      const caption = plan?.captions.find((sub) => sub.lang === target.lang && sub.auto === target.auto);
      if (!caption) throw new Error("Essa legenda não está disponível neste vídeo.");
      const url = captionUrl(caption.url);
      url.searchParams.set("fmt", "json3");
      if (plan?.transport.poToken) {
        url.searchParams.set("c", "WEB");
        url.searchParams.set("potc", "1");
        url.searchParams.set("pot", plan.transport.poToken);
      }
      const response = await fetch(url, { credentials: "include", signal });
      if (!response.ok) throw new Error(`O YouTube não liberou a legenda (HTTP ${response.status}).`);
      const body = await response.text();
      if (!body.trim()) throw new Error("O YouTube retornou uma legenda vazia. Ative essa legenda no player e tente novamente.");
      let data: unknown;
      try { data = JSON.parse(body); }
      catch { throw new Error("O YouTube não retornou uma legenda válida. Abra o vídeo e tente novamente."); }
      file = new Blob([captionsToSrt(data)], { type: "application/x-subrip;charset=utf-8" });
      filename = filenameFor(job.title, job.videoId, `${target.lang}.srt`);
    } else {
      update({ phase: "downloading" }, true);
      let response = await fetch(`https://i.ytimg.com/vi/${job.videoId}/maxresdefault.jpg`, { signal });
      if (!response.ok) response = await fetch(`https://i.ytimg.com/vi/${job.videoId}/hqdefault.jpg`, { signal });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) throw new Error("Não consegui baixar a thumbnail.");
      file = await response.blob();
      filename = filenameFor(job.title, job.videoId, "jpg");
    }
    signal.throwIfAborted();
    state.url = URL.createObjectURL(file);
    update({ phase: "saving", progress: 0.99 }, true);
    const message: RunnerEvent = { destination: "background", type: "file-ready", jobId: job.id, url: state.url, filename };
    await chrome.runtime.sendMessage(message);
  } catch (error) {
    await state.stream?.abort().catch(() => {});
    update({ phase: signal.aborted ? "cancelled" : "error", error: signal.aborted ? undefined : errorMessage(protectionError ?? error), progress: undefined }, true);
    await cleanup(job.id);
  }
}

chrome.runtime.onMessage.addListener((message: RunnerRequest, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.destination !== "offscreen") return;
  if (message.type === "run") {
    void run(message.job, message.target, message.plan);
  } else if (message.type === "cancel") {
    const state = running.get(message.jobId);
    state?.abort.abort();
    void state?.stream?.abort();
  } else {
    void cleanup(message.jobId);
  }
  respond({ ok: true });
});
