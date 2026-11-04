export type Mode = "ptt" | "vad" | "always";
export interface Settings {
  mode: Mode;
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
  key: "Space",
  threshold: 0.035,
  volume: 1,
  gain: 1,
  microphone: false,
  deafen: false,
  echo: true,
  noise: true,
  autoGain: true,
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
      uid: string;
      sampleRate: number;
      notifySounds: number;
      notifyPokes: number;
    };
  }
}
