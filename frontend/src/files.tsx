import { useState } from "react";
export function cleanName(name: string) {
  return (
    [...name]
      .filter(
        (c) =>
          !/[\u0000-\u001f\u007f/\\:*?"<>|\[\]\u202a-\u202e\u2066-\u2069]/.test(
            c,
          ),
      )
      .slice(0, 120)
      .join("")
      .trim()
      .replace(/^\.+|\.+$/g, "") || "soubor"
  );
}

export const fileExtension =
  /\.(zip|7z|rar|tar|gz|bz2|xz|pdf|docx?|xlsx?|pptx?|odt|ods|txt|csv|rtf|epub|json)(?:\?[^#]*)?(?:#.*)?$/i;
export function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  const unit = size >= 1024 * 1024 ? "MB" : "kB";
  return `${(size / (unit === "MB" ? 1024 * 1024 : 1024)).toLocaleString("cs", { maximumFractionDigits: 1 })} ${unit}`;
}
export function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|avif|svg|heic)$/i.test(name)) return "🖼️";
  if (/\.(zip|7z|rar|tar|gz|bz2|xz)$/i.test(name)) return "🗜️";
  if (/\.(pdf|docx?|xlsx?|pptx?|odt|ods|txt|csv|rtf|epub)$/i.test(name))
    return "📄";
  if (/\.(mp3|wav|ogg|opus|flac|m4a|aac)$/i.test(name)) return "🎵";
  if (/\.(mp4|webm|mkv|mov|avi)$/i.test(name)) return "🎬";
  return "📎";
}
export type FileContext = {
  token: string;
  server: string;
  channels: { id: number; name: string }[];
};
function serverAddress(value: string) {
  try {
    const u = new URL(`ts3file://${value}`);
    return `${u.hostname.toLowerCase().replace(/\.$/, "")}:${u.port || "9987"}`;
  } catch {
    return "";
  }
}
export function isFileUrl(url: string) {
  try {
    const u = new URL(url);
    return (
      u.protocol === "ts3file:" ||
      (u.origin === location.origin && /^\/f\/[\w-]{43}\//.test(u.pathname)) ||
      (u.protocol === "https:" && fileExtension.test(url))
    );
  } catch {
    return false;
  }
}
export function FileCard({
  url,
  label,
  context,
}: {
  url: string;
  label?: string;
  context: FileContext;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const u = new URL(url),
    ts = u.protocol === "ts3file:";
  let name = label || "Soubor",
    size: number | undefined;
  try {
    name = ts
      ? u.searchParams.get("filename") || name
      : decodeURIComponent(u.pathname.split("/").pop() || name);
  } catch {
    /* Zůstane bezpečný popisek. */
  }
  const channel = Number(u.searchParams.get("channel"));
  const port = u.searchParams.get("port") || u.port || "9987";
  const other =
    ts &&
    serverAddress(`${u.hostname}:${port}`) !== serverAddress(context.server);
  const path = u.searchParams.get("path") || "";
  const invalid =
    ts &&
    (!path.startsWith("/") ||
      path.split("/").some((p) => p === "." || p === "..") ||
      /[/\\\u0000-\u001f]/.test(name) ||
      name === ".." ||
      name === "." ||
      !channel ||
      path.length > 1024 ||
      name.length > 512);
  if (ts && u.searchParams.has("size")) {
    const n = Number(u.searchParams.get("size"));
    if (Number.isFinite(n) && n >= 0) size = n;
  }
  // Velikost vlastní přílohy je součástí BBCode popisku, bez dalšího HTTP požadavku.
  const ownSize = !ts && label?.match(/\(([^()]*(?:B|kB|MB))\)$/)?.[1];
  async function download() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/ts-file?${new URLSearchParams({ url })}`,
        { headers: { Authorization: `Bearer ${context.token}` } },
      );
      if (!response.ok) throw Error(await response.text());
      const blob = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = blob;
      a.download = cleanName(name);
      a.click();
      setTimeout(() => URL.revokeObjectURL(blob), 60000);
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Přenos se přerušil. Zkontroluj síť a TCP port souborového přenosu TS serveru."
          : e instanceof Error
            ? e.message
            : "Stažení selhalo.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="file-card">
      <span className="file-icon" aria-hidden="true">
        {fileIcon(name)}
      </span>
      <span className="file-details">
        <strong>{name}</strong>
        {(size !== undefined || ownSize) && (
          <span className="file-size">
            {size !== undefined ? fileSize(size) : ownSize}
          </span>
        )}
        <span className="file-source">
          {ts
            ? other
              ? "Soubor z jiného serveru"
              : invalid
                ? "Neplatná cesta k souboru"
                : `Soubor kanálu ${context.channels.find((c) => c.id === channel)?.name || channel}`
            : u.origin === location.origin
              ? "Soubor z Mluvky"
              : "Externí odkaz na soubor"}
        </span>
        {error && (
          <span role="alert" className="upload-error">
            {error}
          </span>
        )}
      </span>
      {ts ? (
        !other &&
        !invalid && (
          <button
            type="button"
            disabled={busy || !context.token}
            onClick={() => void download()}
          >
            {busy ? "Stahuji…" : "Stáhnout"}
          </button>
        )
      ) : (
        <a
          href={url}
          download={u.origin === location.origin}
          target={u.origin === location.origin ? undefined : "_blank"}
          rel="noopener noreferrer nofollow"
        >
          {u.origin === location.origin ? "Stáhnout" : "Otevřít odkaz"}
        </a>
      )}
    </span>
  );
}
