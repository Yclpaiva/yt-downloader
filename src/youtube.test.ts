import { describe, expect, test } from "bun:test";
import { captionsToSrt, captionUrl, filenameFor, mediaUrl, parsePlayer, selectFormats } from "./youtube";
import { errorMessage } from "./messages";

const id = "jNQXAC9IVRw";
const player = () => ({
  videoDetails: { videoId: id, title: "Synthetic video", lengthSeconds: "19" },
  playabilityStatus: { status: "OK" },
  playerConfig: { mediaCommonConfig: { mediaUstreamerRequestConfig: { videoPlaybackUstreamerConfig: "config" } } },
  streamingData: { adaptiveFormats: [
    { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', height: 1080, qualityLabel: "1080p", bitrate: 500, approxDurationMs: "19000" },
    { itag: 247, mimeType: 'video/webm; codecs="vp9"', height: 720, qualityLabel: "720p", bitrate: 400, approxDurationMs: "19000" },
    { itag: 136, mimeType: 'video/mp4; codecs="avc1.4d401f"', height: 720, qualityLabel: "720p", bitrate: 300, approxDurationMs: "19000" },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: "AUDIO_QUALITY_MEDIUM", bitrate: 128, approxDurationMs: "19000" },
  ] },
});

describe("player and format selection", () => {
  test("rejects a previous video's player response after SPA navigation", () => {
    expect(parsePlayer(player(), "abcdefghijk")).toBeNull();
  });
  test("keeps the selected resolution and prefers H.264 at the same height", () => {
    const data = parsePlayer(player(), id);
    expect(data).not.toBeNull();
    const result = selectFormats(data?.formats ?? [], 720);
    expect(result.video.itag).toBe(136);
    expect(result.audio.itag).toBe(140);
    expect(() => selectFormats(data?.formats ?? [], 2160)).toThrow("qualidade escolhida");
  });
  test("never treats an audio-only response as a complete video", () => {
    const raw = player();
    raw.streamingData.adaptiveFormats = raw.streamingData.adaptiveFormats.filter((f) => f.mimeType.startsWith("audio"));
    expect(() => parsePlayer(raw, id)).toThrow("áudio e vídeo");
  });
  test("preserves the player error instead of pretending a login challenge is playable", () => {
    const raw = { ...player(), playabilityStatus: { status: "LOGIN_REQUIRED", reason: "Conclua a verificação no YouTube" } };
    expect(() => parsePlayer(raw, id)).toThrow("Conclua a verificação");
  });
});

describe("subtitle export", () => {
  test("converts actual cue timing, multiline segments and millisecond boundaries to SRT", () => {
    expect(captionsToSrt({ events: [
      { tStartMs: 0, wpWinPosId: 1 },
      { tStartMs: 1250, dDurationMs: 1750, segs: [{ utf8: "First " }, { utf8: "line\nSecond line" }] },
      { tStartMs: 3_599_900, dDurationMs: 200, segs: [{ utf8: "Hour boundary" }] },
    ] })).toBe("1\n00:00:01,250 --> 00:00:03,000\nFirst line\nSecond line\n\n2\n00:59:59,900 --> 01:00:00,100\nHour boundary\n");
  });
  test("does not save an empty or rejected transcript as a successful subtitle", () => {
    expect(() => captionsToSrt({ events: [] })).toThrow("conteúdo desta legenda");
  });
});

describe("media boundaries", () => {
  test("allows only HTTPS media and caption endpoints", () => {
    expect(mediaUrl("https://rr1.googlevideo.com/videoplayback?sabr=1").hostname).toBe("rr1.googlevideo.com");
    expect(() => mediaUrl("https://rr1.googlevideo.com.evil.test/videoplayback")).toThrow();
    expect(() => mediaUrl("http://rr1.googlevideo.com/videoplayback")).toThrow();
    expect(() => captionUrl("https://example.com/api/timedtext")).toThrow();
    expect(() => captionUrl("https://www.youtube.com/redirect")).toThrow();
  });
  test("keeps unsafe titles inside a single download filename", () => {
    expect(filenameFor('../Bad: title?\u0000', id, "mp4")).toBe(`.._Bad_ title_ [${id}].mp4`);
  });
  test("removes signed URLs from user-facing errors", () => {
    expect(errorMessage(new Error("Failed https://rr1.googlevideo.com/videoplayback?token=secret now")))
      .toBe("Failed [endereço de mídia] now");
  });
});
