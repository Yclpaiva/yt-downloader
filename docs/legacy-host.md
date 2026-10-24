# Legacy native host (before 0.2)

These instructions are archived. The current extension runs entirely in Chrome.
The source below preserves the previous local setup notes.

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
4. The host downloads to a temp dir, lets yt-dlp merge video+audio into one
   MP4, and serves the finished file. Thumbnail and subtitles are generated in
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

## YouTube sign-in errors

If YouTube says `Sign in to confirm you're not a bot`, save the Netscape-format
cookie file as `~/.config/yt-downloader/cookies.txt`. The native host passes it
and the requesting Chrome tab's User-Agent to every `yt-dlp` call, including
video metadata, downloads, thumbnails and subtitles. Keep the file outside this
repository and restrict access:

```sh
mkdir -p ~/.config/yt-downloader
chmod 700 ~/.config/yt-downloader
chmod 600 ~/.config/yt-downloader/cookies.txt
```

The file is optional. Without it, the extension runs `yt-dlp` without cookies.
Reload the YouTube tab after adding the file so the native host starts with the
updated configuration.
See the [yt-dlp FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)
for the expected cookie format.

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
- The download starts only after the merge finishes, and Chrome shows bytes
  received instead of a percentage.

## License

Personal project, published as-is. YouTube's terms apply to whatever you
download.
