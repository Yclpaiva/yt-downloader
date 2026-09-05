import { describe, expect, test } from "bun:test";
import {
  decode, encode, filenameFor, qualitiesFrom, sidecarArgs, sidecarPath, subtitlesFrom, videoArgs, videoFormat,
} from "./lib";

describe("framing", () => {
  test("round-trips and splits concatenated frames", () => {
    const bytes = Buffer.concat([encode({ a: 1 }), encode("x"), Buffer.from([9, 0])]);
    const { messages, rest } = decode(bytes);
    expect(messages).toEqual([{ a: 1 }, "x"]);
    expect(rest).toEqual(Buffer.from([9, 0]));
  });

  test("keeps an incomplete frame for later", () => {
    const frame = encode({ long: "message" });
    const { messages, rest } = decode(frame.subarray(0, 6));
    expect(messages).toEqual([]);
    expect(rest.length).toBe(6);
  });
});

describe("metadata", () => {
  test("qualities are distinct heights, best first, audio-only ignored", () => {
    const qualities = qualitiesFrom({
      formats: [
        { height: 720, vcodec: "avc1" }, { height: 1080, vcodec: "vp9" }, { height: 720, vcodec: "vp9" },
        { height: null, vcodec: "none" }, { height: 360, vcodec: "avc1" },
      ],
    });
    expect(qualities).toEqual([1080, 720, 360]);
  });

  test("subtitles list manual first, then auto without duplicates", () => {
    const subs = subtitlesFrom({
      subtitles: { pt: [{ name: "Portuguese" }], en: [{ name: "English" }] },
      automatic_captions: { en: [{ name: "English" }], es: [{ name: "Spanish" }] },
    });
    expect(subs).toEqual([
      { lang: "en", name: "English", auto: false },
      { lang: "pt", name: "Portuguese", auto: false },
      { lang: "es", name: "Spanish", auto: true },
    ]);
  });

  test("filenames strip unsafe characters and carry the id", () => {
    const info = { id: "abc", title: 'A/B: "C"?  D' };
    expect(filenameFor(info, { kind: "video", height: 720 })).toBe("A_B_ _C_ D [abc].mp4");
    expect(filenameFor(info, { kind: "thumbnail" })).toBe("A_B_ _C_ D [abc].jpg");
    expect(filenameFor(info, { kind: "subtitles", lang: "pt", auto: true })).toBe("A_B_ _C_ D [abc].pt.srt");
  });
});

describe("yt-dlp arguments", () => {
  test("video format caps height and prefers h264 mp4", () => {
    expect(videoFormat(720)).toStartWith("bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/");
    expect(videoFormat(null)).toStartWith("bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/");
  });

  test("video streams a fragmented mp4 to stdout", () => {
    const args = videoArgs("u", null);
    expect(args).toContain("-");
    expect(args).toContain("ffmpeg");
    expect(args.join(" ")).toContain("frag_keyframe+empty_moov");
  });

  test("sidecars disable simulate and pick the auto vs manual flag", () => {
    expect(sidecarArgs("u", { kind: "subtitles", lang: "pt", auto: true }, "/o")).toContain("--write-auto-subs");
    expect(sidecarArgs("u", { kind: "subtitles", lang: "pt", auto: false }, "/o")).toContain("--write-subs");
    expect(sidecarArgs("u", { kind: "thumbnail" }, "/o")).toContain("--no-simulate");
  });

  test("derives sidecar paths from the printed filename", () => {
    expect(sidecarPath("/o/media.webm", { kind: "thumbnail" })).toBe("/o/media.jpg");
    expect(sidecarPath("/o/media.mp4", { kind: "subtitles", lang: "pt", auto: false })).toBe("/o/media.pt.srt");
  });
});
