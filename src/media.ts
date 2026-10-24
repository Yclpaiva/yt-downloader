import {
  ALL_FORMATS, BlobSource, EncodedAudioPacketSource, EncodedPacketSink,
  EncodedVideoPacketSource, Input, Mp4OutputFormat, Output, StreamTarget,
  type StreamTargetChunk,
} from "mediabunny";

/** Remux encoded packets to a seekable disk stream; no decoding or full-file RAM buffer. */
export async function mergeTracks(
  video: Blob,
  audio: Blob,
  writable: WritableStream<StreamTargetChunk>,
  expectedDuration: number,
  signal: AbortSignal,
  onProgress: (seconds: number) => void,
) {
  const videoInput = new Input({ source: new BlobSource(video), formats: ALL_FORMATS });
  const audioInput = new Input({ source: new BlobSource(audio), formats: ALL_FORMATS });
  const output = new Output({
    target: new StreamTarget(writable, { chunked: true, chunkSize: 1024 * 1024 }),
    format: new Mp4OutputFormat({ fastStart: false }),
  });
  try {
    const [videoTrack, audioTrack] = await Promise.all([videoInput.getPrimaryVideoTrack(), audioInput.getPrimaryAudioTrack()]);
    if (!videoTrack?.codec || !audioTrack?.codec) throw new Error("O download não contém as duas trilhas de áudio e vídeo.");
    const [videoConfig, audioConfig] = await Promise.all([videoTrack.getDecoderConfig(), audioTrack.getDecoderConfig()]);
    if (!videoConfig || !audioConfig) throw new Error("Não consegui ler os codecs do vídeo.");
    const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();
    let videoEnd = 0;
    let audioEnd = 0;
    await Promise.all([
      (async () => {
        for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
          signal.throwIfAborted();
          await videoSource.add(packet, { decoderConfig: videoConfig });
          videoEnd = Math.max(videoEnd, packet.timestamp + packet.duration);
          onProgress(Math.min(videoEnd, audioEnd));
        }
        videoSource.close();
      })(),
      (async () => {
        for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
          signal.throwIfAborted();
          await audioSource.add(packet, { decoderConfig: audioConfig });
          audioEnd = Math.max(audioEnd, packet.timestamp + packet.duration);
        }
        audioSource.close();
      })(),
    ]);
    signal.throwIfAborted();
    const tolerance = Math.max(1, Math.min(3, expectedDuration * 0.001));
    if (!videoEnd || !audioEnd || Math.min(videoEnd, audioEnd) + tolerance < expectedDuration) {
      throw new Error("O YouTube interrompeu o vídeo antes do fim. Nenhum arquivo incompleto foi salvo.");
    }
    await output.finalize();
    return { videoDuration: videoEnd, audioDuration: audioEnd };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
}
