// Lišta hudebního bota v kanálu. Bot je běžný TS klient ovládaný textovými
// příkazy; backend je posílá soukromě a vrací rozparsované odpovědi
// (`{type:"music", event:"bot"|"reply"|"timeout"|"error"}`).
// Bot neříká, jestli hraje, kde ve skladbě je ani aktuální hlasitost —
// stav odvozujeme z posledního potvrzeného příkazu a oznámení v kanálu.
import { useEffect, useRef, useState, type FormEvent } from "react";
import "./hudba.css";

type Track = { title: string; artist: string };
type Reply =
  | {
      kind: "now";
      track: Track | null;
      requested_by: string | null;
      last_queued: string | null;
    }
  | { kind: "upnext"; track: Track | null; pending: boolean }
  | {
      kind: "queue";
      total: number;
      items: Track[];
      more: number;
      pending: boolean;
    }
  | { kind: "volume"; volume: number }
  | { kind: "ack"; action: string }
  | { kind: "search"; query: string | null; link: boolean }
  | { kind: "error"; code: string; text: string }
  | { kind: "unknown"; text: string }
  | {
      kind: "announce";
      track: Track;
      requested_by: string | null;
      next: Track | null;
    };
export type MusicMessage =
  | { type: "music"; event: "bot"; present: boolean; client?: number; name?: string }
  | { type: "music"; event: "reply"; command: string | null; reply: Reply }
  | { type: "music"; event: "timeout"; command: string }
  | { type: "music"; event: "error"; code: string; text?: string };

type Send = (data: unknown) => void;
type Action =
  | "now" | "queue" | "upnext" | "pause" | "resume" | "next" | "prev"
  | "seek" | "volume" | "play" | "playnow";

// Zprávy z WS přicházejí v App.tsx; lišta je odebírá přes jednoduchou sběrnici.
const listeners = new Set<(m: MusicMessage) => void>();
export function receiveMusic(message: MusicMessage) {
  for (const l of listeners) l(message);
}

const ERRORS: Record<string, string> = {
  rate_limited: "Bot je vytížený, zkuste to za chvilku.",
  forbidden: "Tento bot vám nedovolí, abyste ho ovládali.",
  search_busy: "Bot ještě hledá předchozí skladbu.",
  search_failed: "Hledání se nepovedlo — skladbu se nepodařilo najít.",
  usage: "Bot příkaz nepřijal.",
  invalid: "Bot příkaz nepřijal.",
  too_long: "Hledání je příliš dlouhé.",
  seek_end: "Do konce skladby zbývá méně, než je posun.",
  seek_unavailable: "Tuhle skladbu teď nejde posouvat.",
  queue_unavailable: "Fronta se právě načítá, zkuste to za chvilku.",
  timeout: "Spotify neodpověděl včas, zkontrolujte frontu.",
  unavailable: "Přehrávač bota teď nefunguje.",
  no_bot: "Hudební bot není v kanálu.",
  busy: "Příliš mnoho příkazů najednou.",
};
const POLL = new Set(["/now", "/queue", "/upnext"]);

/** ±30 % rozptyl, ať se dotazy víc uživatelů na bota nesčítají. */
const jitter = (ms: number) => ms * (0.7 + Math.random() * 0.6);

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function Cover({ title }: { title: string }) {
  const h = hash(title || "Hudba");
  return (
    <span
      className="hudba-cover"
      aria-hidden="true"
      style={{
        background: `linear-gradient(135deg, hsl(${h % 360} 70% 58%), hsl(${(h >>> 9) % 360} 65% 34%))`,
      }}
    />
  );
}

const paths: Record<string, string> = {
  prev: "M6 5h2v14H6zM20 5v14L9 12z",
  next: "M16 5h2v14h-2zM4 5v14l11-7z",
  play: "M7 4v16l13-8z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  queue: "M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm14-3v6l5-3z",
  note: "M9 17a3 3 0 1 1-2-2.8V5l12-2v11a3 3 0 1 1-2-2.8V6.4L9 7.7z",
  volume: "M4 9h4l5-4v14l-5-4H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z",
  refresh: "M17.6 6.4A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z",
};
function Glyph({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="hudba-glyph">
      <path d={paths[name]} fill="currentColor" />
    </svg>
  );
}

const label = (t: Track | null | undefined) =>
  t ? (t.artist ? `${t.title} — ${t.artist}` : t.title) : "";

