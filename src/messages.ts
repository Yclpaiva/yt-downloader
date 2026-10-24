// Protocol shared by content script, service worker and the native host.

export type Subtitle = { lang: string; name: string; auto: boolean };

export type Target =
  | { kind: "video"; height: number | null }
  | { kind: "thumbnail" }
  | { kind: "subtitles"; lang: string; auto: boolean };

export type Request =
  | { type: "info"; url: string }
  | { type: "download"; url: string; target: Target };

/** Native host -> service worker. `ready` and `heartbeat` never reach the page. */
export type HostResponse =
  | { type: "info"; title: string; qualities: number[]; subtitles: Subtitle[] }
  | { type: "ready"; url: string; filename: string }
  | { type: "heartbeat" }
  | { type: "error"; message: string };

/** Service worker -> content script. `done` means Chrome accepted the download. */
export type Response =
  | Extract<HostResponse, { type: "info" | "error" }>
  | { type: "done" };

// Browser protocol. The native protocol above remains for the unbundled legacy host.
export type JobPhase = "preparing" | "downloading" | "merging" | "saving" | "complete" | "error" | "cancelled";

export type DownloadJob = {
  id: string;
  videoId: string;
  title: string;
  phase: JobPhase;
  progress?: number;
  bytes: number;
  error?: string;
  downloadId?: number;
  updatedAt: number;
};

export type BrowserRequest =
  | { type: "info"; videoId: string }
  | { type: "download"; videoId: string; target: Target }
  | { type: "cancel"; jobId: string }
  | { type: "jobs" };

export type BrowserResponse =
  | { type: "info"; title: string; qualities: number[]; subtitles: Subtitle[] }
  | { type: "started"; job: DownloadJob }
  | { type: "jobs"; jobs: DownloadJob[] }
  | { type: "ok" }
  | { type: "error"; message: string };

export const isActive = (job: DownloadJob) =>
  job.phase !== "complete" && job.phase !== "error" && job.phase !== "cancelled";

/** Errors may contain signed media URLs; never expose those in UI or diagnostics. */
export const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s<>"']+/g, "[endereço de mídia]");
