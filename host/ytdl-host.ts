// Native messaging host. Chrome talks to it over stdio; downloads are served
// over a loopback HTTP server so they show up in Chrome's own download UI.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { HostResponse, Request, Target } from "../src/messages";
import {
  decode, encode, filenameFor, qualitiesFrom, sidecarArgs, sidecarPath, subtitlesFrom, videoArgs,
  type Info, type Sidecar,
} from "./lib";

// Chrome launches hosts with a minimal PATH; Homebrew and friends are not on it.
const PATH = `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:${process.env.PATH ?? ""}`;
const YTDLP = Bun.which("yt-dlp", { PATH });
const TOKEN_TTL_MS = 60_000;

type Job = { url: string; target: Target; filename: string; expires: number };
const jobs = new Map<string, Job>();
const infoCache = new Map<string, Promise<Info>>();
let activeStreams = 0;
let stdinClosed = false;

const send = (message: HostResponse) => {
  if (stdinClosed) return;
  try {
    process.stdout.write(encode(message));
  } catch {
    stdinClosed = true;
  }
};

function spawn(args: string[]) {
  if (!YTDLP) throw new Error("yt-dlp não encontrado (brew install yt-dlp)");
  return Bun.spawn([YTDLP, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH } });
}

const lastError = (stderr: string, code: number) =>
  (stderr.trim().split("\n").filter(Boolean).pop() ?? `yt-dlp saiu com código ${code}`).replace(/^ERROR:\s*/, "");

/** Runs yt-dlp to completion and returns stdout, throwing on failure. */
async function run(args: string[]): Promise<string> {
  const proc = spawn(args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(lastError(stderr, code));
  return stdout;
}

function infoFor(url: string): Promise<Info> {
  const cached = infoCache.get(url);
  if (cached) return cached;
  const promise = run(["-J", "--no-playlist", "--skip-download", "--no-warnings", url]).then(
    (json) => JSON.parse(json) as Info,
  );
  promise.catch(() => infoCache.delete(url));
  infoCache.set(url, promise);
  return promise;
}

// --- HTTP: one URL per download, consumed on first request -------------------

async function streamVideo(url: string, height: number | null): Promise<Response> {
  const proc = spawn(videoArgs(url, height));
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  if (first.done) {
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return new Response(lastError(stderr, code), { status: 500 });
  }
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(first.value),
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!done) return controller.enqueue(value);
      // A truncated stream must look like a failure to Chrome, not a finished file.
      const code = await proc.exited;
      code === 0 ? controller.close() : controller.error(new Error(`yt-dlp saiu com código ${code}`));
    },
    cancel: () => proc.kill(),
  });
  return new Response(body, { headers: { "content-type": "video/mp4" } });
}

async function serveSidecar(url: string, target: Sidecar): Promise<Response> {
  const dir = await mkdtemp(join(tmpdir(), "ytdl-"));
  try {
    const printed = (await run(sidecarArgs(url, target, dir))).trim();
    const file = Bun.file(sidecarPath(printed, target));
    if (!(await file.exists())) throw new Error("yt-dlp terminou mas não gerou o arquivo");
    return new Response(await file.arrayBuffer(), { headers: { "content-type": file.type } });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 500 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const token = new URL(req.url).pathname.slice("/dl/".length);
    const job = jobs.get(token);
    if (!job || job.expires < Date.now()) return new Response("link expirado", { status: 404 });
    jobs.delete(token);
    activeStreams++;
    try {
      const res =
        job.target.kind === "video"
          ? await streamVideo(job.url, job.target.height)
          : await serveSidecar(job.url, job.target);
      res.headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`);
      return res;
    } finally {
      activeStreams--;
      maybeExit();
    }
  },
});

// --- stdio side --------------------------------------------------------------

async function handle(message: unknown) {
  const request = message as Request;
  try {
    if (request.type === "info") {
      const info = await infoFor(request.url);
      send({ type: "info", title: info.title ?? "", qualities: qualitiesFrom(info), subtitles: subtitlesFrom(info) });
    } else if (request.type === "download") {
      const filename = filenameFor(await infoFor(request.url), request.target);
      const token = crypto.randomUUID();
      jobs.set(token, { url: request.url, target: request.target, filename, expires: Date.now() + TOKEN_TTL_MS });
      send({ type: "ready", url: `http://127.0.0.1:${server.port}/dl/${token}`, filename });
    } else {
      throw new Error(`Mensagem desconhecida: ${JSON.stringify(message)}`);
    }
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

const busy = () => activeStreams > 0 || [...jobs.values()].some((j) => j.expires > Date.now());

// Chrome may close stdin while a stream is still being served; stay up for it.
function maybeExit() {
  if (stdinClosed && !busy()) process.exit(0);
}

// Keeps the extension's service worker alive while Chrome is still pulling bytes.
setInterval(() => (busy() ? send({ type: "heartbeat" }) : maybeExit()), 20_000);

let buffer = Buffer.alloc(0);
for await (const chunk of Bun.stdin.stream()) {
  const { messages, rest } = decode(Buffer.concat([buffer, Buffer.from(chunk)]));
  buffer = Buffer.from(rest);
  for (const message of messages) await handle(message);
}
stdinClosed = true;
maybeExit();
