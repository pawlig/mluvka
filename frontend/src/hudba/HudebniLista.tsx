// Lišta hudebního bota v kanálu. Bot je běžný TS klient ovládaný textovými
// příkazy; backend je posílá soukromě a vrací rozparsované odpovědi
// (`{type:"music", event:"bot"|"reply"|"timeout"|"error"}`).
// Bot neříká, jestli hraje, kde ve skladbě je ani aktuální hlasitost —
// stav odvozujeme z posledního potvrzeného příkazu a oznámení v kanálu.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
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
  | "seek" | "volume" | "play" | "playnow" | "idle";

type NowState = {
  track: Track | null;
  requestedBy: string | null;
  lastQueued: string | null;
};
type QueueReply = Extract<Reply, { kind: "queue" }>;
/** Poslední známý stav bota. Drží ho sběrnice, ne lišta: lišta se připojuje
 *  až po `state`, a událost „bot přítomen" může přijít ještě před ní. */
type Snapshot = {
  bot: { client: number; name: string } | null;
  now: NowState | null;
  upnext: { track: Track | null; pending: boolean } | null;
  queue: QueueReply | null;
  volume: number | null;
  /** `null` = bot stav nehlásí a žádný příkaz ho nepotvrdil. */
  playing: boolean | null;
};
const EMPTY: Snapshot = {
  bot: null,
  now: null,
  upnext: null,
  queue: null,
  volume: null,
  playing: null,
};

function reduce(s: Snapshot, m: MusicMessage): Snapshot {
  if (m.event === "bot") {
    if (!m.present) return EMPTY;
    const bot = { client: m.client!, name: m.name || "Hudba" };
    return s.bot?.client === bot.client ? { ...s, bot } : { ...EMPTY, bot };
  }
  if (m.event !== "reply" || !s.bot) return s;
  const r = m.reply;
  switch (r.kind) {
    case "now":
      // Titul neznamená, že hraje — i pozastavená skladba je „Now".
      return {
        ...s,
        now: { track: r.track, requestedBy: r.requested_by, lastQueued: r.last_queued },
        playing: r.track ? s.playing : null,
      };
    case "announce":
      return {
        ...s,
        now: { track: r.track, requestedBy: r.requested_by, lastQueued: s.now?.lastQueued ?? null },
        upnext: r.next ? { track: r.next, pending: false } : s.upnext,
        playing: true,
      };
    case "upnext":
      return { ...s, upnext: { track: r.track, pending: r.pending } };
    case "queue":
      return { ...s, queue: r };
    case "volume":
      return { ...s, volume: r.volume };
    case "ack":
      if (r.action === "pause") return { ...s, playing: false };
      if (r.action === "resume") return { ...s, playing: true };
      // Po přeskočení pauzy nevíme, jestli Spotify hraje; posun stav nemění.
      if (r.action !== "seek" && s.playing === false) return { ...s, playing: null };
      return s;
    default:
      return s;
  }
}

