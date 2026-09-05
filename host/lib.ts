import type { Subtitle, Target } from "../src/messages";

// --- stdio framing (Chrome native messaging: u32 LE length + JSON) ----------

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Pulls every complete frame out of `buffer`; returns them and the leftover bytes. */
export function decode(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString()));
    offset += 4 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

// --- yt-dlp metadata ---------------------------------------------------------

export type Info = {
  id?: string;
  title?: string;
  formats?: { height?: number | null; vcodec?: string | null }[];
  subtitles?: Record<string, { name?: string }[]>;
  automatic_captions?: Record<string, { name?: string }[]>;
};

/** Distinct video heights, best first. */
export function qualitiesFrom(info: Info): number[] {
  const heights = new Set<number>();
  for (const f of info.formats ?? []) {
    if (f.height && f.vcodec && f.vcodec !== "none") heights.add(f.height);
  }
  return [...heights].sort((a, b) => b - a);
}

/** Manual subtitles first, then auto captions not already covered manually. */
export function subtitlesFrom(info: Info): Subtitle[] {
  const manual = Object.entries(info.subtitles ?? {}).map(([lang, tracks]) => ({
    lang,
    name: tracks[0]?.name ?? lang,
    auto: false,
  }));
  const seen = new Set(manual.map((s) => s.lang));
  const auto = Object.entries(info.automatic_captions ?? {})
    .filter(([lang]) => !seen.has(lang))
    .map(([lang, tracks]) => ({ lang, name: tracks[0]?.name ?? lang, auto: true }));
  const byName = (a: Subtitle, b: Subtitle) => a.name.localeCompare(b.name);
  return [...manual.sort(byName), ...auto.sort(byName)];
}

const sanitize = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();

export function filenameFor(info: Info, target: Target): string {
  const stem = `${sanitize(info.title || "video")} [${info.id ?? "unknown"}]`;
  return target.kind === "video"
    ? `${stem}.mp4`
    : target.kind === "thumbnail"
      ? `${stem}.jpg`
      : `${stem}.${target.lang}.srt`;
}

// --- yt-dlp arguments --------------------------------------------------------

const COMMON = ["--no-playlist", "-q", "--no-warnings"];

/** Prefer H.264 in MP4 for QuickTime; fall back to anything muxable into MP4. */
export function videoFormat(height: number | null): string {
  const h = height ? `[height<=${height}]` : "";
  return [
    `bv*${h}[ext=mp4][vcodec^=avc1]+ba[ext=m4a]`,
    `bv*${h}[ext=mp4]+ba[ext=m4a]`,
    `bv*${h}+ba`,
    `b${h}`,
  ].join("/");
}

/**
 * Streams a fragmented MP4 to stdout. ffmpeg does the download and the merge,
 * so no temp file is needed and Chrome sees bytes as soon as they exist.
 */
export function videoArgs(url: string, height: number | null): string[] {
  return [
    ...COMMON,
    "-f", videoFormat(height),
    "--downloader", "ffmpeg",
    "--downloader-args", "ffmpeg_o:-movflags frag_keyframe+empty_moov -f mp4",
    "-o", "-",
    url,
  ];
}

export type Sidecar = Exclude<Target, { kind: "video" }>;

/** Sidecars are written to `outDir`; `--print filename` gives the video stem. */
export function sidecarArgs(url: string, target: Sidecar, outDir: string): string[] {
  // --print implies --simulate, which would skip writing the files.
  const common = [
    ...COMMON, "--no-simulate", "--skip-download",
    "--print", "filename", "-o", `${outDir}/media.%(ext)s`,
  ];
  return target.kind === "thumbnail"
    ? [...common, "--write-thumbnail", "--convert-thumbnails", "jpg", url]
    : [
        ...common,
        target.auto ? "--write-auto-subs" : "--write-subs",
        "--sub-langs", target.lang, "--convert-subs", "srt",
        url,
      ];
}

export function sidecarPath(printedFilename: string, target: Sidecar): string {
  const stem = printedFilename.replace(/\.[a-z0-9]+$/i, "");
  return target.kind === "subtitles" ? `${stem}.${target.lang}.srt` : `${stem}.jpg`;
}
