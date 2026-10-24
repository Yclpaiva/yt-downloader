import { isActive, type BrowserRequest, type BrowserResponse, type DownloadJob, type Target } from "./messages";

type Info = Extract<BrowserResponse, { type: "info" }>;

const HOST_ATTR = "data-ytdl";
const MIN_SIZE = 100;
// Matches the player's own control fade: visible while the pointer moves, gone shortly after.
const HIDE_DELAY_MS = 3000;
const VIDEO_ID_RE = /(?:[?&]v=|\/shorts\/)([A-Za-z0-9_-]{11})(?:[&/?#]|$)/;

const hosts = new WeakMap<Element, HTMLElement>();

const ICONS = {
  idle: `<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`,
  done: `<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>`,
  error: `<svg viewBox="0 0 24 24"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`,
};

const STYLE = `
  :host { font: 500 13px/1.3 Roboto, system-ui, sans-serif; color: #fff; }
  button { all: unset; box-sizing: border-box; cursor: pointer; }
  .btn { width: 32px; height: 32px; border-radius: 50%; background: rgba(0,0,0,.65);
    display: grid; place-items: center; opacity: .85;
    transition: opacity .15s, background .15s; backdrop-filter: blur(4px); }
  .btn:hover { opacity: 1; background: rgba(0,0,0,.9); }
  .btn[data-state="busy"] { cursor: progress; }
  .btn[data-state="busy"] svg { animation: pulse 1s ease-in-out infinite; }
  .btn[data-state="done"] { background: #1f8a4c; }
  .btn[data-state="error"] { background: #c0392b; }
  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2;
    stroke-linecap: round; stroke-linejoin: round; }
  .menu { position: absolute; top: 38px; right: 0; width: 240px; max-height: 360px; overflow-y: auto;
    background: #1f1f1f; border: 1px solid #3a3a3a; border-radius: 10px; padding: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  .menu[hidden] { display: none; }
  .item { display: block; width: 100%; padding: 7px 10px; border-radius: 6px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .item:hover { background: #333; }
  .item small { color: #aaa; margin-left: 6px; }
  .label { padding: 8px 10px 4px; color: #aaa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  hr { border: 0; border-top: 1px solid #3a3a3a; margin: 6px 0; }
  .status { padding: 8px 10px; white-space: normal; line-height: 1.5; }
  @keyframes pulse { 50% { opacity: .35; } }
`;

// --- context -----------------------------------------------------------------

const videoIdIn = (text: string) => VIDEO_ID_RE.exec(text)?.[1] ?? null;

/** Player surfaces on watch and shorts pages: the id comes from the URL at click time. */
const isPlayer = (el: Element) => el.matches("#movie_player, #shorts-player");

/** Thumbnails: an anchor to a video that contains a sizeable image. */
function isThumbnailLink(el: Element): el is HTMLAnchorElement {
  if (!(el instanceof HTMLAnchorElement) || !videoIdIn(el.getAttribute("href") ?? "")) return false;
  return el.querySelector("img, yt-image") !== null;
}

// --- browser jobs ------------------------------------------------------------

async function request(message: BrowserRequest): Promise<BrowserResponse> {
  const response: BrowserResponse | undefined = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error("A extensão não respondeu. Recarregue a página.");
  if (response.type === "error") throw new Error(response.message);
  return response;
}

const jobs = new Map<string, DownloadJob>();
const overlays = new Map<HTMLElement, () => void>();
const syncOverlays = () => {
  for (const [host, sync] of overlays) host.isConnected ? sync() : overlays.delete(host);
};
function updateJob(job: DownloadJob) {
  if ((jobs.get(job.videoId)?.updatedAt ?? 0) > job.updatedAt) return;
  jobs.set(job.videoId, job);
  syncOverlays();
}
chrome.runtime.onMessage.addListener((message: { type?: string; job?: DownloadJob }, sender) => {
  if (sender.id === chrome.runtime.id && message.type === "job-update" && message.job) updateJob(message.job);
});
void request({ type: "jobs" }).then((response) => {
  if (response.type === "jobs") for (const job of response.jobs) updateJob(job);
}).catch(() => {});

const infoCache = new Map<string, { value: Promise<Info>; expires: number }>();
function infoFor(id: string): Promise<Info> {
  const cached = infoCache.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  const promise = request({ type: "info", videoId: id }).then((r) => {
    if (r.type !== "info") throw new Error("Não consegui obter as opções deste vídeo.");
    return r;
  });
  promise.catch(() => infoCache.delete(id));
  infoCache.set(id, { value: promise, expires: Date.now() + 30_000 });
  return promise;
}

// --- overlay -----------------------------------------------------------------

type State = "idle" | "busy" | "done" | "error";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function mount(frame: HTMLElement, getVideoId: () => string | null): HTMLElement {
  if (getComputedStyle(frame).position === "static") frame.style.position = "relative";

  const host = document.createElement("div");
  host.setAttribute(HOST_ATTR, "");
  host.style.cssText =
    "position:absolute;top:56px;right:10px;z-index:2147483647;width:32px;height:32px;" +
    "opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><button class="btn" type="button"></button><div class="menu" hidden></div>`;
  const button = root.querySelector<HTMLButtonElement>(".btn")!;
  const menu = root.querySelector<HTMLDivElement>(".menu")!;
  let showingJob = false;

  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const setState = (state: State, title: string) => {
    button.dataset.state = state;
    button.title = title;
    button.innerHTML = ICONS[state === "busy" ? "idle" : state];
    clearTimeout(resetTimer);
    if (state === "done") {
      resetTimer = setTimeout(() => setState("idle", "Baixar"), 4000);
    }
  };
  setState("idle", "Baixar");

  const swallow = (event: Event) => event.stopPropagation();
  for (const type of ["pointerdown", "mousedown", "mouseup", "touchstart", "dblclick", "keydown"]) {
    host.addEventListener(type, swallow);
  }
  host.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const closeMenu = () => {
    menu.hidden = true;
    document.removeEventListener("pointerdown", onOutside, true);
  };
  const onOutside = (event: Event) => {
    if (!event.composedPath().includes(host)) closeMenu();
  };

  /** A job survives page navigation; only Chrome's completion event marks it done. */
  async function download(id: string, target: Target) {
    closeMenu();
    setState("busy", "Preparando download…");
    try {
      const response = await request({ type: "download", videoId: id, target });
      if (response.type !== "started") throw new Error("Não consegui iniciar o download.");
      updateJob(response.job);
    } catch (err) {
      infoCache.delete(id);
      setState("error", err instanceof Error ? err.message : String(err));
    }
  }

  const item = (text: string, hint: string | null, onClick: () => void) => {
    const node = el("button", "item", text);
    node.type = "button";
    if (hint) node.appendChild(el("small", "", hint));
    node.addEventListener("click", onClick);
    return node;
  };

  const thumbnailItem = (id: string) => item("Thumbnail", "jpg", () => download(id, { kind: "thumbnail" }));

  const jobLabel = (job: DownloadJob) => {
    const phase = {
      preparing: "Preparando vídeo…", downloading: "Baixando…", merging: "Juntando áudio e vídeo…",
      saving: "Salvando arquivo…", complete: "Download concluído", error: "Falha no download", cancelled: "Download cancelado",
    }[job.phase];
    return job.error ?? `${phase}${isActive(job) && job.progress !== undefined ? ` ${Math.floor(job.progress * 100)}%` : ""}`;
  };

  function renderJob(job: DownloadJob) {
    showingJob = true;
    const label = el("div", "status", jobLabel(job));
    menu.replaceChildren(label);
    if (job.videoId !== getVideoId()) menu.prepend(el("div", "status", job.title));
    if (job.bytes) menu.appendChild(el("div", "label", `${(job.bytes / 1024 / 1024).toFixed(1)} MB recebidos`));
    const id = getVideoId();
    if (isActive(job)) {
      menu.appendChild(item("Cancelar download", null, () => {
        void request({ type: "cancel", jobId: job.id }).catch((error: unknown) =>
          setState("error", error instanceof Error ? error.message : String(error)));
      }));
    } else if (id) {
      menu.appendChild(item("Escolher download", null, () => { void openMenu(id); }));
    }
  }

  function render(id: string, info: Info) {
    const videos = info.qualities.length
      ? info.qualities.map((h, i) =>
          item(`${h}p`, i === 0 ? "melhor" : null, () => download(id, { kind: "video", height: h })),
        )
      : [item("Vídeo", "melhor disponível", () => download(id, { kind: "video", height: null }))];
    const subtitles = info.subtitles.map((sub) =>
      item(sub.name, sub.auto ? "auto" : null, () =>
        download(id, { kind: "subtitles", lang: sub.lang, auto: sub.auto }),
      ),
    );
    menu.replaceChildren(
      el("div", "label", "Vídeo"),
      ...videos,
      el("hr", ""),
      thumbnailItem(id),
      el("hr", ""),
      el("div", "label", subtitles.length ? "Legendas" : "Sem legendas disponíveis"),
      ...subtitles,
    );
  }

  async function openMenu(id: string) {
    showingJob = false;
    menu.replaceChildren(el("div", "label", "Carregando…"), el("hr", ""), thumbnailItem(id));
    menu.hidden = false;
    document.addEventListener("pointerdown", onOutside, true);
    try {
      const info = await infoFor(id);
      if (!menu.hidden) render(id, info);
    } catch (err) {
      const label = menu.querySelector(".label");
      if (label) label.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  button.addEventListener("click", () => {
    if (!menu.hidden) return closeMenu();
    const id = getVideoId();
    const job = (id ? jobs.get(id) : undefined) ?? [...jobs.values()].find(isActive);
    if (job && (isActive(job) || job.phase === "error")) {
      renderJob(job);
      menu.hidden = false;
      document.addEventListener("pointerdown", onOutside, true);
      return;
    }
    id ? openMenu(id) : setState("error", "Não identifiquei o vídeo");
  });

  // --- auto-hide: pointer activity over the frame reveals the button ---
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    // Never hide mid-interaction; try again once the menu closes or the state settles.
    if (!menu.hidden || button.dataset.state !== "idle") return scheduleHide();
    host.style.opacity = "0";
    host.style.visibility = "hidden";
  };
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };
  const show = () => {
    host.style.opacity = "1";
    host.style.visibility = "visible";
    scheduleHide();
  };
  frame.addEventListener("mousemove", show, { passive: true });
  frame.addEventListener("mouseenter", show, { passive: true });
  frame.addEventListener("mouseleave", () => {
    clearTimeout(hideTimer);
    hide();
  });

  frame.appendChild(host);
  overlays.set(host, () => {
    const id = getVideoId();
    const job = id ? jobs.get(id) : undefined;
    if (!job) return setState("idle", "Baixar");
    setState(isActive(job) ? "busy" : job.phase === "complete" ? "done" : job.phase === "error" ? "error" : "idle", jobLabel(job));
    if (isActive(job) || job.phase === "error") show();
    if (!menu.hidden && showingJob) renderJob(job);
  });
  syncOverlays();
  return host;
}

// --- scanning ----------------------------------------------------------------

function scan() {
  syncOverlays();
  const selector = "#movie_player, #shorts-player, a[href*='/watch?v='], a[href*='/shorts/']";
  for (const node of document.querySelectorAll<HTMLElement>(selector)) {
    if (hosts.get(node)?.isConnected) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
    if (isPlayer(node)) {
      hosts.set(node, mount(node, () => videoIdIn(location.href)));
    } else if (isThumbnailLink(node)) {
      hosts.set(node, mount(node, () => videoIdIn(node.getAttribute("href") ?? "")));
    }
  }
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    scan();
  }, 400);
}

new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("scroll", schedule, { passive: true });
window.addEventListener("yt-navigate-finish", schedule);
schedule();
