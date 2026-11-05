// Výslovný seznam technických údajů. Nikdy nekopírovat celý stav aplikace.
type Sample = { at: number; value: number };
const gaps: Sample[] = [], decodes: Sample[] = [], underruns: number[] = [];
const longTasks: Sample[] = [];
const supportsLongTasks = typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
if (supportsLongTasks) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ at: entry.startTime + entry.duration, value: entry.duration });
    trim(longTasks, performance.now());
  }).observe({ type: "longtask", buffered: true });
}
let lastArrival: number | undefined;
let websocketCompression: boolean | null = null;
export function audioWebsocket(extensions = "") {
  websocketCompression = extensions.split(",").some((v) => v.trim().split(";")[0] === "permessage-deflate");
}
let context: AudioContext | undefined;
let outputRoute: () => string = () => "neaktivní";
function trim(samples: Sample[], now: number) {
  while (samples.length && samples[0].at < now - 30000) samples.shift();
}
export function audioArrival() {
  const now = performance.now();
  if (lastArrival !== undefined) gaps.push({ at: now, value: now - lastArrival });
  lastArrival = now;
  trim(gaps, now);
}
export function resetAudioArrival() {
  lastArrival = undefined;
  gaps.length = decodes.length = 0;
}
export function audioDecoded(ms: number) {
  const now = performance.now();
  if (Number.isFinite(ms)) decodes.push({ at: now, value: ms });
  trim(decodes, now);
}
export function audioUnderrun() { underruns.push(performance.now()); }
export function audioEnvironment(ctx: AudioContext, route: () => string) {
  context = ctx;
  outputRoute = route;
}
export function audioDiagnostics() {
  const now = performance.now(), s = window.__mluvkaStats;
  trim(gaps, now);
  trim(decodes, now);
  trim(longTasks, now);
  while (underruns.length && underruns[0] < now - 60000) underruns.shift();
  const sorted = gaps.map((v) => v.value).sort((a, b) => a - b);
  const round = (v: number | undefined) => v === undefined ? null : Math.round(v * 100) / 100;
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  return {
    schema: 1,
    build: import.meta.env.VITE_BUILD_COMMIT as string,
    capturedAt: new Date().toISOString(),
    codec: s.codec,
    bufferMs: round(s.bufferMs), targetBufferMs: round(s.targetBufferMs),
    underruns: s.underruns, underrunsLastMinute: underruns.length,
    plcFrames: s.plcFrames, lostFrames: s.lostFrames, droppedFrames: s.droppedFrames,
    incomingGapP95Ms: round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0),
    incomingGapMaxMs: round(sorted.at(-1) ?? 0), incomingGapSamples: sorted.length,
    // Histogram platí pro stejné klouzavé okno 30 s jako p95/max.
    incomingGapHistogram: [25, 50, 100, 200, 300, 400, Infinity].map((upper, i, limits) => ({
      upToMs: Number.isFinite(upper) ? upper : null,
      count: sorted.filter((v) => v <= upper && (i === 0 || v > limits[i - 1])).length,
    })),
    mainThreadLongTasks: supportsLongTasks ? longTasks.length : null,
    mainThreadLongTaskMaxMs: supportsLongTasks ? round(longTasks.reduce((m, v) => Math.max(m, v.value), 0)) : null,
    incomingGapWithLongTaskMaxMs: supportsLongTasks ? round(gaps.reduce((m, gap) => Math.max(m,
      longTasks.some((task) => task.at >= gap.at - gap.value && task.at - task.value <= gap.at) ? gap.value : 0), 0)) : null,
    decodeAverageMs: round(decodes.reduce((sum, v) => sum + v.value, 0) / Math.max(1, decodes.length)),
    decodeMaxMs: round(decodes.reduce((max, v) => Math.max(max, v.value), 0)),
    sampleRate: context?.sampleRate ?? null,
    baseLatency: context?.baseLatency ?? null, outputLatency: context?.outputLatency ?? null,
    renderQuantum: s.renderQuantum ?? null,
    outputRoute: outputRoute(),
    websocketCompression,
    contextState: context?.state ?? "neaktivní",
    effectiveType: connection?.effectiveType ?? null,
    userAgent: navigator.userAgent.slice(0, 180),
    upKbps: round(s.upKbps), downKbps: round(s.downKbps),
    driftPercent: round(s.driftCorrection), maxJump: round(s.maxJump),
  };
}
