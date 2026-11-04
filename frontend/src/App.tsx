import { useEffect, useRef, useState, type FormEvent } from "react";
import { AudioEngine } from "./audio";
import { Icon } from "./Icon";
import {
  defaultSettings,
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

const blankLogin: Login = {
  nickname: "",
  server: "",
  password: "",
  channel: "",
  channel_password: "",
  remember: true,
  passwords: false,
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
  const [login, setLogin] = useState<Login>(() => ({
    ...blankLogin,
    ...load("login", {}),
  }));
  const [settings, setSettings] = useState<Settings>(() => ({
    ...defaultSettings,
    ...load("settings", {}),
  }));
  const [peers, setPeers] = useState<Record<string, Peer>>(() =>
    load("peers", {}),
  );
  const [status, setStatus] = useState<"idle" | "connecting" | "connected">(
    "idle",
  );
  const [room, setRoom] = useState<RoomState>();
  const roomRef = useRef<RoomState | undefined>(undefined);
  const [error, setError] = useState("");
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
  const [mobile, setMobile] = useState("channels");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const ws = useRef<WebSocket | undefined>(undefined);
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
    if (ws.current?.readyState === WebSocket.OPEN)
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
          ws.current?.readyState === WebSocket.OPEN &&
          ws.current.bufferedAmount < 1921 * 5
        ) {
          ws.current.send(data);
          window.__mluvkaStats.sentFrames++;
        }
      },
    );
  const audio = engine.current;
  const me = room?.clients.find((c) => c.id === room.self);
  const currentChannel = room?.channels.find((c) => c.id === me?.channel);
  const connected = status === "connected";
  const currentThread =
    thread === "channel" ? `channel:${me?.channel}` : thread;
  const visibleMessages = messages.filter((m) => m.thread === currentThread);

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
      ws.current?.close();
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

  async function connect(e?: FormEvent) {
    e?.preventDefault();
    if (status === "connecting") return;
    setError("");
    setNotice("");
    setStatus("connecting");
    setMessages([]);
    setTalking(new Set());
    setTesting(false);
    audio.test(false);
    if (login.remember)
      save("login", {
        ...login,
        password: login.passwords ? login.password : "",
        channel_password: login.passwords ? login.channel_password : "",
      });
    else localStorage.removeItem("mluvka.login");
    try {
      await audio.start();
      await refreshDevices();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Mikrofon nelze otevřít: ${err.message}`
          : "Mikrofon není dostupný.",
      );
      setStatus("idle");
      await audio.close();
      return;
    }
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    ws.current = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: "connect",
          ...login,
          identity: load<string | null>("identity", null),
        }),
      );
    socket.onmessage = ({ data }) => {
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
      if (msg.type === "identity") {
        save("identity", msg.identity);
        window.__mluvkaStats.uid = msg.uid;
      }
      if (msg.type === "error") setError(msg.message);
      if (msg.type === "notice") setNotice(msg.message);
      if (msg.type === "state") {
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
        roomRef.current = next;
        setRoom(next);
        setStatus("connected");
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
        audio.beep(true);
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
    socket.onerror = () =>
      setError(
        "Webové spojení se nepodařilo otevřít. Server může mít naplněný limit relací.",
      );
    socket.onclose = () => {
      if (ws.current !== socket) return;
      ws.current = undefined;
      setStatus("idle");
      setRoom(undefined);
      roomRef.current = undefined;
      setSelfTalking(false);
      void audio.close();
    };
  }
  function disconnect() {
    send({ type: "disconnect" });
    ws.current?.close();
    setNotice("Byli jste odpojeni. Můžete se připojit znovu.");
  }
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
    } else send({ type: "move", channel: channel.id, password: "" });
  }
  function sendChat(e: FormEvent) {
    e.preventDefault();
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
        <span className="topbar-caption">MÍSTO PRO VÁŠ HLAS</span>
        <div className={`connection-status ${connected ? "online" : ""}`}>
          <i />
          {connected
            ? "Připojeno"
            : status === "connecting"
              ? "Připojuji…"
              : "Připraveno k hovoru"}
        </div>
      </header>
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
          <section className="login-story">
            <div className="eyebrow">
              <i /> DOBRÁ PARTA. JEDEN KANÁL.
            </div>
            <h1>
              Tak se
              <br /> slyšíme<span>?</span>
            </h1>
            <p>
              Váš TeamSpeak, přímo v prohlížeči.
              <br />
              Připojte se k ostatním a buďte u toho.
            </p>
            <div className="sound-art" aria-hidden="true">
              {[
                22, 40, 65, 36, 88, 120, 72, 156, 100, 60, 128, 82, 46, 68, 32,
                18,
              ].map((h, i) => (
                <span
                  key={i}
                  style={{ height: h, animationDelay: `${i * 65}ms` }}
                />
              ))}
            </div>
            <div className="story-foot">
              <span>01 / PŘIPOJIT</span>
              <span>BEZ INSTALACE. S VLASTNÍ IDENTITOU.</span>
            </div>
          </section>
          <section className="login-card">
            <div className="card-kicker">
              <Icon name="headphones" />
              <span>VÍTEJTE NA MLUVCE</span>
            </div>
            <h2>Pojďte za ostatními.</h2>
            <p className="muted">Stačí adresa serveru a vaše přezdívka.</p>
            <form onSubmit={connect}>
              <label>
                Přezdívka
                <input
                  autoComplete="nickname"
                  required
                  maxLength={30}
                  placeholder="Jak vám máme říkat?"
                  value={login.nickname}
                  onChange={(e) =>
                    setLogin({ ...login, nickname: e.target.value })
                  }
                />
              </label>
              <label>
                Adresa serveru
                <input
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
                      type="password"
                      autoComplete="off"
                      value={login.channel_password}
                      onChange={(e) =>
                        setLogin({ ...login, channel_password: e.target.value })
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
              <button
                className="primary connect-button"
                disabled={status === "connecting"}
                type="submit"
              >
                {status === "connecting"
                  ? "Navazuji spojení…"
                  : load("login", null)
                    ? "Připojit se znovu"
                    : "Připojit se"}
                <Icon name="chevron" size={19} />
              </button>
            </form>
            <div className="login-tools">
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
            <p className="privacy-note">
              <Icon name="lock" size={12} />
              Identita zůstává ve vašem prohlížeči.
            </p>
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
              Chat
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
              <nav className="chat-tabs" aria-label="Chat">
                <button
                  className={thread === "channel" ? "active" : ""}
                  onClick={() => setThread("channel")}
                >
                  <Icon name="chat" size={16} />
                  Kanál
                </button>
                <button
                  className={thread === "server" ? "active" : ""}
                  onClick={() => setThread("server")}
                >
                  Server
                </button>
                {Object.entries(privateTabs).map(([id, name]) => (
                  <div
                    className="private-tab"
                    key={id}
                    data-active={thread === `private:${id}`}
                  >
                    <button onClick={() => setThread(`private:${id}`)}>
                      {name}
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
                      <p>{m.text}</p>
                    </div>
                  </article>
                ))}
                <div ref={chatEnd} />
              </div>
              <form className="composer" onSubmit={sendChat}>
                <input
                  aria-label="Zpráva"
                  value={text}
                  maxLength={2000}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={`Napsat ${thread === "channel" ? "do kanálu" : thread === "server" ? "na server" : "soukromou zprávu"}…`}
                />
                <button
                  aria-label="Odeslat zprávu"
                  disabled={!text.trim()}
                  type="submit"
                >
                  <Icon name="send" size={20} />
                </button>
                <span>ENTER PRO ODESLÁNÍ</span>
              </form>
            </section>
          </main>
          <footer className="voice-bar">
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
                }}
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
              <h3>Zpracování mikrofonu</h3>
              {(
                [
                  ["echo", "Potlačení ozvěny"],
                  ["noise", "Potlačení šumu"],
                  ["autoGain", "Automatické zesílení"],
                  ["beep", "Pípnutí při příchodu a odchodu"],
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
              send({ type: "move", channel: move.id, password: movePassword });
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
      {!connected && (
        <footer className="login-footer">
          <span>MLUVKA / WEBOVÝ KLIENT PRO TEAMSPEAK</span>
          <span>Malá aplikace. Velké rozhovory.</span>
        </footer>
      )}
    </div>
  );
}
