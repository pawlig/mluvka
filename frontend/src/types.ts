export type Mode = "ptt" | "vad" | "always";
export interface Settings {
  mode: Mode;
  quality: "high" | "economy";
  key: string;
  threshold: number;
  volume: number;
  gain: number;
  microphone: boolean;
  deafen: boolean;
  echo: boolean;
  noise: boolean;
  autoGain: boolean;
  input: string;
  output: string;
  beep: boolean;
  wakeLock: boolean;
  notifyVolume: number;
  notifyChannel: boolean;
  notifyServer: boolean;
  notifyPrivate: boolean;
  notifyPoke: boolean;
  systemNotifications: boolean;
}
export const defaultSettings: Settings = {
  mode: "ptt",
  quality: "high",
  key: "Space",
  threshold: 0.035,
  volume: 1,
  gain: 1,
  microphone: false,
  deafen: false,
  echo: true,
  noise: true,
  autoGain: false,
  input: "",
  output: "",
  beep: true,
  wakeLock: false,
  notifyVolume: 0.7,
  notifyChannel: true,
  notifyServer: true,
  notifyPrivate: true,
  notifyPoke: true,
  systemNotifications: false,
};
export function loadSettings(): Settings {
  const saved = {
    ...defaultSettings,
    ...load<Partial<Settings>>("settings", {}),
  };
  if (load("settingsVersion", 0) < 2) {
    saved.autoGain = false;
    save("settings", saved);
    save("settingsVersion", 2);
  }
  return saved;
}
export interface Channel {
  id: number;
  parent: number;
  order: number;
  name: string;
  password: boolean;
  topic: string | null;
}
export interface Client {
  id: number;
  uid: string | null;
  channel: number;
  name: string;
  microphone: boolean;
  deafen: boolean;
  away: boolean;
  mluvka?: boolean;
  sharing?: boolean;
}
export interface RoomState {
  type: "state";
  name: string;
  self: number;
  channels: Channel[];
  clients: Client[];
}
export interface Peer {
  volume: number;
  muted: boolean;
}
export interface ChatMessage {
  target: string;
  client?: number;
  from: number;
  name: string;
  text: string;
  time: number;
}
export interface Login {
  nickname: string;
  server: string;
  password: string;
  channel: string;
  channel_password: string;
  remember: boolean;
  passwords: boolean;
  auto: boolean;
}
export function load<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`mluvka.${key}`) || "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`mluvka.${key}`, JSON.stringify(value));
  } catch {
    /* Soukromý režim může úložiště zakázat. */
  }
}
declare global {
  interface Window {
    __mluvkaStats: {
      receivedFrames: number;
      sentFrames: number;
      rms: number;
      micRms: number;
      underruns: number;
      droppedFrames: number;
      droppedCaptureFrames: number;
      uid: string;
      sampleRate: number;
      bufferMs: number;
      targetBufferMs: number;
      driftCorrection: number;
      maxJump: number;
      outputRms: number;
      upKbps: number;
      downKbps: number;
      plcFrames: number;
      lostFrames: number;
      codec: "pcm" | "opus";
      notifySounds: number;
      notifyPokes: number;

    };
  }
}
