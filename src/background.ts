// One native host process per page port. The host answers a download request
// with a loopback URL; Chrome fetches it, so the download shows in its own UI.
import type { HostResponse, Response } from "./messages";

const HOST = "dev.yclpaiva.ytdl";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ytdl") return;
  const native = chrome.runtime.connectNative(HOST);
  const downloads = new Set<number>();
  let pageGone = false;

  const reply = (message: Response) => {
    if (!pageGone) port.postMessage(message);
  };
  // Keep the host alive until Chrome has finished pulling every download it serves.
  const settle = () => {
    if (pageGone && downloads.size === 0) native.disconnect();
  };
  const onChanged = (delta: chrome.downloads.DownloadDelta) => {
    if (delta.state && delta.state.current !== "in_progress" && downloads.delete(delta.id)) settle();
  };
  chrome.downloads.onChanged.addListener(onChanged);

  native.onMessage.addListener(async (message: HostResponse) => {
    if (message.type === "heartbeat") return;
    if (message.type !== "ready") return reply(message);
    try {
      const id = await chrome.downloads.download({
        url: message.url,
        filename: `YouTube/${message.filename}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      downloads.add(id);
      reply({ type: "done" });
    } catch (err) {
      reply({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  });
  native.onDisconnect.addListener(() => {
    chrome.downloads.onChanged.removeListener(onChanged);
    const reason = chrome.runtime.lastError?.message;
    if (reason) reply({ type: "error", message: `Host nativo indisponível (${reason}). Rode ./install.sh no projeto.` });
    if (!pageGone) port.disconnect();
  });

  port.onMessage.addListener((message) => native.postMessage(message));
  port.onDisconnect.addListener(() => {
    pageGone = true;
    settle();
  });
});
