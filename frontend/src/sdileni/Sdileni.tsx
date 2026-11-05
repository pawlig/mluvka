import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { qualities, type Quality, type Sharing } from "./controller";
import "./sdileni.css";

export function ScreenIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8m-4-4v4m-5-9 3-3 3 3 4-4" />
    </svg>
  );
}
export function MluvkaIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2 6v4m4-7v10m4-8v6m4-5v4" />
    </svg>
  );
}
export function SharingControls({ controller }: { controller: Sharing }) {
  const [quality, setQuality] = useState<Quality>("720");
  const [audio, setAudio] = useState(false);
  const [open, setOpen] = useState(false);
  const state = controller.state;
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const mobile =
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (mobile || !navigator.mediaDevices?.getDisplayMedia)
    return (
      <span
        className="share-desktop-hint"
        title="Sdílet jde z počítače"
        aria-label="Sdílet jde z počítače"
      >
        <ScreenIcon />
      </span>
    );
  return (
    <>
      <button
        className={`control-button share-toggle ${state.sharing ? "share-live" : ""}`}
        title={
          state.sharing
            ? `Sdílíte obrazovku · ${state.viewers} diváků`
            : "Sdílet obrazovku"
        }
        onClick={() => setOpen(true)}
      >
        <ScreenIcon />
        <span>
          {state.sharing
            ? `Sdílíte · ${state.viewers} diváků`
            : state.starting
              ? "Spouštím…"
              : "Sdílet obrazovku"}
        </span>
      </button>
      {open &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setOpen(false)}>
            <section
              className="modal share-panel"
              role="dialog"
              aria-modal="true"
              aria-label="Sdílení obrazovky"
              onClick={(event) => event.stopPropagation()}
            >
              <header>
                <h2>Sdílení obrazovky</h2>
                <button
                  autoFocus
                  aria-label="Zavřít sdílení"
                  onClick={() => setOpen(false)}
                >
                  ×
                </button>
              </header>
              {state.sharing || state.starting ? (
                <>
                  <p className="share-live">
                    {state.sharing
                      ? `Sdílíte obrazovku · ${state.viewers} diváků`
                      : "Čekám na potvrzení serveru…"}
                  </p>
                  <p className="help">
                    {qualities[quality].label}
                    {audio
                      ? " · se zvukem, pokud jej prohlížeč poskytne"
                      : " · bez zvuku"}
                  </p>
                  <button
                    className="secondary share-switch"
                    disabled={!state.sharing || state.switching}
                    onClick={() => void controller.switchSource()}
                  >
                    {state.switching ? "Vybírám zdroj…" : "Přepnout zdroj"}
                  </button>
                  <button
                    className="share-stop"
                    onClick={() => {
                      controller.stop();
                      setOpen(false);
                    }}
                  >
                    Ukončit sdílení
                  </button>
                </>
              ) : (
                <div className="share-controls">
                  <label>
                    Kvalita sdílení
                    <select
                      aria-label="Kvalita sdílení"
                      value={quality}
                      onChange={(event) =>
                        setQuality(event.target.value as Quality)
                      }
                    >
                      {Object.entries(qualities).map(([key, preset]) => (
                        <option key={key} value={key}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="share-audio-choice">
                    <input
                      type="checkbox"
                      checked={audio}
                      onChange={(event) => setAudio(event.target.checked)}
                    />
                    Zvuk karty / systému
                  </label>
                  <button
                    className="share-start"
                    onClick={() =>
                      void controller.start(quality, audio).then(() => {
                        if (
                          controller.state.starting ||
                          controller.state.sharing
                        )
                          setOpen(false);
                      })
                    }
                  >
                    <ScreenIcon />
                    Spustit sdílení
                  </button>
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
export function SharingArea({
  controller,
  output,
}: {
  controller: Sharing;
  output: string;
}) {
  const state = controller.state;
  return (
    <div className="sharing-area">
      {state.error && (
        <div className="share-error" role="alert">
          {state.error}
        </div>
      )}
      {state.shares
        .filter((p) => p.session !== state.self)
        .map((share) => (
          <div className="share-card" key={share.session}>
            <ScreenIcon />
            <span>
              <strong>{share.name}</strong> sdílí obrazovku
            </span>
            <button
              onClick={() =>
                state.watching?.session === share.session
                  ? controller.unwatch()
                  : controller.watch(share)
              }
            >
              {state.watching?.session === share.session
                ? "Přestat sledovat"
                : "Sledovat"}
            </button>
          </div>
        ))}
      {state.watching && (
        <Player
          key={state.watching.session}
          controller={controller}
          output={output}
        />
      )}
    </div>
  );
}
function Player({
  controller,
  output,
}: {
  controller: Sharing;
  output: string;
}) {
  const { stream, watching, status, stats } = controller.state;
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(1),
    [blocked, setBlocked] = useState(false),
    [fullscreenError, setFullscreenError] = useState("");
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ distance: 0, scale: 1, x: 0, y: 0, cx: 0, cy: 0 });
  const tap = useRef({ at: 0, x: 0, y: 0 });
  const down = useRef({ x: 0, y: 0, at: 0, multi: false });
  useEffect(() => {
    if (video.current) {
      video.current.srcObject = stream || null;
      void video.current.play().catch(() => {});
    }
    const el = audio.current;
    if (!el) return;
    el.srcObject = stream ? new MediaStream(stream.getAudioTracks()) : null;
    if (stream?.getAudioTracks().length)
      void el
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    return () => {
      if (video.current) video.current.srcObject = null;
      el.srcObject = null;
    };
  }, [
    stream,
    stream
      ?.getAudioTracks()
      .map((t) => t.id)
      .join(","),
  ]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    const el = audio.current as
      (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (el?.setSinkId)
      void el.setSinkId(output || "").catch(() => setBlocked(true));
  }, [output]);
  useEffect(() => {
    const reset = () => setView({ scale: 1, x: 0, y: 0 });
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);
  function constrain(scale: number, x: number, y: number) {
    const rect = container.current?.getBoundingClientRect();
    const maxX = ((rect?.width || 0) * (scale - 1)) / 2,
      maxY = ((rect?.height || 0) * (scale - 1)) / 2;
    return {
      scale,
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }
  function baseline() {
    const p = [...pointers.current.values()],
      first = p[0];
    if (!first) return;
    const center =
      p.length > 1
        ? { x: (first.x + p[1].x) / 2, y: (first.y + p[1].y) / 2 }
        : first;
    gesture.current = {
      ...viewRef.current,
      distance:
        p.length > 1 ? Math.hypot(first.x - p[1].x, first.y - p[1].y) : 0,
      cx: center.x,
      cy: center.y,
    };
  }
  function pointerDown(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down.current = {
      x: e.clientX,
      y: e.clientY,
      at: Date.now(),
      multi: pointers.current.size > 1,
    };
    baseline();
  }
  function pointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pointers.current.values()],
      g = gesture.current;
    if (p.length > 1 && g.distance) {
      const scale = Math.max(
        1,
        Math.min(
          4,
          (g.scale * Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)) / g.distance,
        ),
      );
      setView(
        constrain(
          scale,
          g.x + (p[0].x + p[1].x) / 2 - g.cx,
          g.y + (p[0].y + p[1].y) / 2 - g.cy,
        ),
      );
    } else if (p.length === 1 && g.scale > 1)
      setView(constrain(g.scale, g.x + p[0].x - g.cx, g.y + p[0].y - g.cy));
  }
  function pointerUp(e: PointerEvent<HTMLDivElement>) {
    const start = down.current,
      now = Date.now();
    if (
      e.type === "pointerup" &&
      !start.multi &&
      now - start.at < 300 &&
      Math.hypot(e.clientX - start.x, e.clientY - start.y) < 12
    ) {
      if (
        now - tap.current.at < 350 &&
        Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) < 30
      ) {
        setView((v) => ({ scale: v.scale > 1 ? 1 : 2, x: 0, y: 0 }));
        tap.current.at = 0;
      } else tap.current = { at: now, x: e.clientX, y: e.clientY };
    }
    pointers.current.delete(e.pointerId);
    baseline();
  }
  async function fullscreen() {
    setFullscreenError("");
    const el = video.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (container.current?.requestFullscreen) {
      try {
        await container.current.requestFullscreen();
        return;
      } catch {
        /* iOS může API vystavit, ale povolit jen nativní fullscreen videa. */
      }
    }
    try {
      if (el?.webkitEnterFullscreen) el.webkitEnterFullscreen();
      else setFullscreenError("Celou obrazovku tento prohlížeč nepodporuje.");
    } catch {
      setFullscreenError("Celou obrazovku se nepodařilo zapnout.");
    }
  }
  return (
    <section
      className="share-player"
      aria-label={`Obrazovka: ${watching?.name}`}
    >
      <div className="share-player-heading">
        <span className="share-status" role="status">
          {status}
        </span>
        <span>
          {stats?.width
            ? `${stats.width} × ${stats.height} · ${Math.round(stats.fps)} fps`
            : watching?.name}
        </span>
      </div>
      <div
        ref={container}
        className="share-viewport"
        data-scale={view.scale.toFixed(2)}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onLostPointerCapture={pointerUp}
      >
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        />
        {!stream && <span className="share-wait">Čekám na obraz…</span>}
      </div>
      <audio ref={audio} autoPlay />
      <div className="share-player-tools">
        <button
          onClick={() => setView({ scale: 1, x: 0, y: 0 })}
          aria-label="Obnovit přiblížení"
        >
          {view.scale.toFixed(1)}×
        </button>
        <label>
          Zvuk sdílení
          <input
            aria-label="Hlasitost sdílení"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>
        {blocked && (
          <button
            onClick={() => {
              void audio.current
                ?.play()
                .then(() => setBlocked(false))
                .catch(() => setBlocked(true));
            }}
          >
            Zapnout zvuk sdílení
          </button>
        )}
        <button onClick={() => void fullscreen()}>Celá obrazovka</button>
        <button onClick={() => controller.unwatch()}>Zavřít sledování</button>
      </div>
      {fullscreenError && <p role="status">{fullscreenError}</p>}
    </section>
  );
}
