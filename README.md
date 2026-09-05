<div align="center">

# YT Downloader

**A download button that lives inside the YouTube player.**

Videos in the quality you pick · Thumbnails · Subtitles

[![Chrome](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop/concepts/manifest-v3)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-built_with-fbf0c9?logo=bun&logoColor=black)](https://bun.sh)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#license)

</div>

---

YT Downloader overlays a small button on the YouTube player and on every video
thumbnail. It follows the player's own controls: invisible until you move the
mouse, gone a few seconds after you stop. Downloads run through the native
Chrome download bubble, with progress, file name and native errors.

## What it does

| Where | What you get |
| --- | --- |
| Player & Shorts | Video in MP4 (H.264 + AAC), one menu entry per available height |
| Video thumbnails | Button on feed, search and channel grids |
| Menu → Thumbnail | Cover image as JPG |
| Menu → Legendas | Subtitles as SRT, manual first, auto ones tagged "auto" |

Files land in a `YouTube/` folder inside Chrome's download directory.

## How it works

```
content.ts ──port──▶ background.ts ──connectNative──▶ host/run.sh → ytdl-host.ts
                           │                                  │
                           └── chrome.downloads.download ◀── http://127.0.0.1:<port>/dl/<token>
```

1. The content script mounts the button and reads the video id at click time,
   so the button never goes stale when YouTube recycles elements.
2. Opening the menu asks the native host for `info`: title, available heights
   and subtitle tracks.
3. Picking an item returns a one-shot loopback URL; the service worker hands it
   to `chrome.downloads.download`, and from there it is a regular Chrome
   download.
4. The host streams yt-dlp output through ffmpeg straight into the HTTP
   response — no temp files for video. Thumbnail and subtitles are generated in
   a temp dir and served right after.

The heavy lifting is [yt-dlp](https://github.com/yt-dlp/yt-dlp) + ffmpeg via
native messaging. The extension extracts nothing on its own, so it keeps
working as long as `yt-dlp` is up to date (`brew upgrade yt-dlp`).

## Install

Prerequisites: `brew install yt-dlp ffmpeg` and [Bun](https://bun.sh).

```sh
./install.sh
```

The script builds `dist/` and registers the native messaging host
(`dev.yclpaiva.ytdl`) for Chrome (and Edge, if present). Then:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

If you move the project folder, run `./install.sh` again — the host manifest
points to the absolute path of `host/run.sh`.

## Development

```sh
bun run check   # tsc
bun test        # framing, metadata, yt-dlp arguments
bun run build   # dist/
```

```
src/
├── content.ts      # DOM scanning, button overlay, auto-hide, menu
├── background.ts   # native messaging bridge + chrome.downloads wiring
└── messages.ts     # content ⇄ background ⇄ host contract
host/
├── ytdl-host.ts    # native messaging host: stdio framing, loopback HTTP server
└── lib.ts          # yt-dlp argument builders and metadata parsing
```

The host runs straight from source with Bun — changes to `host/` apply on the
next click, no reinstall. Changes to `src/` need `bun run build` and a refresh
in `chrome://extensions`.

## Limitations

- Only works on this machine, where the host is registered.
- Cannot be published to the Chrome Web Store: YouTube downloaders are banned there.
- Playlists are never downloaded; the button always picks a single video.
- Chrome doesn't know the final size up front, so the download bar shows bytes
  received instead of a percentage.
- The MP4 is fragmented (streamed). QuickTime, VLC and browsers play it fine;
  some old editors prefer a conventional MP4 — remux with
  `ffmpeg -i in.mp4 -c copy out.mp4`.

## License

Personal project, published as-is. YouTube's terms apply to whatever you
download.
