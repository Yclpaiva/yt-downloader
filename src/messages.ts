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
