import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatMessage as MessageBody } from "./ChatMessage";
import { ImageComposer } from "./ImageComposer";
import { useSharing } from "./sdileni/controller";
import { SharingArea, SharingControls, ScreenIcon, MluvkaIcon } from "./sdileni/Sdileni";
import { AudioEngine } from "./audio";
import { Icon } from "./Icon";
import { Vlna } from "./Vlna";
import {
  InviteDialog,
  InvitationDetails,
  PasteInvitation,
  decodeInvitation,
  invitationLogin,
  readInvitation,
} from "./invitations";
import {
  UnreadBadge,
  useNotifications,
  readNotificationTarget,
  type NotificationTarget,
} from "./notifications";

import { Install, useServiceWorker } from "./pwa";
import {
  loadSettings,
  load,
  save,
  type Channel,
  type ChatMessage,
  type Client,
  type Login,
  type Peer,
  type RoomState,
  type Settings,
} from "./types";

const incomingInvitation = readInvitation();
const incomingNotification = readNotificationTarget();

const blankLogin: Login = {
  nickname: "",
  server: "",
  password: "",
  channel: "",
  channel_password: "",
  remember: true,
  passwords: true,
  auto: true,
};
const modeNames = {
  ptt: "Push-to-talk",
  vad: "Hlasová aktivace",
  always: "Pořád zapnuto",
};
type ThreadMessage = ChatMessage & { thread: string };
function initials(name: string) {
  return name.slice(0, 2).toLocaleUpperCase("cs");
}
function Avatar({
  client,
  talking = false,
}: {
  client: Client;
  talking?: boolean;
}) {
  return (
    <span
      className={`avatar ${talking ? "speaking" : ""}`}
      style={
        {
          "--hue": `${[...client.name].reduce((n, c) => n + c.charCodeAt(0), 0) % 360}`,
        } as React.CSSProperties
      }
    >
      {initials(client.name)}
    </span>
  );
}
function Range({
  label,
  value,
  onChange,
  max = 2,
  step = 0.01,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  max?: number;
  step?: number;
  format?: string;
}) {
  return (
    <label className="range-label">
      <span>
        {label}
        <b>{format || `${Math.round(value * 100)} %`}</b>
      </span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function App() {
  const [invitation, setInvitation] = useState(incomingInvitation.invitation);
  const [showInvite, setShowInvite] = useState(false);
  const [showPasteInvite, setShowPasteInvite] = useState(false);
  const [notificationTarget, setNotificationTarget] = useState<
    NotificationTarget | undefined
  >(incomingNotification);
  const [login, setLogin] = useState<Login>(() =>
    incomingInvitation.invitation
      ? invitationLogin(
          incomingInvitation.invitation,
          load<Login>("login", blankLogin).nickname,
        )
      : { ...blankLogin, ...load("login", {}) },
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const [peers, setPeers] = useState<Record<string, Peer>>(() =>
    load("peers", {}),
  );
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">(
    "idle",
  );
  const [room, setRoom] = useState<RoomState>();
  const roomRef = useRef<RoomState | undefined>(undefined);
  const [error, setError] = useState(incomingInvitation.error || "");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [autoStarting, setAutoStarting] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const phase = useRef("idle");
  const wanted = useRef(false);
  const lastLogin = useRef(login);
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const retryCount = useRef(0);
  const retryAfter = useRef(0);
  const restarting = useRef(false);
  const lastMessage = useRef(0);
  const closeStale = useRef<(() => void) | undefined>(undefined);
  const pendingMove = useRef<{ channel: number; password: string } | undefined>(
    undefined,
  );
  const focusField = useRef("");
  const form = useRef<HTMLFormElement>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const sheetStart = useRef<number | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [talking, setTalking] = useState<Set<number>>(new Set());
  const [level, setLevel] = useState(0);
  const [selfTalking, setSelfTalking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  const [identityText, setIdentityText] = useState("");
  const [peerClient, setPeerClient] = useState<Client>();
  const [move, setMove] = useState<Channel>();
  const [movePassword, setMovePassword] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [captureKey, setCaptureKey] = useState(false);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [thread, setThread] = useState("channel");
  const [privateTabs, setPrivateTabs] = useState<Record<number, string>>({});
  const [text, setText] = useState("");
  const [uploadToken, setUploadToken] = useState("");
  const [mobile, setMobile] = useState("channels");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const ws = useRef<WebSocket | undefined>(undefined);
  const sharing = useSharing((data) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(data));
  });
  const peersRef = useRef(peers);
  const settingsRef = useRef(settings);
  const levelTime = useRef(0);
  const chatEnd = useRef<HTMLDivElement>(null);
  const engine = useRef<AudioEngine | undefined>(undefined);
  const peerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const peerSentAt = useRef(0);
  const send = (data: unknown) => {
    if (engine.current?.ready && ws.current?.readyState === WebSocket.OPEN)
      ws.current.send(JSON.stringify(data));
  };
  if (!engine.current)
    engine.current = new AudioEngine(
      settings,
      (rms, active) => {
        if (performance.now() - levelTime.current > 80) {
          levelTime.current = performance.now();
          setLevel(rms);
          setSelfTalking(active);
        }
      },
      (data) => {
        if (
          engine.current?.ready &&
          ws.current?.readyState === WebSocket.OPEN &&
          ws.current.bufferedAmount < 1921 * 5
        ) {
          ws.current.send(data);
          window.__mluvkaStats.sentFrames++;
          engine.current?.recordSent(data.byteLength);
        }
      },
    );
  const audio = engine.current;
  const me = room?.clients.find((c) => c.id === room.self);
  const currentChannel = room?.channels.find((c) => c.id === me?.channel);
  const connected = status === "connected";
  useServiceWorker(status !== "idle" || retryAttempt > 0);
  audio.onBlocked = setAudioBlocked;
  audio.onCodecFailure = () => closeStale.current?.();
  const currentThread =
    thread === "channel" ? `channel:${me?.channel}` : thread;
  const visibleMessages = messages.filter((m) => m.thread === currentThread);

  const notifications = useNotifications(audio, settings, {
    thread: currentThread,
    channel: me?.channel,
    mobile,
    connected,
    server: login.server,
    title: connected
      ? `${room?.name} · ${currentChannel?.name || ""}`
      : undefined,
  });
  // Socket žije déle než render; příjem musí používat aktuální přepínače a konverzaci.
  const receiveNotification = useRef(notifications.receive);
  receiveNotification.current = notifications.receive;
  useEffect(() => {
    const message = (event: MessageEvent) => {
      if (event.data?.type === "OPEN_CONVERSATION")
        setNotificationTarget(event.data.target);
    };
    navigator.serviceWorker?.addEventListener("message", message);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", message);
  }, []);
  useEffect(() => {
    if (!notificationTarget || !connected) return;
    const target = notificationTarget;
    setNotificationTarget(undefined);
    if (target.server !== lastLogin.current.server) {
      setNotice("Upozornění patří jinému serveru. Připojte se na něj ručně.");
      return;
    }
    if (!/^(server|channel:\d+|private:\d+)$/.test(target.thread)) return;
    if (target.thread.startsWith("private:"))
      setPrivateTabs((old) => ({
        ...old,
        [Number(target.thread.split(":")[1])]: target.name,
      }));
    if (target.thread.startsWith("channel:")) {
      const channel = room?.channels.find(
        (c) => c.id === Number(target.thread.split(":")[1]),
      );
      if (channel && channel.id !== me?.channel) join(channel);
    }
    setThread(target.thread.startsWith("channel:") ? "channel" : target.thread);
    setMobile("chat");
  }, [notificationTarget, connected]);
  function acceptInvitation(url: string) {
    try {
      const next = decodeInvitation(url);
      if (
        phase.current !== "idle" &&
        !window.confirm(`Odpojit se a připojit na ${next.name || next.server}?`)
      )
        return;
      if (phase.current !== "idle") disconnect();
      setInvitation(next);
      setLogin(invitationLogin(next, login.nickname));
      setShowPasteInvite(false);
      setError("");
      setNotice("");
    } catch {
      setInvitation(undefined);
      setShowPasteInvite(false);
      setError("Pozvánka je neplatná nebo poškozená. Vyplňte připojení ručně.");
    }
  }
  useEffect(() => {
    const changed = () => {
      if (!location.hash.startsWith("#pozvanka")) return;
      const url = location.href;
      history.replaceState(null, "", location.pathname + location.search);
      acceptInvitation(url);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [login.nickname]);

  async function refreshDevices() {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      /* Seznam je dostupný až po souhlasu s mikrofonem. */
    }
  }
  useEffect(() => {
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    void refreshDevices();
    return () => {
      navigator.mediaDevices?.removeEventListener(
        "devicechange",
        refreshDevices,
      );
      wanted.current = false;
      ++generation.current;
      ws.current?.close();
      clearTimeout(retryTimer.current);
      clearTimeout(longPress.current);
      clearTimeout(peerTimer.current);
      void audio.close();
    };
  }, []);
  useEffect(() => {
    settingsRef.current = settings;
    save("settings", settings);
    void audio
      .update(settings)
      .catch(() =>
        setError(
          "Zvukové zařízení nelze přepnout. Zkontrolujte oprávnění nebo vyberte jiné zařízení.",
        ),
      );
  }, [settings]);
  useEffect(() => {
    send({
      type: "mute",
      microphone: settings.microphone,
      deafen: settings.deafen,
    });
  }, [settings.microphone, settings.deafen]);
  useEffect(() => {
    peersRef.current = peers;
    save("peers", peers);
  }, [peers]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () =>
      document.documentElement.style.setProperty(
        "--app-height",
        `${viewport.height}px`,
      );
    resize();
    viewport.addEventListener("resize", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [messages, thread]);
  useEffect(() => {
    const clear = () => {
      audio.ptt = false;
      setSelfTalking(false);
    };
    const down = (e: KeyboardEvent) => {
      if (captureKey) {
        if (e.code === "Escape") {
          setCaptureKey(false);
          return;
        }
        e.preventDefault();
        setSettings((s) => ({ ...s, key: e.code }));
        setCaptureKey(false);
        return;
      }
      if (
        e.code !== settingsRef.current.key ||
        e.repeat ||
        (e.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      if (settingsRef.current.mode === "ptt") {
        e.preventDefault();
        audio.ptt = true;
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === settingsRef.current.key) clear();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", clear);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", clear);
    };
  }, [captureKey]);

  function updateStatus(next: "idle" | "connecting" | "connected") {
    phase.current = next;
    if (next === "idle") setUploadToken("");
    setStatus(next);
  }
  function persistLogin(value: Login) {
    if (value.remember)
      save("login", {
        ...value,
        password: value.passwords ? value.password : "",
        channel_password: value.passwords ? value.channel_password : "",
      });
    else localStorage.removeItem("mluvka.login");
  }
  useEffect(() => {
    if (!invitation) persistLogin(login);
  }, [login, invitation]);
  function scheduleRetry() {
    if (!wanted.current) return;
    clearTimeout(retryTimer.current);
    const attempt = ++retryCount.current;
    setRetryAttempt(attempt);
    if (document.visibilityState === "hidden") return;
    retryTimer.current = setTimeout(
      () => void openConnection(lastLogin.current),
      Math.max(
        retryAfter.current - Date.now(),
        (restarting.current
          ? [3000, 6000, 12000, 15000]
          : [1000, 2000, 4000, 8000, 15000])[
          Math.min(attempt - 1, restarting.current ? 3 : 4)
        ],
      ),
    );
  }
  function tryNow() {
    if (
      !wanted.current ||
      document.visibilityState === "hidden" ||
      phase.current !== "idle"
    )
      return;
    clearTimeout(retryTimer.current);
    if (Date.now() < retryAfter.current) {
      retryTimer.current = setTimeout(tryNow, retryAfter.current - Date.now());
      return;
    }
    void openConnection(lastLogin.current);
  }
  function connect(e?: FormEvent) {
    e?.preventDefault();
    if (phase.current !== "idle") return;
    wanted.current = true;
    setAutoStarting(false);
    try {
      sessionStorage.removeItem("mluvka.manual-disconnect");
    } catch {
      /* Úložiště může být zakázané. */
    }
    retryCount.current = 0;
    setRetryAttempt(0);
    lastLogin.current = login;
    persistLogin(login);
    void openConnection(login);
  }
  async function openConnection(credentials: Login) {
    if (
      !wanted.current ||
      phase.current !== "idle" ||
      document.visibilityState === "hidden"
    )
      return;
    const token = ++generation.current;
    setUploadToken("");
    audio.ready = false;
    audio.negotiate("pcm");
    audio.ptt = false;
    setError("");
    setNotice("");
    updateStatus("connecting");
    setMessages([]);
    setPrivateTabs({});
    setThread("channel");
    setTalking(new Set());
    setTesting(false);
    audio.test(false);
    // resume() bez gesta může zůstat pending. TS připojení na něj nečeká.
    void audio
      .start()
      .then(refreshDevices)
      .catch(() => {
        if (token === generation.current && wanted.current)
          setError(
            "Mikrofon není dostupný. Povolte přístup nebo ho zapněte klepnutím na zvuk.",
          );
      });
    await audio.prepareTransport();
    if (token !== generation.current || !wanted.current) return;
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    ws.current = socket;
    socket.binaryType = "arraybuffer";
    lastMessage.current = Date.now();
    const opened = Date.now();
    let lastPing = 0;
    let lastHeartbeat = Date.now();
    const heartbeat = setInterval(() => {
      if (ws.current !== socket) return;
      const now = Date.now();
      // Pozastavené JS nemohlo převzít čekající WS události. Po probuzení jim
      // necháme celý heartbeat interval, místo okamžitého zrušení živého hovoru.
      if (now - lastHeartbeat > 5000) lastMessage.current = now;
      lastHeartbeat = now;
      if (
        socket.readyState === WebSocket.OPEN &&
        phase.current === "connected" &&
        Date.now() - lastPing >= 10000
      ) {
        socket.send(JSON.stringify({ type: "ping" }));
        lastPing = Date.now();
      }
      if (
        Date.now() - lastMessage.current >= 20000 ||
        (phase.current === "connecting" && Date.now() - opened > 40000)
      ) {
        socket.close();
        // close event při mrtvé síti nemusí dorazit; relaci zneplatníme hned.
        closed();
      }
    }, 1000);
    socket.onopen = () => {
      if (ws.current !== socket) return;
      socket.send(
        JSON.stringify({
          type: "connect",
          ...credentials,
          identity: load<string | null>("identity", null),
          audio: audio.transportOffer(),
        }),
      );
    };
    socket.onmessage = ({ data }) => {
      if (ws.current !== socket) return;
      lastMessage.current = Date.now();
      if (data instanceof ArrayBuffer) {
        audio.receive(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        setError("Server poslal neplatnou odpověď.");
        socket.close();
        return;
      }
      sharing.controller.receive(msg);
      if (msg.type === "hello") audio.negotiate(msg.audio?.codec);
      if (msg.type === "upload_token") setUploadToken(msg.token);

      if (msg.type === "identity") {
        save("identity", msg.identity);
        window.__mluvkaStats.uid = msg.uid;
      }
      if (msg.type === "error") {
        setError(msg.message);
        if (msg.code === "flood") retryAfter.current = Date.now() + 120000;
        if (
          msg.fatal !== false &&
          ["bad_password", "banned", "not_allowed", "invalid"].includes(
            msg.code,
          )
        ) {
          wanted.current = false;
          clearTimeout(retryTimer.current);
          setRetryAttempt(0);
          focusField.current = [
            "password",
            "channel_password",
            "nickname",
            "server",
          ].includes(msg.field)
            ? msg.field
            : "server";
        }
        if (msg.fatal === false) pendingMove.current = undefined;
      }
      if (msg.type === "notice") {
        setNotice(msg.message);
        if (msg.code === "server_restart") {
          restarting.current = true;
          retryCount.current = 0;
          retryAfter.current = Math.max(retryAfter.current, Date.now() + 3000);
          setError("");
        }
        if (msg.code === "session_replaced") {
          wanted.current = false;
          clearTimeout(retryTimer.current);
          setRetryAttempt(0);
        }
      }
      if (msg.type === "state") {
        restarting.current = false;
        retryAfter.current = 0;
        audio.ready = true;
        const next = msg as RoomState;
        const prev = roomRef.current;
        if (prev) {
          const prevMe = prev.clients.find((c) => c.id === prev.self);
          const nextMe = next.clients.find((c) => c.id === next.self);
          if (prevMe?.channel === nextMe?.channel) {
            const before = prev.clients
              .filter(
                (c) => c.channel === prevMe?.channel && c.id !== prev.self,
              )
              .map((c) => c.id);
            const after = next.clients
              .filter(
                (c) => c.channel === nextMe?.channel && c.id !== next.self,
              )
              .map((c) => c.id);
            if (after.some((id) => !before.includes(id))) audio.beep(true);
            if (before.some((id) => !after.includes(id))) audio.beep(false);
          }
        } else {
          send({
            type: "mute",
            microphone: settingsRef.current.microphone,
            deafen: settingsRef.current.deafen,
          });
          for (const [uid, p] of Object.entries(peersRef.current))
            send({ type: "peer", uid, ...p });
        }
        const self = next.clients.find((c) => c.id === next.self);
        const previousChannel = prev?.clients.find(
          (c) => c.id === prev.self,
        )?.channel;
        if (self && (!prev || previousChannel !== self.channel)) {
          const path: string[] = [];
          let id = self.channel;
          const seen = new Set<number>();
          while (id && !seen.has(id)) {
            seen.add(id);
            const channel = next.channels.find((c) => c.id === id);
            if (!channel) break;
            path.unshift(channel.name);
            id = channel.parent;
          }
          const channelPath = path.join("/");
          const password =
            pendingMove.current?.channel === self.channel
              ? pendingMove.current.password
              : channelPath === credentials.channel
                ? credentials.channel_password
                : channelPath === lastLogin.current.channel
                  ? lastLogin.current.channel_password
                  : "";
          lastLogin.current = {
            ...lastLogin.current,
            channel: channelPath,
            channel_password: password,
          };
          setLogin(lastLogin.current);
          persistLogin(lastLogin.current);
          pendingMove.current = undefined;
        }
        roomRef.current = next;
        setRoom(next);
        updateStatus("connected");
        setInvitation(undefined);
        retryCount.current = 0;
        setRetryAttempt(0);
        setError("");
        audio.checkState();
      }
      if (msg.type === "talking")
        setTalking((old) => {
          const next = new Set(old);
          if (msg.active) next.add(msg.client);
          else next.delete(msg.client);
          return next;
        });
      if (msg.type === "poke") {
        setNotice(`Šťouchnutí od ${msg.name}: ${msg.text}`);
        if (msg.from !== roomRef.current?.self)
          receiveNotification.current(
            "poke",
            {
              thread: `private:${msg.from}`,
              name: msg.name,
              server: credentials.server,
            },
            msg.text,
          );
      }
      if (msg.type === "chat") {
        const self = roomRef.current?.self;
        const peer = msg.from === self ? msg.client : msg.from;
        const key =
          msg.target === "private"
            ? `private:${peer}`
            : msg.target === "channel"
              ? `channel:${roomRef.current?.clients.find((c) => c.id === self)?.channel}`
              : "server";
        if (msg.from !== self)
          receiveNotification.current(
            msg.target,
            {
              thread: key,
              name: msg.name,
              server: credentials.server,
            },
            msg.text,
            msg.target === "channel"
              ? roomRef.current?.channels.find(
                  (c) =>
                    c.id ===
                    roomRef.current?.clients.find((c) => c.id === self)
                      ?.channel,
                )?.name
              : msg.target === "server"
                ? roomRef.current?.name
                : undefined,
          );
        if (msg.target === "private")
          setPrivateTabs((old) => ({
            ...old,
            [peer]:
              msg.from === self ? old[peer] || "Soukromá zpráva" : msg.name,
          }));
        setMessages((old) => {
          if (
            msg.from === self &&
            old.some(
              (m) =>
                m.from === self &&
                m.text === msg.text &&
                m.thread === key &&
                Date.now() - m.time < 3000,
            )
          )
            return old;
          return [
            ...old.slice(-499),
            { ...msg, thread: key, time: Date.now() },
          ];
        });
      }
    };
    socket.onerror = () => {
      /* onclose řídí opakování; neduplikuje chyby konzole. */
    };
    function closed() {
      clearInterval(heartbeat);
      if (ws.current !== socket) return;
      sharing.controller.disconnected();
      ws.current = undefined;
      audio.ready = false;
      audio.ptt = false;
      audio.node?.port.postMessage({ flush: true });
      updateStatus("idle");
      setRoom(undefined);
      roomRef.current = undefined;
      setSelfTalking(false);
      if (wanted.current) scheduleRetry();
      else {
        setAutoStarting(false);
        void audio.close();
        if (focusField.current)
          setTimeout(() => {
            const field = form.current?.querySelector<HTMLInputElement>(
              `[name="${focusField.current}"]`,
            );
            let parent = field?.parentElement;
            while (parent && parent !== form.current) {
              if (parent instanceof HTMLDetailsElement) parent.open = true;
              parent = parent.parentElement;
            }
            field?.focus();
          }, 0);
      }
    }
    socket.onclose = closed;
    closeStale.current = () => {
      socket.close();
      closed();
    };
  }
  function disconnect() {
    sharing.controller.disconnected(true);
    wanted.current = false;
    setAutoStarting(false);
    ++generation.current;
    clearTimeout(retryTimer.current);
    retryCount.current = 0;
    setRetryAttempt(0);
    try {
      sessionStorage.setItem("mluvka.manual-disconnect", "1");
    } catch {
      /* Úložiště může být zakázané. */
    }
    send({ type: "disconnect" });
    const socket = ws.current;
    ws.current = undefined;
    socket?.close();
    audio.ready = false;
    void audio.close();
    updateStatus("idle");
    setRoom(undefined);
    roomRef.current = undefined;
    setSelfTalking(false);
    setNotice("Byli jste odpojeni. Můžete se připojit znovu.");
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      let suppressed = false;
      try {
        suppressed = sessionStorage.getItem("mluvka.manual-disconnect") === "1";
      } catch {
        /* Bez úložiště. */
      }
      if (
        !incomingInvitation.invitation &&
        !incomingInvitation.error &&
        login.remember &&
        login.auto &&
        login.server &&
        login.nickname &&
        !suppressed
      ) {
        wanted.current = true;
        setAutoStarting(true);
        void openConnection(login);
      }
    }, 0);
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      void audio.recover();
      if (
        wanted.current &&
        ws.current &&
        Date.now() - lastMessage.current >= 20000
      ) {
        closeStale.current?.();
      }
      tryNow();
    };
    const online = () => {
      if (!wanted.current) return;
      if (ws.current) closeStale.current?.();
      tryNow();
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", online);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", online);
    };
  }, []);
  useEffect(() => {
    if (!("mediaSession" in navigator) || !connected) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Mluvka — ${currentChannel?.name || "kanál"}`,
      artist: "Mluvka",
      artwork: [{ src: "/icons/512.png", sizes: "512x512", type: "image/png" }],
    });
    navigator.mediaSession.playbackState = settings.microphone
      ? "paused"
      : "playing";
    navigator.mediaSession.setActionHandler("play", () =>
      change("microphone", false),
    );
    navigator.mediaSession.setActionHandler("pause", () =>
      change("microphone", true),
    );
    return () => {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    };
  }, [connected, currentChannel?.name, settings.microphone]);
  useEffect(() => {
    if (!settings.wakeLock || !connected || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | undefined;
    let disposed = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || (lock && !lock.released))
        return;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (disposed) await next.release();
        else lock = next;
      } catch {
        setNotice(
          "Displej nelze udržet zapnutý. Zkontrolujte úsporný režim zařízení.",
        );
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      void lock?.release();
      document.removeEventListener("visibilitychange", acquire);
    };
  }, [connected, settings.wakeLock]);
  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }
  function peerChange(client: Client, patch: Partial<Peer>) {
    if (!client.uid) return;
    const pref = {
      ...(peers[client.uid] || { volume: 1, muted: false }),
      ...patch,
    };
    setPeers((old) => ({ ...old, [client.uid!]: pref }));
    // Posuvník může generovat desítky událostí/s; síťové změny slučujeme.
    clearTimeout(peerTimer.current);
    const transmit = () => {
      peerSentAt.current = Date.now();
      send({ type: "peer", uid: client.uid, ...pref });
    };
    const elapsed = Date.now() - peerSentAt.current;
    if (patch.muted !== undefined || elapsed >= 100) transmit();
    else peerTimer.current = setTimeout(transmit, 100 - elapsed);
  }
  function join(channel: Channel) {
    if (channel.id === me?.channel) return;
    if (channel.password) {
      setMove(channel);
      setMovePassword("");
    } else moveTo(channel.id, "");
  }
  function moveTo(channel: number, password: string) {
    pendingMove.current = { channel, password };
    send({ type: "move", channel, password });
  }
  function stopLongPress() {
    clearTimeout(longPress.current);
  }
  function sendChat(text: string) {
    if (!text.trim() || !me) return;
    const privateId = thread.startsWith("private:")
      ? Number(thread.split(":")[1])
      : undefined;
    send({
      type: "chat",
      target: privateId ? "private" : thread,
      client: privateId,
      text,
    });
    setMessages((old) => [
      ...old.slice(-499),
      {
        target: thread,
        thread: currentThread,
        from: me.id,
        name: me.name,
        text,
        time: Date.now(),
      },
    ]);
    setText("");
  }
  async function toggleTest() {
    try {
      if (!audio.context) await audio.start();
      audio.test(!testing);
      setTesting(!testing);
      await refreshDevices();
    } catch {
      setError("Test mikrofonu nelze spustit. Povolte mikrofon v prohlížeči.");
    }
  }
  function sortedChannels(parent: number): Channel[] {
    const siblings = room?.channels.filter((c) => c.parent === parent) || [];
    const result: Channel[] = [];
    let previous = 0;
    while (result.length < siblings.length) {
      const next =
        siblings.find((c) => c.order === previous && !result.includes(c)) ||
        siblings.find((c) => !result.includes(c));
      if (!next) break;
      result.push(next);
      previous = next.id;
    }
    return result;
  }
  function renderChannels(
    parent = 0,
    depth = 0,
    seen = new Set<number>(),
  ): React.ReactNode {
    if (depth > 30) return null;
    return sortedChannels(parent).map((c) => {
      if (seen.has(c.id)) return null;
      const nextSeen = new Set(seen).add(c.id);
      const members =
        room?.clients
          .filter((p) => p.channel === c.id)
          .sort((a, b) => a.name.localeCompare(b.name, "cs")) || [];
      const children = room?.channels.some((ch) => ch.parent === c.id);
      return (
        <div key={c.id} className="channel-group">
          <div
            className={`channel-row ${c.id === me?.channel ? "current" : ""}`}
            style={{ paddingLeft: 14 + depth * 15 }}
          >
            <button
              className="collapse"
              aria-label={`${collapsed.has(c.id) ? "Rozbalit" : "Sbalit"} ${c.name}`}
              onClick={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (next.has(c.id)) next.delete(c.id);
                  else next.add(c.id);
                  return next;
                })
              }
            >
              <span className={collapsed.has(c.id) ? "" : "expanded"}>
                <Icon name="chevron" size={12} />
              </span>
            </button>
            <button
              className="channel-button"
              data-channel={c.id}
              title="Dvojklikem vstoupíte do kanálu"
              onDoubleClick={() => join(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter") join(c);
              }}
            >
              <Icon name="channel" size={18} />
              <span>{c.name}</span>
              {c.password && <Icon name="lock" size={13} />}
              <small>{members.length}</small>
            </button>
            <button
              className="join-channel"
              aria-label={`Vstoupit do ${c.name}`}
              onClick={() => join(c)}
            >
              <Icon name="chevron" size={14} />
            </button>
          </div>
          {!collapsed.has(c.id) && (
            <>
              <div className="members" style={{ paddingLeft: 33 + depth * 15 }}>
                {members.map((p) => (
                  <button
                    key={p.id}
                    data-client={p.id}
                    className={`client-row ${(p.id === me?.id ? selfTalking : talking.has(p.id)) ? "talking" : ""}`}
                    onPointerDown={(e) => {
                      if (e.pointerType === "mouse") return;
                      touchStart.current = { x: e.clientX, y: e.clientY };
                      stopLongPress();
                      longPress.current = setTimeout(
                        () => setPeerClient(p),
                        500,
                      );
                    }}
                    onPointerMove={(e) => {
                      const start = touchStart.current;
                      if (
                        start &&
                        Math.hypot(e.clientX - start.x, e.clientY - start.y) >
                          10
                      )
                        stopLongPress();
                    }}
                    onPointerUp={stopLongPress}
                    onPointerCancel={stopLongPress}
                    onLostPointerCapture={stopLongPress}
                    onClick={() => setPeerClient(p)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setPeerClient(p);
                    }}
                  >
                    <Avatar
                      client={p}
                      talking={
                        p.id === me?.id ? selfTalking : talking.has(p.id)
                      }
                    />
                    <span className="client-name">
                      {p.name}
                      {p.id === room?.self && <small> vy</small>}
                    </span>
                    <span className="client-icons">
                      {sharing.state.clients.some(c => c.client === p.id && c.uid === p.uid && c.sharing) && <span className="share-tree-icon" title="Sdílí obrazovku" onClick={(event) => {
                        const share = sharing.state.shares.find(s => s.client === p.id && s.uid === p.uid && s.session !== sharing.state.self);
                        if (share) {
                          event.stopPropagation();
                          sharing.controller.watch(share);
                          setMobile("chat");
                        }
                      }}><ScreenIcon /></span>}
                      {sharing.state.clients.some(c => c.client === p.id && c.uid === p.uid) && <span title="Připojen přes Mluvku"><MluvkaIcon /></span>}
                      {p.microphone && <Icon name="micOff" size={14} />}{" "}
                      {p.deafen && <Icon name="deaf" size={14} />}{" "}
                      {p.away && <Icon name="moon" size={14} />}{" "}
                      {p.uid && peers[p.uid]?.muted && (
                        <span className="local-muted" title="Lokálně ztlumen">
                          M
                        </span>
                      )}
                      <span className="talk-dot" title="Mluví" />
                    </span>
                  </button>
                ))}
              </div>
              {children && renderChannels(c.id, depth + 1, nextSeen)}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <div className={`app ${connected ? "in-room" : ""}`}>
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <Icon name="wave" size={25} />
          </span>
          mluvka<span className="brand-dot">.</span>
        </a>
        <div className={`connection-status ${connected ? "online" : ""}`}>
          <i />
          {connected
            ? "Připojeno"
            : status === "connecting"
              ? "Připojuji…"
              : "Připraveno k hovoru"}
        </div>
      </header>
      {retryAttempt > 0 && (
        <div className="reconnect-banner" role="status">
          <span>
            {restarting.current
              ? "Mluvka se aktualizuje — připojuji znovu…"
              : `Spojení ztraceno — připojuji znovu (pokus ${retryAttempt})…`}
          </span>
          <button className="secondary" onClick={tryNow}>
            Zkusit hned
          </button>
          <button className="secondary" onClick={disconnect}>
            Zrušit
          </button>
        </div>
      )}
      {(error || notice) && (
        <div
          className={`toast ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <Icon name="info" />
          <span>{error || notice}</span>
          <button
            aria-label="Zavřít upozornění"
            onClick={() => {
              setError("");
              setNotice("");
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {!connected ? (
        <main className="login-layout">
          <Vlna />
          <section className="login-card" aria-label="Připojení k serveru">
            {status === "connecting" && (
              <div className="connecting-card" role="status">
                <p>
                  Připojuji k {lastLogin.current.server} jako{" "}
                  {lastLogin.current.nickname}…
                </p>
                <button className="secondary" onClick={disconnect}>
                  Zrušit
                </button>
              </div>
            )}
            {invitation && (
              <div className="invitation-heading">
                <div className="eyebrow">MÁŠ MÍSTO U NÁS</div>
                <h1>Pozvánka na {invitation.name || invitation.server}</h1>
                {invitation.channel && <p>Kanál: {invitation.channel}</p>}
              </div>
            )}
            <form
              className={invitation ? "invitation-form" : undefined}
              ref={form}
              hidden={autoStarting && status === "connecting"}
              onSubmit={connect}
              aria-busy={status === "connecting"}
            >
              <label>
                Přezdívka
                <input
                  name="nickname"
                  autoComplete="nickname"
                  required
                  maxLength={30}
                  placeholder="Přezdívka"
                  value={login.nickname}
                  onChange={(e) =>
                    setLogin({ ...login, nickname: e.target.value })
                  }
                />
              </label>
              <InvitationDetails active={!!invitation}>
                <label>
                  Adresa serveru
                  <input
                    name="server"
                    required
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="ts.example.cz:9987"
                    value={login.server}
                    onChange={(e) =>
                      setLogin({ ...login, server: e.target.value })
                    }
                  />
                </label>
                <label>
                  Heslo serveru <span className="optional">volitelné</span>
                  <input
                    name="password"
                    type="password"
                    autoComplete="off"
                    value={login.password}
                    onChange={(e) =>
                      setLogin({ ...login, password: e.target.value })
                    }
                    placeholder="Pokud server heslo vyžaduje"
                  />
                </label>
                <details>
                  <summary>
                    Výchozí kanál <span>volitelné</span>
                  </summary>
                  <div className="advanced-fields">
                    <label>
                      Název nebo cesta kanálu
                      <input
                        value={login.channel}
                        onChange={(e) =>
                          setLogin({ ...login, channel: e.target.value })
                        }
                        placeholder="Parta / Večer"
                      />
                    </label>
                    <label>
                      Heslo kanálu
                      <input
                        name="channel_password"
                        type="password"
                        autoComplete="off"
                        value={login.channel_password}
                        onChange={(e) =>
                          setLogin({
                            ...login,
                            channel_password: e.target.value,
                          })
                        }
                      />
                    </label>
                  </div>
                </details>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={login.remember}
                    onChange={(e) =>
                      setLogin({
                        ...login,
                        remember: e.target.checked,
                        auto: e.target.checked && login.auto,
                        passwords: e.target.checked && login.passwords,
                      })
                    }
                  />
                  Zapamatovat připojení
                </label>
                {login.remember && (
                  <label className="check subtle">
                    <input
                      type="checkbox"
                      checked={login.passwords}
                      onChange={(e) =>
                        setLogin({ ...login, passwords: e.target.checked })
                      }
                    />
                    Zapamatovat i hesla na tomto zařízení
                  </label>
                )}
                {login.remember && (
                  <label className="check subtle">
                    <input
                      type="checkbox"
                      checked={login.auto}
                      onChange={(e) =>
                        setLogin({ ...login, auto: e.target.checked })
                      }
                    />
                    Připojit automaticky po spuštění
                  </label>
                )}
              </InvitationDetails>
              <button
                className="primary connect-button"
                disabled={status === "connecting"}
                type="submit"
              >
                {status === "connecting"
                  ? "Navazuji spojení…"
                  : invitation
                    ? "Připojit"
                    : load<Login | null>("login", null)?.server
                      ? "Připojit se znovu"
                      : "Připojit se"}
                <Icon name="chevron" size={19} />
              </button>
              {status === "connecting" && (
                <div
                  className="voice-controls"
                  role="group"
                  aria-label="Zvuk při připojování"
                >
                  <button
                    type="button"
                    className="control-button"
                    aria-label="Ztlumit mikrofon"
                    aria-pressed={settings.microphone}
                    onClick={() => change("microphone", !settings.microphone)}
                  >
                    <Icon name={settings.microphone ? "micOff" : "mic"} />
                    <span>Mikrofon</span>
                  </button>
                  <button
                    type="button"
                    className="control-button"
                    aria-label="Ztlumit zvuk"
                    aria-pressed={settings.deafen}
                    onClick={() => change("deafen", !settings.deafen)}
                  >
                    <Icon name={settings.deafen ? "deaf" : "headphones"} />
                    <span>Zvuk</span>
                  </button>
                </div>
              )}
            </form>
            {invitation &&
              (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === "MacIntel" &&
                  navigator.maxTouchPoints > 1)) &&
              !matchMedia("(display-mode: standalone)").matches &&
              !(navigator as Navigator & { standalone?: boolean })
                .standalone && (
                <p className="help">
                  Chceš Mluvku jako aplikaci? Nejdřív se připoj, pak Sdílet →
                  Přidat na plochu. V aplikaci zvol „Vložit pozvánku“ a vlož
                  stejný odkaz.
                </p>
              )}
            <Install />
            {!invitation && (
              <div className="login-tools">
                <button onClick={() => setShowPasteInvite(true)}>
                  Vložit pozvánku
                </button>
                <button onClick={() => setShowSettings(true)}>
                  <Icon name="settings" size={15} />
                  Nastavení zvuku
                </button>
                <button
                  onClick={() => {
                    setIdentityText(load("identity", ""));
                    setShowIdentity(true);
                  }}
                >
                  <Icon name="user" size={15} />
                  Identita
                </button>
              </div>
            )}
          </section>
        </main>
      ) : (
        <>
          <nav className="mobile-tabs" aria-label="Hlavní zobrazení">
            <button
              className={mobile === "channels" ? "active" : ""}
              onClick={() => setMobile("channels")}
            >
              <Icon name="channel" />
              Kanály
            </button>
            <button
              className={mobile === "chat" ? "active" : ""}
              onClick={() => setMobile("chat")}
            >
              <Icon name="chat" />
              Chat{" "}
              <UnreadBadge
                count={mobile === "channels" ? notifications.total : 0}
              />
            </button>
          </nav>
          <main className={`workspace mobile-${mobile}`}>
            <aside className="channel-panel">
              <div className="server-heading">
                <span className="server-symbol">
                  <Icon name="server" size={22} />
                </span>
                <div>
                  <h2>{room?.name}</h2>
                  <p>
                    <i />
                    {room?.clients.length} online
                  </p>
                </div>
              </div>
              <div className="invite-actions">
                <button
                  className="secondary"
                  onClick={() => setShowInvite(true)}
                >
                  Pozvat
                </button>
                <button
                  className="text-button"
                  onClick={() => setShowPasteInvite(true)}
                >
                  Vložit pozvánku
                </button>
              </div>
              <div className="panel-label">
                KANÁLY<span>{room?.channels.length}</span>
              </div>
              <div className="channel-tree">{renderChannels()}</div>
              <div className="channel-hint">
                <Icon name="info" size={15} />
                <span>
                  Dvojklikem přejdete do kanálu.
                  <br />
                  Kliknutím na člověka upravíte hlasitost.
                </span>
              </div>
            </aside>
            <section className="chat-panel">
              <header className="room-heading">
                <div className="room-title">
                  <span className="room-hash">
                    <Icon name="channel" size={28} />
                  </span>
                  <div>
                    <h1>{currentChannel?.name || "Připojuji kanály…"}</h1>
                    <p>
                      {currentChannel?.topic ||
                        "Tady jste na správné frekvenci."}
                    </p>
                  </div>
                </div>
                <span className="member-count">
                  <Icon name="user" size={16} />
                  {
                    room?.clients.filter((c) => c.channel === me?.channel)
                      .length
                  }
                </span>
              </header>
              <SharingArea controller={sharing.controller} output={settings.output} />
              <nav className="chat-tabs" aria-label="Chat">
                <button
                  className={thread === "channel" ? "active" : ""}
                  onClick={() => setThread("channel")}
                >
                  <Icon name="chat" size={16} />
                  Kanál{" "}
                  <UnreadBadge
                    count={
                      notifications.unread[
                        currentThread.startsWith("channel:")
                          ? currentThread
                          : `channel:${me?.channel}`
                      ]
                    }
                  />
                </button>
                <button
                  className={thread === "server" ? "active" : ""}
                  onClick={() => setThread("server")}
                >
                  Server <UnreadBadge count={notifications.unread.server} />
                </button>
                {Object.entries(privateTabs).map(([id, name]) => (
                  <div
                    className="private-tab"
                    key={id}
                    data-active={thread === `private:${id}`}
                  >
                    <button onClick={() => setThread(`private:${id}`)}>
                      {name}{" "}
                      <UnreadBadge
                        count={notifications.unread[`private:${id}`]}
                      />
                    </button>
                    <button
                      aria-label={`Zavřít chat ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPrivateTabs((old) => {
                          const next = { ...old };
                          delete next[Number(id)];
                          return next;
                        });
                        notifications.forget(`private:${id}`);
                        setThread("channel");
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </nav>
              <div className="messages" role="log" aria-label="Zprávy">
                <div className="chat-welcome">
                  <span className="welcome-icon">
                    <Icon
                      name={thread === "channel" ? "wave" : "chat"}
                      size={34}
                    />
                  </span>
                  <div className="eyebrow">JSTE TU. OSTATNÍ VÁS USLYŠÍ.</div>
                  <h2>
                    {thread === "channel"
                      ? `Vítejte v kanálu ${currentChannel?.name || "Mluvky"}.`
                      : thread === "server"
                        ? "Zpráva pro celý server."
                        : `Rozhovor s ${privateTabs[Number(thread.split(":")[1])] || "kamarádem"}.`}
                  </h2>
                  <p>
                    {thread === "channel"
                      ? "Zapněte mikrofon, nebo napište první zprávu."
                      : "Tady začíná váš rozhovor."}
                  </p>
                </div>
                <div className="date-divider">
                  <span>DNES</span>
                </div>
                {visibleMessages.map((m, i) => (
                  <article className="message" key={i}>
                    <span className="avatar message-avatar">
                      {initials(m.name)}
                    </span>
                    <div>
                      <div className="message-meta">
                        <strong>{m.name}</strong>
                        {m.from === me?.id && <small>vy</small>}
                        <time>
                          {new Date(m.time).toLocaleTimeString("cs", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <MessageBody text={m.text} />
                    </div>
                  </article>
                ))}
                <div ref={chatEnd} />
              </div>
              <ImageComposer
                text={text}
                setText={setText}
                send={sendChat}
                token={uploadToken}
                active={connected}
                thread={currentThread}
              />
            </section>
          </main>
          <footer className="voice-bar">
            <SharingControls controller={sharing.controller} />
            <div className="self-card">
              {me && <Avatar client={me} talking={selfTalking} />}
              <div>
                <strong>{me?.name || login.nickname}</strong>
                <span className={selfTalking ? "transmitting" : ""}>
                  {testing
                    ? "Test mikrofonu · jen vy"
                    : settings.deafen
                      ? "Zvuk ztlumen"
                      : settings.microphone
                        ? "Mikrofon ztlumen"
                        : selfTalking
                          ? "Právě vysíláte"
                          : "Jste v kanálu"}
                </span>
              </div>
              <div className="mini-meter" aria-label="Úroveň mikrofonu">
                <i style={{ height: `${Math.min(100, level * 400)}%` }} />
              </div>
            </div>
            <div className="voice-controls">
              <button
                className={`control-button ${settings.microphone ? "muted-button" : ""}`}
                title="Ztlumit mikrofon"
                aria-label="Ztlumit mikrofon"
                aria-pressed={settings.microphone}
                onClick={() => change("microphone", !settings.microphone)}
              >
                <Icon name={settings.microphone ? "micOff" : "mic"} />
                <span>Mikrofon</span>
              </button>
              <button
                className={`control-button ${settings.deafen ? "muted-button" : ""}`}
                title="Ztlumit zvuk"
                aria-label="Ztlumit zvuk"
                aria-pressed={settings.deafen}
                onClick={() => change("deafen", !settings.deafen)}
              >
                <Icon name={settings.deafen ? "deaf" : "headphones"} />
                <span>Zvuk</span>
              </button>
              <span className="bar-separator" />
              <label className="mode-select">
                <small>VYSÍLÁNÍ</small>
                <select
                  aria-label="Režim vysílání"
                  value={settings.mode}
                  onChange={(e) =>
                    change("mode", e.target.value as Settings["mode"])
                  }
                >
                  {Object.entries(modeNames).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="bar-actions">
              <button
                className="control-button"
                aria-label="Nastavení"
                onClick={() => setShowSettings(true)}
              >
                <Icon name="settings" />
                <span>Nastavení</span>
              </button>
              <button
                className="disconnect control-button"
                onClick={disconnect}
              >
                <Icon name="leave" />
                <span>Odpojit</span>
              </button>
            </div>
            {settings.mode === "ptt" && (
              <button
                className={`ptt-button ${selfTalking ? "held" : ""}`}
                disabled={settings.microphone || settings.deafen || testing}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  audio.ptt = true;
                  navigator.vibrate?.(10);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onPointerUp={() => (audio.ptt = false)}
                onPointerCancel={() => (audio.ptt = false)}
                onLostPointerCapture={() => (audio.ptt = false)}
              >
                <Icon name="mic" />
                <span>Drž a mluv</span>
                <kbd>
                  {settings.key === "Space" ? "MEZERNÍK" : settings.key}
                </kbd>
              </button>
            )}
          </footer>
        </>
      )}

      {connected && audioBlocked && (
        <div
          className="audio-unlock"
          role="dialog"
          aria-modal="true"
          aria-label="Zapnutí zvuku"
        >
          <button
            className="primary"
            onClick={() => {
              void audio.recover(true);
            }}
          >
            Klepni pro zapnutí zvuku
          </button>
          <p>Spojení běží. Zvuk potřebuje vaše klepnutí.</p>
        </div>
      )}
      {showSettings && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setShowSettings(false);
            setCaptureKey(false);
          }}
        >
          <section
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Nastavení zvuku"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <div className="eyebrow">VAŠE FREKVENCE</div>
                <h2>Nastavení zvuku</h2>
              </div>
              <button
                aria-label="Zavřít nastavení"
                onClick={() => {
                  setShowSettings(false);
                  setCaptureKey(false);
                }}
              >
                <Icon name="close" />
              </button>
            </header>
            <div className="settings-body">
              <h3>Vysílání</h3>
              <label>
                Režim vysílání
                <select
                  value={settings.mode}
                  onChange={(e) =>
                    change("mode", e.target.value as Settings["mode"])
                  }
                >
                  {Object.entries(modeNames).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              {settings.mode === "ptt" && (
                <div className="key-setting">
                  <span>Klávesa pro mluvení</span>
                  <button
                    className="secondary"
                    onClick={() => setCaptureKey(true)}
                  >
                    {captureKey
                      ? "Stiskněte klávesu… (Esc zruší)"
                      : settings.key === "Space"
                        ? "Mezerník"
                        : settings.key}
                  </button>
                </div>
              )}
              {settings.mode === "vad" && (
                <Range
                  label="Práh hlasové aktivace"
                  value={settings.threshold}
                  max={0.3}
                  step={0.001}
                  format={`${Math.round(settings.threshold * 100)} %`}
                  onChange={(v) => change("threshold", v)}
                />
              )}
              <div className="level-label">
                <span>Úroveň mikrofonu</span>
                <span>{Math.round(level * 100)} %</span>
              </div>
              <div className="level-meter">
                <i style={{ width: `${Math.min(100, level * 300)}%` }} />
                <span
                  style={{
                    left: `${Math.min(100, settings.threshold * 300)}%`,
                  }}
                />
              </div>
              <button
                className={`secondary test-button ${testing ? "active" : ""}`}
                onClick={toggleTest}
              >
                <Icon name="mic" size={17} />
                {testing ? "Ukončit test mikrofonu" : "Test mikrofonu"}
              </button>
              <p className="help">
                Při testu slyšíte jen sebe. Hlas se neposílá na server. Použijte
                sluchátka.
              </p>
              <h3>Hlasitost</h3>
              <Range
                label="Hlavní hlasitost"
                value={settings.volume}
                onChange={(v) => change("volume", v)}
              />
              <Range
                label="Zesílení mikrofonu"
                value={settings.gain}
                onChange={(v) => change("gain", v)}
              />
              <h3>Upozornění</h3>
              <Range
                label="Hlasitost upozornění"
                value={settings.notifyVolume}
                max={1}
                onChange={(v) => change("notifyVolume", v)}
              />
              {(
                [
                  ["notifyChannel", "Zvuk u zpráv v kanálu"],
                  ["notifyServer", "Zvuk u zpráv na serveru"],
                  ["notifyPrivate", "Zvuk u soukromých zpráv"],
                  ["notifyPoke", "Zvuk u šťouchnutí"],
                ] as const
              ).map(([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    onChange={(e) => change(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={settings.systemNotifications}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      change("systemNotifications", false);
                      return;
                    }
                    if (
                      !("Notification" in window) ||
                      !("serviceWorker" in navigator)
                    ) {
                      setError(
                        "Systémová upozornění tento prohlížeč nepodporuje. Na iOS přidejte Mluvku na plochu.",
                      );
                      return;
                    }
                    void Notification.requestPermission()
                      .then((permission) => {
                        change("systemNotifications", permission === "granted");
                        if (permission !== "granted")
                          setError(
                            "Upozornění nejsou povolená. Změňte oprávnění v nastavení prohlížeče.",
                          );
                      })
                      .catch(() =>
                        setError("Upozornění se nepodařilo povolit."),
                      );
                  }}
                />
                Upozornění systému
              </label>
              <p className="help">
                Na pozadí, dokud aplikace běží. Na iOS je potřeba přidat Mluvku
                na plochu.
              </p>
              <h3>Zařízení</h3>
              <label>
                Mikrofon
                <select
                  value={settings.input}
                  onChange={(e) => change("input", e.target.value)}
                >
                  <option value="">Výchozí zařízení</option>
                  {devices
                    .filter(
                      (d) =>
                        d.kind === "audioinput" &&
                        d.deviceId &&
                        d.deviceId !== "default",
                    )
                    .map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Mikrofon ${i + 1}`}
                      </option>
                    ))}
                </select>
              </label>
              {"setSinkId" in AudioContext.prototype ? (
                <label>
                  Zvukový výstup
                  <select
                    value={settings.output}
                    onChange={(e) => change("output", e.target.value)}
                  >
                    <option value="">Výchozí zařízení</option>
                    {devices
                      .filter(
                        (d) =>
                          d.kind === "audiooutput" &&
                          d.deviceId &&
                          d.deviceId !== "default",
                      )
                      .map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Výstup ${i + 1}`}
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <p className="help">
                  Tento prohlížeč neumí měnit zvukový výstup. Změňte ho v
                  nastavení systému.
                </p>
              )}
              <h3>Kvalita zvuku</h3>
              <label>
                Kvalita zvuku
                <select
                  value={settings.quality}
                  onChange={(e) =>
                    change("quality", e.target.value as Settings["quality"])
                  }
                >
                  <option value="high">Vysoká (64 / 96 kb/s)</option>
                  <option value="economy">Úsporná (32 / 48 kb/s)</option>
                </select>
              </label>
              <p className="help">
                Kvalita poslechu se použije při dalším připojení. Kompresor
                vyrovnává hlasitost mikrofonu; hlasová aktivace má předběh 100
                ms. Práh se měří před kompresorem.
              </p>
              <h3>Zpracování mikrofonu</h3>
              {(
                [
                  ["echo", "Potlačení ozvěny"],
                  ["noise", "Potlačení šumu"],
                  [
                    "autoGain",
                    "Automatické zesílení prohlížeče (může zesilovat začátky)",
                  ],
                  ["beep", "Pípnutí při příchodu a odchodu"],
                  ["wakeLock", "Nezhasínat displej"],
                ] as const
              ).map(([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={settings[key]}
                    onChange={(e) => change(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <details>
                <summary>Diagnostika zvuku</summary>
                <AudioDebug />
              </details>
              <button
                className="text-button"
                onClick={() => {
                  setShowSettings(false);
                  setIdentityText(load("identity", ""));
                  setShowIdentity(true);
                }}
              >
                Exportovat / Importovat identitu
              </button>
            </div>
            <footer>
              <span>Ukládá se automaticky do prohlížeče.</span>
              <button
                className="primary"
                onClick={() => {
                  setShowSettings(false);
                  setCaptureKey(false);
                }}
              >
                Hotovo
              </button>
            </footer>
          </section>
        </div>
      )}
      {showInvite && connected && (
        <InviteDialog
          login={lastLogin.current}
          name={room?.name || login.server}
          close={() => setShowInvite(false)}
        />
      )}
      {showPasteInvite && (
        <PasteInvitation
          accept={acceptInvitation}
          close={() => setShowPasteInvite(false)}
        />
      )}
      {showIdentity && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="TS identita"
          >
            <header>
              <h2>Vaše TS identita</h2>
              <button
                aria-label="Zavřít identitu"
                onClick={() => setShowIdentity(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            <p className="help">
              Identita uchovává vaše oprávnění na serveru. Text si můžete
              zálohovat nebo sem vložit identitu z jiné Mluvky. Nikomu ji
              neposílejte.
            </p>
            <label>
              Exportovat / Importovat identitu
              <textarea
                rows={5}
                value={identityText}
                onChange={(e) => setIdentityText(e.target.value)}
                placeholder="Identita se vytvoří při prvním připojení."
                spellCheck={false}
              />
            </label>
            <footer>
              <button
                className="secondary"
                disabled={!identityText}
                onClick={() =>
                  navigator.clipboard
                    .writeText(identityText)
                    .then(() => setNotice("Identita byla zkopírována."))
                    .catch(() => setError("Text označte a zkopírujte ručně."))
                }
              >
                Kopírovat export
              </button>
              <button
                className="primary"
                disabled={connected || !identityText.trim()}
                onClick={() => {
                  if (!/^\d+V[A-Za-z0-9+/=]+$/.test(identityText.trim())) {
                    setError(
                      "Vložte úplný text identity exportovaný z Mluvky.",
                    );
                    return;
                  }
                  save("identity", identityText.trim());
                  setShowIdentity(false);
                  setNotice("Identita se použije při příštím připojení.");
                }}
              >
                Importovat identitu
              </button>
            </footer>
            {connected && (
              <p className="help">Pro import se nejprve odpojte.</p>
            )}
          </section>
        </div>
      )}
      {move && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Heslo kanálu"
            onSubmit={(e) => {
              e.preventDefault();
              moveTo(move.id, movePassword);
              setMove(undefined);
            }}
          >
            <header>
              <h2>
                <Icon name="lock" /> {move.name}
              </h2>
              <button
                type="button"
                aria-label="Zrušit přesun"
                onClick={() => setMove(undefined)}
              >
                <Icon name="close" />
              </button>
            </header>
            <label>
              Heslo kanálu
              <input
                autoFocus
                type="password"
                autoComplete="off"
                value={movePassword}
                onChange={(e) => setMovePassword(e.target.value)}
              />
            </label>
            <button type="submit" className="primary">
              Vstoupit do kanálu
            </button>
          </form>
        </div>
      )}
      {peerClient && (
        <div
          className="modal-backdrop"
          onClick={() => setPeerClient(undefined)}
        >
          <section
            className="modal peer-modal"
            onPointerDown={(e) => {
              sheetStart.current = e.clientY;
            }}
            onPointerUp={(e) => {
              if (
                sheetStart.current !== undefined &&
                e.clientY - sheetStart.current > 90 &&
                !(e.target as HTMLElement).closest("input,button")
              )
                setPeerClient(undefined);
              sheetStart.current = undefined;
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`Uživatel ${peerClient.name}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div className="peer-heading">
                <Avatar client={peerClient} />
                <h2>{peerClient.name}</h2>
              </div>
              <button
                aria-label="Zavřít uživatele"
                onClick={() => setPeerClient(undefined)}
              >
                <Icon name="close" />
              </button>
            </header>
            {peerClient.id !== me?.id ? (
              <>
                {sharing.state.shares.some(s => s.client === peerClient.id && s.uid === peerClient.uid && s.session !== sharing.state.self) && (
                  <button className="primary" onClick={() => {
                    const share = sharing.state.shares.find(s => s.client === peerClient.id && s.uid === peerClient.uid && s.session !== sharing.state.self);
                    if (share) sharing.controller.watch(share);
                    setMobile("chat");
                    setPeerClient(undefined);
                  }}><ScreenIcon />Sledovat obrazovku</button>
                )}
                <Range
                  label="Hlasitost uživatele"
                  value={
                    peerClient.uid ? (peers[peerClient.uid]?.volume ?? 1) : 1
                  }
                  onChange={(v) => peerChange(peerClient, { volume: v })}
                />
                <label className="check">
                  <input
                    type="checkbox"
                    disabled={!peerClient.uid}
                    checked={
                      peerClient.uid
                        ? (peers[peerClient.uid]?.muted ?? false)
                        : false
                    }
                    onChange={(e) =>
                      peerChange(peerClient, { muted: e.target.checked })
                    }
                  />
                  Lokálně ztlumit
                </label>
                <p className="help">
                  Měníte jen svůj poslech. Nastavení se pamatuje podle identity
                  uživatele.
                </p>
                <button
                  className="primary"
                  onClick={() => {
                    setPrivateTabs((old) => ({
                      ...old,
                      [peerClient.id]: peerClient.name,
                    }));
                    setThread(`private:${peerClient.id}`);
                    setMobile("chat");
                    setPeerClient(undefined);
                  }}
                >
                  <Icon name="chat" size={17} />
                  Napsat zprávu
                </button>
              </>
            ) : (
              <p className="help">
                To jste vy. Mikrofon a zvuk upravíte ve spodní liště.
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function AudioDebug() {
  const [stats, setStats] = useState(window.__mluvkaStats);
  useEffect(() => {
    const timer = setInterval(
      () => setStats({ ...window.__mluvkaStats }),
      1000,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <pre className="audio-debug">
      {JSON.stringify(
        {
          sharing: window.__mluvkaShareStats,
          codec: stats.codec,
          underruns: stats.underruns,
          bufferMs: Math.round(stats.bufferMs),
          targetBufferMs: Math.round(stats.targetBufferMs),
          driftPercent: stats.driftCorrection.toFixed(3),
          droppedFrames: stats.droppedFrames,
          droppedCaptureFrames: stats.droppedCaptureFrames,
          maxJump: stats.maxJump.toFixed(4),
          upKbps: stats.upKbps.toFixed(1),
          downKbps: stats.downKbps.toFixed(1),
          plcFrames: stats.plcFrames,
          lostFrames: stats.lostFrames,
        },
        null,
        2,
      )}
    </pre>
  );
}