export function HudebniLista({
  send,
  active,
}: {
  send: Send;
  active: boolean;
}) {
  const [bot, setBot] = useState<{ client: number; name: string } | null>(null);
  const [now, setNow] = useState<{
    track: Track | null;
    requestedBy: string | null;
    lastQueued: string | null;
  } | null>(null);
  const [upnext, setUpnext] = useState<{ track: Track | null; pending: boolean } | null>(null);
  const [queue, setQueue] = useState<Extract<Reply, { kind: "queue" }> | null>(null);
  const [playing, setPlaying] = useState<boolean | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [volume, setVolume] = useState<number | null>(null);
  const [slider, setSlider] = useState(50);
  const [panel, setPanel] = useState(false);
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [playNow, setPlayNow] = useState(false);
  const [visible, setVisible] = useState(!document.hidden);
  const sendRef = useRef(send);
  sendRef.current = send;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const command = (action: Action, arg?: string | number) =>
    sendRef.current({
      type: "music",
      action,
      ...(arg === undefined ? {} : { arg: String(arg) }),
    });
  const later = (ms: number, fn: () => void) =>
    timers.current.push(setTimeout(fn, ms));
  const notify = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  };

  useEffect(() => {
    const listener = (m: MusicMessage) => {
      if (m.event === "bot") {
        setBot(m.present ? { client: m.client!, name: m.name || "Hudba" } : null);
        if (!m.present) {
          setNow(null);
          setQueue(null);
          setUpnext(null);
          setPlaying(null);
          setVolume(null);
          setWaiting(false);
          setSearch("");
          setPanel(false);
        }
        return;
      }
      if (m.event === "error") {
        setWaiting(false);
        notify(m.text || ERRORS[m.code] || "Přehrávač příkaz nepřijal.");
        return;
      }
      if (m.event === "timeout") {
        if (!POLL.has(m.command)) {
          setWaiting(false);
          notify("Bot neodpověděl. Zkuste to znovu.");
        }
        return;
      }
      const r = m.reply;
      const poll = m.command !== null && POLL.has(m.command);
      if (!poll && r.kind !== "search") setWaiting(false);
      switch (r.kind) {
        case "now":
          setNow({ track: r.track, requestedBy: r.requested_by, lastQueued: r.last_queued });
          if (!r.track) setPlaying(null);
          else setPlaying((p) => (p === null ? true : p));
          setSearch("");
          break;
        case "announce":
          setNow((old) => ({
            track: r.track,
            requestedBy: r.requested_by,
            lastQueued: old?.lastQueued ?? null,
          }));
          if (r.next) setUpnext({ track: r.next, pending: false });
          setPlaying(true);
          break;
        case "upnext":
          setUpnext({ track: r.track, pending: r.pending });
          break;
        case "queue":
          setQueue(r);
          break;
        case "volume":
          setVolume(r.volume);
          setSlider(r.volume);
          break;
        case "ack":
          // Posun stav přehrávání nemění; ostatní akce znamenají „hraje".
          if (r.action === "pause") setPlaying(false);
          else if (r.action !== "seek") setPlaying(true);
          break;
        case "search":
          setSearch(r.link ? "Otevírám odkaz…" : `Hledám: ${r.query ?? ""}`);
          break;
        case "error":
          if (r.code === "search_failed") setSearch("");
          if (!poll || r.code === "search_failed")
            notify(ERRORS[r.code] || "Bot příkaz nepřijal.");
          break;
        case "unknown":
          if (!poll) notify(`Bot: ${r.text.slice(0, 160)}`);
          break;
      }
    };
    listeners.add(listener);
    const onVisible = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      listeners.delete(listener);
      document.removeEventListener("visibilitychange", onVisible);
      for (const t of timers.current) clearTimeout(t);
      clearTimeout(volumeTimer.current);
      clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!active) setBot(null);
  }, [active]);

  const shown = active && !!bot;
  // `/now` ~15 s, dokud je lišta vidět; fronta ~30 s jen při otevřeném panelu.
  useEffect(() => {
    if (!shown || !visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      command("now");
      timer = setTimeout(tick, jitter(15000));
    };
    timer = setTimeout(tick, 300);
    return () => clearTimeout(timer);
  }, [shown, visible]);
  useEffect(() => {
    if (!shown || !visible || !panel) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      command("upnext");
      command("queue");
      timer = setTimeout(tick, jitter(30000));
    };
    timer = setTimeout(tick, 200);
    return () => clearTimeout(timer);
  }, [shown, visible, panel]);

  if (!shown) return null;

  const act = (action: Action, arg?: number) => {
    setWaiting(true);
    command(action, arg);
    later(2000, () => command("now"));
  };
  const toggle = () => act(playing === false ? "resume" : "pause");
  const commitVolume = (value: number) => {
    clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => command("volume", value), 400);
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    command(playNow ? "playnow" : "play", q);
    setSearch(`Hledám: ${q}`);
    setQuery("");
    later(4000, () => command("now"));
    if (panel) later(4500, () => {
      command("queue");
    });
  };
  const track = now?.track;
  const playLabel = waiting ? "Čekám na bota" : playing === false ? "Pustit" : "Pozastavit";

  return (
    <section className="hudba" aria-label="Hudba">
      <div className="hudba-info">
        <Cover title={track?.title || ""} />
        <div className="hudba-text">
          <strong className="hudba-title">
            {track ? track.title : now ? "Nic nehraje" : "Hudba"}
          </strong>
          <span className="hudba-artist">
            {search || track?.artist || bot.name}
          </span>
          {now?.requestedBy && (
            <span className="hudba-by">přidal: {now.requestedBy}</span>
          )}
        </div>
      </div>
      <div className="hudba-controls">
        <button className="hudba-seek hudba-wide" onClick={() => act("seek", -15)} aria-label="Zpět o 15 sekund">
          −15 s
        </button>
        <button className="hudba-wide" onClick={() => act("prev")} aria-label="Předchozí skladba">
          <Glyph name="prev" />
        </button>
        <button
          className="hudba-play"
          onClick={toggle}
          disabled={waiting}
          aria-label={playLabel}
          title={playing === null ? "Stav přehrávání bot nehlásí" : playLabel}
        >
          {waiting ? "…" : <Glyph name={playing === false ? "play" : "pause"} />}
        </button>
        <button onClick={() => act("next")} aria-label="Další skladba">
          <Glyph name="next" />
        </button>
        <button className="hudba-seek hudba-wide" onClick={() => act("seek", 30)} aria-label="Vpřed o 30 sekund">
          +30 s
        </button>
      </div>
      <div className="hudba-side">
        <label className="hudba-volume hudba-wide" title={volume === null ? "Hlasitost bot hlásí až po změně" : `${volume} %`}>
          <Glyph name="volume" />
          <input
            type="range"
            min={0}
            max={100}
            value={slider}
            aria-label="Hlasitost hudby"
            onChange={(e) => {
              setSlider(Number(e.target.value));
              commitVolume(Number(e.target.value));
            }}
          />
          <span>{volume === null ? "–" : `${volume} %`}</span>
        </label>
        <button
          className="hudba-queue-button"
          aria-label="Fronta a přidání skladby"
          aria-expanded={panel}
          data-active={panel}
          onClick={() => setPanel((p) => !p)}
        >
          <Glyph name="queue" />
        </button>
      </div>
      {panel && (
        <div className="hudba-panel" role="dialog" aria-label="Fronta hudby">
          <form className="hudba-add" onSubmit={add}>
            <input
              value={query}
              maxLength={2048}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Přidat skladbu nebo odkaz Spotify"
              aria-label="Přidat skladbu nebo odkaz Spotify"
            />
            <button type="submit" disabled={!query.trim()}>
              {playNow ? "Pustit" : "Přidat"}
            </button>
            <label className="hudba-check">
              <input
                type="checkbox"
                checked={playNow}
                onChange={(e) => setPlayNow(e.target.checked)}
              />
              Pustit hned (jen jedna skladba)
            </label>
          </form>
          <div className="hudba-panel-controls">
            <button onClick={() => act("seek", -15)}>−15 s</button>
            <button onClick={() => act("prev")} aria-label="Předchozí skladba v panelu">
              <Glyph name="prev" />
            </button>
            <button onClick={() => act("seek", 30)}>+30 s</button>
            <label className="hudba-volume">
              <Glyph name="volume" />
              <input
                type="range"
                min={0}
                max={100}
                value={slider}
                aria-label="Hlasitost hudby v panelu"
                onChange={(e) => {
                  setSlider(Number(e.target.value));
                  commitVolume(Number(e.target.value));
                }}
              />
            </label>
          </div>
          <header>
            <h3>Další</h3>
            <button
              className="hudba-refresh"
              aria-label="Obnovit frontu"
              onClick={() => {
                command("upnext");
                command("queue");
              }}
            >
              <Glyph name="refresh" />
            </button>
          </header>
          <p className="hudba-next">
            {upnext === null
              ? "Načítám…"
              : upnext.track
                ? label(upnext.track)
                : upnext.pending
                  ? "Spotify další skladbu ještě nenačetl."
                  : "Nic dalšího ve frontě."}
          </p>
          <h3>Fronta{queue && queue.total > 0 ? ` (${queue.total})` : ""}</h3>
          {queue === null ? (
            <p className="hudba-empty">Načítám…</p>
          ) : queue.items.length === 0 ? (
            <p className="hudba-empty">
              {queue.pending ? "Fronta se načítá." : "Nikdo nic nepřidal."}
            </p>
          ) : (
            <ol className="hudba-list">
              {queue.items.map((t, i) => (
                <li key={i}>
                  <Cover title={t.title} />
                  <span>
                    <strong>{t.title}</strong>
                    {t.artist && <small>{t.artist}</small>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {queue && queue.more > 0 && (
            <p className="hudba-more">+{queue.more} dalších</p>
          )}
          {now?.lastQueued && (
            <p className="hudba-empty">Naposledy přidáno: {now.lastQueued}</p>
          )}
        </div>
      )}
      {toast && (
        <div className="hudba-toast" role="status">
          {toast}
        </div>
      )}
    </section>
  );
}
