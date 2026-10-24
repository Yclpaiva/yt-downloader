# YT Downloader

Download YouTube videos with audio, thumbnails and subtitles directly in Chrome.
The extension uses the browser's YouTube player session and assembles the finished
file locally in JavaScript. No yt-dlp, ffmpeg, Bun host or cookie export is needed
while downloading.

## Install

[Bun](https://bun.sh) is needed only to build the extension:

```sh
bun install
bun run build
```

In Chrome 124 or newer:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this project's `dist/` directory.
3. Reload your YouTube tabs.

After rebuilding, reload the extension and the YouTube tab. Version 0.2 requests
access to YouTube's media and thumbnail domains so downloads can run inside the
browser. It does not request the cookies API or send your session to a server.

Existing installations can keep their old native host registration; this version
does not call it. The old host source and its previous instructions remain in
[`docs/legacy-host.md`](docs/legacy-host.md) for reference.

## Use

Move the pointer over the player or a video thumbnail. The download button sits
56 pixels below the top of the media, clear of the top row of native controls.

- Choose a resolution to save a complete MP4 with audio.
- Choose **Thumbnail** to save the cover as JPG.
- Choose a subtitle track to save it as SRT. Automatic tracks are marked `auto`.
- While downloading, click the button to see progress or cancel.

Files go into `YouTube/` inside Chrome's download directory. The button only
reports completion after Chrome finishes saving. An error remains available on
the button so you can read it and retry.

A muted, inactive YouTube tab may appear while preparing a thumbnail's video or
renewing playback verification. It uses the same browser profile and is closed
when no longer needed. Downloads continue if you navigate away from the original
video. Keep Chrome open until the download finishes.

## How it works

The extension observes the player's SABR request and reads the matching player
response. It reuses the media context and obtains fresh playback attestation from
the genuine player when YouTube requests renewal. Cookies are not exported.

A Chrome offscreen document downloads the audio and video streams with
[`googlevideo`](https://github.com/LuanRT/googlevideo), writing them to temporary
browser storage. [`Mediabunny`](https://mediabunny.dev) then copies the encoded
packets into one MP4 without re-encoding. Files are read and written in chunks;
the entire video is not accumulated in a JavaScript array or WebAssembly heap.

Chrome saves the completed file through its normal downloads API. Temporary
files and the object URL are removed on completion, cancellation or failure.

## Limits

- One download runs at a time.
- Live broadcasts must end before downloading. DRM-protected content is not
  supported.
- YouTube can still require a visible login or verification. Complete it on the
  video page and retry; the extension does not solve CAPTCHAs.
- Available resolutions and codecs come from YouTube. High resolutions may use
  codecs that require a compatible player; the extension does not transcode.
- Temporary storage needs space for the separate tracks and the assembled file.
- Only subtitle tracks supplied by the player are offered. YouTube can reject a
  subtitle request independently of video playback.
- Browser and YouTube protocol changes can require an extension update.

## Development

```sh
bun run check
bun test
bun run build
```

Tests cover player parsing, quality selection, endpoint validation, subtitle
conversion, browser muxing, truncated streams and cancellation. The media fixture
contains two seconds of synthetic color bars and a 440 Hz tone, so tests do not
require native media tools.

Runtime code:

- `src/content.ts`: overlay, menus and job updates.
- `src/background.ts`: job coordination and Chrome downloads.
- `src/browser-player.ts`: player session and playback-context renewal.
- `src/offscreen.ts`: media transfer, temporary storage and cleanup.
- `src/media.ts`: encoded audio/video packet muxing.
- `src/youtube.ts`: response parsing, format selection and SRT conversion.

The `host/` directory is legacy source and is not included in `dist/`.
