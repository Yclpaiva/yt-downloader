import { expect, test } from "bun:test";
import { ALL_FORMATS, BlobSource, Input, type StreamTargetChunk } from "mediabunny";
import { mergeTracks } from "./media";

// Two seconds of synthetic color bars and a 440 Hz tone; tests require no native tools.
const fixture = () => Bun.file(new URL("fixtures/av.mp4", import.meta.url));
function destination() {
  const chunks: StreamTargetChunk[] = [];
  let closed = false;
  return {
    stream: new WritableStream<StreamTargetChunk>({
      write(chunk) { chunks.push({ ...chunk, data: chunk.data.slice() }); },
      close() { closed = true; },
    }),
    get closed() { return closed; },
    blob() {
      const size = Math.max(0, ...chunks.map((c) => c.position + c.data.length));
      const bytes = new Uint8Array(size);
      for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
      return new Blob([bytes]);
    },
  };
}

test("browser muxing preserves both encoded tracks and the full duration", async () => {
  const file = fixture();
  const target = destination();
  const durations = await mergeTracks(file, file, target.stream, 2, new AbortController().signal, () => {});
  expect(target.closed).toBe(true);
  expect(durations.videoDuration).toBeCloseTo(2, 1);
  const result = new Input({ source: new BlobSource(target.blob()), formats: ALL_FORMATS });
  try {
    expect((await result.getPrimaryVideoTrack())?.codec).toBe("avc");
    expect((await result.getPrimaryAudioTrack())?.codec).toBe("aac");
    expect(await result.computeDuration()).toBeCloseTo(2, 1);
  } finally { result.dispose(); }
});

test("incomplete tracks cannot be finalized as a successful complete video", async () => {
  const file = fixture();
  await expect(mergeTracks(file, file, destination().stream, 60, new AbortController().signal, () => {}))
    .rejects.toThrow("antes do fim");
});

test("cancellation interrupts packet copying before finalization", async () => {
  const abort = new AbortController();
  abort.abort();
  const file = fixture();
  await expect(mergeTracks(file, file, destination().stream, 2, abort.signal, () => {})).rejects.toThrow();
});
