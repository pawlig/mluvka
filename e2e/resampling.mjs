// Spouští skutečný AudioWorklet v izolovaném VM; žádná kopie algoritmu v testu.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { strict as assert } from "node:assert";
export function resamplingChecks(ok = console.log) {
  for (const rate of [16000, 44100, 48000, 96000]) {
    let Processor;
    const frames = [];
    runInNewContext(
      readFileSync(
        new URL("../frontend/public/audio-worklet.js", import.meta.url),
        "utf8",
      ),
      {
        sampleRate: rate,
        AudioWorkletProcessor: class {
          port = {
            postMessage: (data) => {
              if (data.pcm) frames.push(new Int16Array(data.pcm));
            },
          };
        },
        registerProcessor: (_, type) => {
          Processor = type;
        },
      },
    );
    const processor = new Processor();
    const signal = Float32Array.from(
      { length: rate },
      (_, i) => Math.sin((i * 2 * Math.PI * 440) / rate) * 0.4,
    );
    for (let i = 0; i < signal.length; i += 128)
      processor.process(
        [[signal.subarray(i, i + 128)]],
        [[new Float32Array(128)]],
      );
    assert.equal(frames.length, 50, `${rate} → 48000: počet 20ms rámců`);
    assert.ok(frames.every((frame) => frame.length === 960));
    assert.ok(processor.position <= 1, `zbytek vzorků ${processor.position}`);
    // Sledujeme počet zapsaných vzorků ve skutečném kruhovém bufferu.
    const playback = new Processor();
    for (const frame of frames)
      playback.port.onmessage({ data: { pcm: frame.buffer } });
    const length = playback.write;
    assert.ok(Math.abs(length - rate) <= 1, `48000 → ${rate}: délka ${length}`);
    assert.ok(
      Math.max(...frames[10]) > 3000,
      "komprimované audio zůstalo slyšitelné",
    );
    ok(
      `Worklet ${rate} → 48000 → ${rate}: 50 × 960 vzorků, zpět ${length} vzorků`,
    );
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) resamplingChecks();
