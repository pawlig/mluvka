import { useEffect, useRef, useState, type ReactNode } from "react";

const imageExtension = /\.(png|jpe?g|gif|webp|avif)(?:\?[^#]*)?(?:#.*)?$/i;
export function safeUrl(value: string): string | undefined {
  const raw = value.trim();
  if (/[\u0000-\u0020\u007f]/.test(raw)) return;
  try {
    const url = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    if (["http:", "https:", "ts3server:"].includes(url.protocol))
      return url.href;
  } catch {
    /* Neplatná URL zůstane textem. */
  }
}
function short(value: string) {
  return value.length > 90
    ? `${value.slice(0, 65)}…${value.slice(-18)}`
    : value;
}
function link(url: string, label: ReactNode, key: number) {
  return (
    <a
      key={key}
      href={url}
      title={url}
      {...(url.startsWith("ts3server:")
        ? {}
        : { target: "_blank", rel: "noopener noreferrer nofollow" })}
    >
      {label}
    </a>
  );
}
const colorCache = new Map<string, string | undefined>();
function readableColor(value: string): string | undefined {
  const name = value.trim().toLowerCase();
  if (colorCache.has(name)) return colorCache.get(name);
  let result: string | undefined;
  if (
    /^(#[\da-f]{3}|#[\da-f]{6}|[a-z]+)$/.test(name) &&
    ![
      "transparent",
      "currentcolor",
      "inherit",
      "initial",
      "unset",
      "revert",
    ].includes(name) &&
    CSS.supports("color", name)
  ) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = name;
    const hex = ctx.fillStyle;
    if (/^#[\da-f]{6}$/i.test(hex)) {
      let rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const luminance = (values: number[]) =>
        values
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      // Poměr alespoň 4,5 : 1 proti tmavému pozadí zpráv.
      while ((luminance(rgb) + 0.05) / (0.012 + 0.05) < 4.5)
        rgb = rgb.map((v) => Math.min(255, v + 8));
      result = `rgb(${rgb.join(",")})`;
    }
  }
  if (colorCache.size > 128) colorCache.clear();
  colorCache.set(name, result);
  return result;
}
function renderMessage(
  text: string,
  images: Set<string>,
  inLink = false,
  depth = 0,
): ReactNode[] {
  const result: ReactNode[] = [];
  const plain = (value: string) => {
    if (inLink) {
      result.push(value);
      return;
    }
    const urls = /(?:https?:\/\/|www\.|ts3server:\/\/)[^\s<>\[\]]+/gi;
    let start = 0;
    for (const m of value.matchAll(urls)) {
      result.push(value.slice(start, m.index));
      let raw = m[0].replace(/[.,!?;:]+$/, "");
      while (
        raw.endsWith(")") &&
        (raw.match(/\)/g)?.length || 0) > (raw.match(/\(/g)?.length || 0)
      )
        raw = raw.slice(0, -1);
      const url = safeUrl(raw);
      result.push(url ? link(url, short(raw), result.length) : raw);
      result.push(m[0].slice(raw.length));
      if (url && /^https?:/.test(url) && imageExtension.test(url))
        images.add(url);
      start = m.index! + m[0].length;
    }
    result.push(value.slice(start));
  };
  if (depth >= 16) {
    plain(text);
    return result;
  }
  const tags = /\[(URL|IMG|B|I|U|S|COLOR)(?:=([^\]\r\n]*))?\]/gi;
  let cursor = 0;
  for (let match = tags.exec(text); match; match = tags.exec(text)) {
    const tag = match[1].toUpperCase();
    const closing = new RegExp(`\\[(/?)${tag}(?:=[^\\]\\r\\n]*)?\\]`, "gi");
    closing.lastIndex = tags.lastIndex;
    let level = 1,
      end: RegExpExecArray | null = null;
    for (let next = closing.exec(text); next; next = closing.exec(text)) {
      level += next[1] ? -1 : 1;
      if (!level) {
        end = next;
        break;
      }
    }
    if (!end) continue;
    plain(text.slice(cursor, match.index));
    const inner = text.slice(tags.lastIndex, end.index);
    const whole = text.slice(match.index, closing.lastIndex);
    const key = result.length;
    if (tag === "URL" || tag === "IMG") {
      const url = safeUrl(tag === "URL" ? (match[2] ?? inner) : inner);
      if (!url || inLink || (tag === "IMG" && !/^https?:/.test(url)))
        result.push(whole);
      else {
        result.push(
          link(
            url,
            tag === "IMG"
              ? "Otevřít obrázek"
              : match[2]
                ? renderMessage(inner, images, true, depth + 1)
                : short(inner),
            key,
          ),
        );
        if (tag === "IMG") images.add(url);
      }
    } else {
      const children = renderMessage(inner, images, inLink, depth + 1);
      if (tag === "B") result.push(<strong key={key}>{children}</strong>);
      if (tag === "I") result.push(<em key={key}>{children}</em>);
      if (tag === "U") result.push(<u key={key}>{children}</u>);
      if (tag === "S") result.push(<s key={key}>{children}</s>);
      if (tag === "COLOR")
        result.push(
          <span key={key} style={{ color: readableColor(match[2] || "") }}>
            {children}
          </span>,
        );
    }
    cursor = closing.lastIndex;
    tags.lastIndex = cursor;
  }
  plain(text.slice(cursor));
  return result;
}
function attachment(text: string): ReactNode | string {
  try {
    const data: unknown = JSON.parse(text);
    if (
      !data ||
      typeof data !== "object" ||
      !("msg_type" in data) ||
      typeof data.msg_type !== "string" ||
      !data.msg_type.startsWith("ts.")
    )
      return text;
    const msg = data as Record<string, unknown>;
    if (msg.msg_type !== "ts.file.myts")
      return typeof msg.body === "string"
        ? msg.body
        : "Zpráva z novějšího TeamSpeaku, kterou Mluvka neumí zobrazit";
    const name =
      typeof msg.file_name === "string"
        ? msg.file_name.slice(0, 512)
        : "Příloha";
    const size =
      typeof msg.file_size === "number" &&
      Number.isFinite(msg.file_size) &&
      msg.file_size >= 0
        ? msg.file_size
        : undefined;
    const formatted =
      size === undefined
        ? ""
        : size >= 1e6
          ? `${(size / 1e6).toLocaleString("cs", { maximumFractionDigits: 1 })} MB`
          : `${Math.max(1, Math.round(size / 1000)).toLocaleString("cs")} kB`;
    return (
      <div className="ts-attachment">
        <span aria-hidden="true">
          {imageExtension.test(name) ? "🖼️" : "📎"}
        </span>
        <div>
          <strong>
            {name}
            {formatted && ` · ${formatted}`}
          </strong>
          <p>
            {imageExtension.test(name) ? "Obrázek" : "Soubor"} poslaný z
            TeamSpeak 5/6, otevři ho v TeamSpeak klientu
          </p>
        </div>
      </div>
    );
  } catch {
    return text;
  }
}
function Preview({ url, open }: { url: string; open: (url: string) => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? null : (
    <button
      type="button"
      className="image-preview"
      aria-label="Otevřít obrázek"
      onClick={() => open(url)}
    >
      <img
        src={url}
        alt="Obrázek v chatu"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </button>
  );
}
export function ChatMessage({ text }: { text: string }) {
  const [opened, setOpened] = useState<string>();
  const parsed = attachment(text);
  if (typeof parsed !== "string") return parsed;
  const images = new Set<string>();
  const content = renderMessage(parsed, images);
  return (
    <>
      <p className="message-text">{content}</p>
      <div className="message-images">
        {[...images].slice(0, 8).map((url) => (
          <Preview key={url} url={url} open={setOpened} />
        ))}
      </div>
      {opened && (
        <ImageViewer url={opened} close={() => setOpened(undefined)} />
      )}
    </>
  );
}
function ImageViewer({ url, close }: { url: string; close: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    distance: 0,
    scale: 1,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    moved: false,
    pinched: false,
  });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        event.preventDefault();
        dialog.current?.focus();
      }
    };
    document.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label="Prohlížeč obrázku"
      onClick={() => {
        if (!gesture.current.moved) close();
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const points = [...pointers.current.values()];
        if (points.length === 1)
          gesture.current = {
            distance: 0,
            scale: view.scale,
            x: view.x,
            y: view.y,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            pinched: false,
          };
        if (points.length === 2) {
          gesture.current.distance = Math.hypot(
            points[0].x - points[1].x,
            points[0].y - points[1].y,
          );
          gesture.current.scale = view.scale;
          gesture.current.pinched = true;
          gesture.current.moved = true;
        }
      }}
      onPointerMove={(e) => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const points = [...pointers.current.values()],
          g = gesture.current;
        const dx = e.clientX - g.startX,
          dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) > 8) g.moved = true;
        if (points.length === 2 && g.distance)
          setView((v) => ({
            ...v,
            scale: Math.max(
              1,
              Math.min(
                5,
                (g.scale *
                  Math.hypot(
                    points[0].x - points[1].x,
                    points[0].y - points[1].y,
                  )) /
                  g.distance,
              ),
            ),
          }));
        else if (!g.pinched && g.scale > 1)
          setView((v) => ({ ...v, x: g.x + dx, y: g.y + dy }));
      }}
      onPointerUp={(e) => {
        pointers.current.delete(e.pointerId);
        const g = gesture.current;
        if (
          !g.pinched &&
          g.scale === 1 &&
          e.clientY - g.startY > 80 &&
          Math.abs(e.clientX - g.startX) < 100
        )
          close();
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        gesture.current.moved = true;
      }}
      onWheel={(e) =>
        setView((v) => ({
          ...v,
          scale: Math.max(1, Math.min(5, v.scale - e.deltaY * 0.005)),
        }))
      }
    >
      <button
        type="button"
        className="viewer-close"
        aria-label="Zavřít obrázek"
        onClick={close}
      >
        ×
      </button>
      <img
        src={url}
        alt="Obrázek v plné velikosti"
        referrerPolicy="no-referrer"
        draggable={false}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      />
      <span className="viewer-hint">
        Přiblížit dvěma prsty · zavřít klepnutím, tažením dolů nebo Esc
      </span>
    </div>
  );
}
