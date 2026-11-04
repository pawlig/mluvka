import {
  Application,
  createDecoder,
  createEncoder,
  type OpusDecoderHandle,
  type OpusEncoderHandle,
} from "libopus-wasm";
let encoder: OpusEncoderHandle | undefined,
  decoder: OpusDecoderHandle | undefined;
let expected: number | undefined;
let concealed = 0;
let playPort: MessagePort | undefined;
function output(pcm: Int16Array, plc = false) {
  const rms = Math.sqrt(
    pcm.reduce((sum, x) => sum + (x / 32768) ** 2, 0) / pcm.length,
  );
  if (playPort) {
    playPort.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
    postMessage({ decoded: true, rms, plc });
  } else postMessage({ pcm: pcm.buffer, plc }, { transfer: [pcm.buffer] });
}
function conceal() {
  if (decoder && expected !== undefined) {
    output(decoder.decodePacketLoss(960), true);
    concealed++;
    // Deadline přehrávání není důkaz ztráty na TCP. Pozdější skutečný paket
    // musí obnovit stav dekodéru; nesmí zůstat navždy za posunutým pořadím.
  }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.playPort) {
      playPort?.close();
      playPort = data.playPort;
      playPort!.onmessage = ({ data }) => {
        if (data.plc) conceal();
      };
    }
    if (data.init) {
      encoder?.free();
      decoder?.free();
      encoder = await createEncoder({
        sampleRate: 48000,
        channels: 1,
        frameSize: 960,
        application: Application.Voip,
        bitrate: data.quality === "economy" ? 32000 : 64000,
        complexity: 10,
        vbr: true,
        fec: true,
        packetLossPercent: 10,
        dtx: false,
      });
      decoder = await createDecoder({
        sampleRate: 48000,
        channels: 1,
        maxFrameSize: 960,
      });
      expected = undefined;
      postMessage({ ready: true });
    }
    if (data.quality && !data.init)
      encoder?.setBitrate(data.quality === "economy" ? 32000 : 64000);
    if (data.encode && encoder) {
      const opus = encoder.encode(new Int16Array(data.encode));
      const packet = new Uint8Array(opus.length + 1);
      packet[0] = 3;
      packet.set(opus, 1);
      postMessage({ encoded: packet.buffer }, { transfer: [packet.buffer] });
    }
    if (data.decode && decoder) {
      const packet = new Uint8Array(data.decode);
      const sequence = new DataView(data.decode).getUint32(1, true);
      const delta = expected === undefined ? 0 : (sequence - expected) | 0;
      if (delta < 0) return; // opožděný rámec byl již nahrazen PLC
      // Omezené dohánění: po delším výpadku začíná nová časová základna.
      if (delta > 0) postMessage({ lost: delta });
      for (let n = 0; n < Math.min(Math.max(0, delta - concealed), 10); n++)
        output(decoder.decodePacketLoss(960), true);
      const alreadyPlayed = concealed > delta;
      concealed = Math.max(0, concealed - delta - 1);
      expected = (sequence + 1) >>> 0;
      try {
        const pcm = decoder.decode(packet.subarray(5), { frameSize: 960 });
        // I pozdní paket aktualizuje prediktor. Již přehrané PLC ale nezvětší
        // buffer druhou kopií stejného časového úseku.
        if (!alreadyPlayed) output(pcm);
        else postMessage({ resynced: true });
      } catch {
        if (!alreadyPlayed) output(decoder.decodePacketLoss(960), true);
      }
    }
    if (data.plc) conceal();
    if (data.reset) {
      expected = undefined;
      concealed = 0;
    }
  } catch {
    postMessage({ failed: true });
  }
};