// Zprávy z WS přicházejí v App.tsx; lišta je odebírá přes sběrnici se stavem.
let snapshot: Snapshot = EMPTY;
const listeners = new Set<(m: MusicMessage) => void>();
export function receiveMusic(message: MusicMessage) {
  snapshot = reduce(snapshot, message);
  for (const l of listeners) l(message);
}
/** Nové spojení s TS: stav z minulého spojení neplatí. */
export function resetMusic() {
  receiveMusic({ type: "music", event: "bot", present: false });
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
  playpause: "M3 5v14l9-7zM14 5h3v14h-3zM19 5h3v14h-3z",
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
  const [snap, setSnap] = useState(snapshot);
  const { bot, now, upnext, queue, volume, playing } = snap;
  const [waiting, setWaiting] = useState(false);
  const [slider, setSlider] = useState(snapshot.volume ?? 50);
  const [panel, setPanel] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [playNow, setPlayNow] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const sendRef = useRef(send);
  sendRef.current = send;
  const barRef = useRef<HTMLElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const volumeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const command = (action: Action, arg?: string | number) =>
    sendRef.current({
      type: "music",
      action,
      ...(arg === undefined ? {} : { arg: String(arg) }),
    });
  // Odložený dotaz se pošle, jen když je stránka vidět a bot pořád v kanálu.
  const allowed = () => document.visibilityState === "visible" && !!snapshot.bot;
  const later = (ms: number, fn: () => void) =>
    timers.current.push(
      setTimeout(() => {
        if (allowed()) fn();
      }, ms),
    );
  const notify = (text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  };

  useEffect(() => {
    const listener = (m: MusicMessage) => {
      setSnap(snapshot);
      if (m.event === "bot") {
        if (!m.present) {
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
      // Stav (skladba, fronta, hlasitost, hraje/pauza) už spočítal `reduce`.
      switch (r.kind) {
        case "now":
          setSearch("");
          break;
        case "volume":
          setSlider(r.volume);
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
    // Co přišlo před registrací posluchače, převezmeme hned ze sběrnice.
    setSnap(snapshot);
    if (snapshot.volume !== null) setSlider(snapshot.volume);
    const onVisible = () => {
      const shown = document.visibilityState === "visible";
      setVisible(shown);
      // Skrytá stránka: backend zahodí dotazy na stav, které ještě čekají ve frontě bota.
      if (!shown) sendRef.current({ type: "music", action: "idle" });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      listeners.delete(listener);
      document.removeEventListener("visibilitychange", onVisible);
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
      clearTimeout(volumeTimer.current);
      clearTimeout(toastTimer.current);
    };
  }, []);

  const shown = active && !!bot;
  // Po skrytí stránky nebo odchodu bota se odložené dotazy zruší.
  useEffect(() => {
    if (shown && visible) return;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    clearTimeout(volumeTimer.current);
  }, [shown, visible]);

  // Mobil: panel končí nad vstupem chatu, ať ho nezakrývá.
  useLayoutEffect(() => {
    if (!panel) return;
    const composer = document.querySelector<HTMLElement>(".composer");
    const place = () => {
      const bar = barRef.current?.getBoundingClientRect();
      const box = composer?.getBoundingClientRect();
      const gap = 8;
      if (!bar || !box || box.height === 0 || !window.matchMedia("(max-width: 699px)").matches) {
        setPanelStyle({});
        return;
      }
      // Klávesnice na mobilu zmenší jen vizuální viewport — počítej s jeho horním okrajem a výškou.
      const vv = window.visualViewport;
      const top = vv ? vv.offsetTop : 0;
      const height = vv ? vv.height : window.innerHeight;
      setPanelStyle({
        bottom: Math.max(bar.height + gap, bar.bottom - box.top + gap),
        maxHeight: Math.max(120, Math.min(box.top - top - 2 * gap, height * 0.6)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const observer =
      composer && typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    if (composer) observer?.observe(composer);
    return () => {
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      observer?.disconnect();
    };
  }, [panel]);
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
  // Neznámý stav: bot nejspíš hraje, takže ⏯ pozastaví (a stav se tím ujasní).
  const toggle = () => act(playing === false ? "resume" : "pause");
  const commitVolume = (value: number) => {
    clearTimeout(volumeTimer.current);
    volumeTimer.current = setTimeout(() => {
      if (allowed()) command("volume", value);
    }, 400);
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
  const playLabel = waiting
    ? "Čekám na bota"
    : playing === null
      ? "Přehrávání (stav neznámý)"
      : playing
        ? "Pozastavit"
        : "Pustit";
  const playState = playing === null ? "unknown" : playing ? "playing" : "paused";

  return (
    <section className="hudba" aria-label="Hudba" ref={barRef}>
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
          data-state={waiting ? "waiting" : playState}
          title={playing === null ? "Bot nehlásí, jestli hraje — kliknutím pozastavíte" : playLabel}
        >
          {waiting ? (
            "…"
          ) : (
            <Glyph name={playing === null ? "playpause" : playing ? "pause" : "play"} />
          )}
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
        <div className="hudba-panel" role="dialog" aria-label="Fronta hudby" style={panelStyle}>
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
