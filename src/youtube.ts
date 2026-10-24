import { buildSabrFormat } from "googlevideo/utils";
import type { FormatStream, SabrFormat } from "googlevideo/shared-types";
import type { ClientInfo } from "googlevideo/protos";
import type { Subtitle } from "./messages";

export type Caption = Subtitle & { url: string };
export type PlayerData = {
  videoId: string;
  title: string;
  duration: number;
  formats: SabrFormat[];
  captions: Caption[];
  config: string;
};
export type SabrContext = {
  url: string;
  config: string;
  clientInfo: ClientInfo;
  poToken?: string;
};
export type DownloadPlan = PlayerData & { transport: SabrContext; contextTabId: number; ownsContextTab: boolean };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const record = (value: unknown) => isRecord(value) ? value : {};
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const number = (value: unknown) => {
  const result = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(result) && result >= 0 ? result : undefined;
};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export const isVideoId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{11}$/.test(value);
export const configKey = (value: string) => value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
export const filenameFor = (title: string, videoId: string, extension: string) =>
  `${title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/[. ]+$/, "").slice(0, 160) || "video"} [${videoId}].${extension}`;

export function mediaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".googlevideo.com") || url.pathname !== "/videoplayback") {
    throw new Error("Endereço de mídia inesperado");
  }
  return url;
}

export function captionUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.pathname !== "/api/timedtext") {
    throw new Error("Endereço de legenda inesperado");
  }
  return url;
}

function parseFormat(value: unknown): SabrFormat | null {
  const raw = record(value);
  const itag = number(raw.itag);
  const mimeType = text(raw.mimeType);
  if (!itag || !mimeType || !/^(audio|video)\/(mp4|webm);/.test(mimeType) || array(raw.drmFamilies).length) return null;
  const format: FormatStream = {
    itag,
    mimeType,
    bitrate: number(raw.bitrate) ?? 0,
    lastModified: text(raw.lastModified),
    contentLength: text(raw.contentLength),
    approxDurationMs: text(raw.approxDurationMs),
    xtags: text(raw.xtags),
    qualityLabel: text(raw.qualityLabel),
    audioQuality: text(raw.audioQuality),
    height: number(raw.height),
    width: number(raw.width),
    fps: number(raw.fps),
    audioChannels: number(raw.audioChannels),
  };
  return buildSabrFormat(format);
}

/** Player responses are untrusted page data, including after YouTube SPA navigation. */
export function parsePlayer(value: unknown, videoId: string): PlayerData | null {
  const raw = record(value);
  const details = record(raw.videoDetails);
  if (details.videoId !== videoId) return null;
  const status = record(raw.playabilityStatus);
  if (status.status !== "OK") throw new Error(text(status.reason) ?? "O YouTube não liberou este vídeo. Abra-o na aba e conclua a verificação.");
  if (details.isLive) throw new Error("Aguarde a transmissão terminar para baixar o vídeo completo.");
  const streaming = record(raw.streamingData);
  const formats = array(streaming.adaptiveFormats).map(parseFormat).filter((format) => format !== null);
  const config = text(record(record(record(raw.playerConfig).mediaCommonConfig).mediaUstreamerRequestConfig).videoPlaybackUstreamerConfig);
  if (!config || !formats.some((f) => f.hasVideo) || !formats.some((f) => f.hasAudio)) {
    throw new Error("Não encontrei áudio e vídeo para download. Recarregue a página e tente novamente.");
  }
  const tracks = array(record(record(raw.captions).playerCaptionsTracklistRenderer).captionTracks);
  const captions = tracks.flatMap((value): Caption[] => {
    const track = record(value);
    const lang = text(track.languageCode);
    const url = text(track.baseUrl);
    if (!lang || !url) return [];
    captionUrl(url);
    const name = record(track.name);
    return [{ lang, url, auto: track.kind === "asr", name: text(name.simpleText) ?? (array(name.runs).map((r) => text(record(r).text) ?? "").join("") || lang) }];
  });
  return { videoId, title: text(details.title) ?? videoId, duration: number(details.lengthSeconds) ?? 0, formats, captions, config };
}

export const qualitiesFrom = (player: PlayerData) =>
  [...new Set(player.formats.flatMap((f) => f.hasVideo && f.height ? [f.height] : []))].sort((a, b) => b - a);

export function selectFormats(formats: SabrFormat[], height: number | null) {
  const video = formats.filter((f) => f.hasVideo && (!height || f.height === height))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0)
      || Number(b.mimeType?.includes("avc1") ?? false) - Number(a.mimeType?.includes("avc1") ?? false)
      || b.bitrate - a.bitrate)[0];
  const audio = formats.filter((f) => f.hasAudio)
    .sort((a, b) => Number(b.isOriginal ?? false) - Number(a.isOriginal ?? false)
      || Number(b.mimeType?.includes("mp4a") ?? false) - Number(a.mimeType?.includes("mp4a") ?? false)
      || b.bitrate - a.bitrate)[0];
  if (!video || !audio) throw new Error("A qualidade escolhida não tem áudio e vídeo disponíveis.");
  return { video, audio };
}

const timestamp = (ms: number) => {
  const value = Math.round(ms);
  return `${String(Math.floor(value / 3_600_000)).padStart(2, "0")}:${String(Math.floor(value / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(value / 1000) % 60).padStart(2, "0")},${String(value % 1000).padStart(3, "0")}`;
};

export function captionsToSrt(value: unknown): string {
  const cues = array(record(value).events).flatMap((value) => {
    const event = record(value);
    const start = number(event.tStartMs);
    const duration = number(event.dDurationMs);
    const content = array(event.segs).map((s) => text(record(s).utf8) ?? "").join("").trim();
    return start !== undefined && duration && content ? [{ start, end: start + duration, content }] : [];
  });
  if (!cues.length) throw new Error("O YouTube não retornou o conteúdo desta legenda.");
  return cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.content}\n`).join("\n");
}
