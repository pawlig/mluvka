import { useEffect, useRef, useState } from "react";
import { fileSize, cleanName, fileCount } from "./files";
import { Icon } from "./Icon";

async function prepare(file: File): Promise<Blob> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const gif = String.fromCharCode(...header.slice(0, 6));
  if (gif === "GIF89a" || gif === "GIF87a") {
    if (file.size > 8 * 1024 * 1024)
      throw Error("Animovaný GIF může mít nejvýše 8 MB.");
    return new Blob([file], { type: "image/gif" });
  }
  if (file.size > 50 * 1024 * 1024)
    throw Error("Vyber obrázek menší než 50 MB.");
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const factor = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * factor));
    canvas.height = Math.max(1, Math.round(bitmap.height * factor));
    const context = canvas.getContext("2d");
    if (!context) throw Error("Obrázek nelze připravit.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (type: string) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(Error("Obrázek nelze zmenšit.")),
          type,
          0.85,
        ),
      );
    // Průhlednost a omezenou paletu zachová PNG, fotografie komprimuje JPEG.
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    let transparent = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] !== 255) {
        transparent = true;
        break;
      }
      if (colors.size <= 256)
        colors.add(
          ((pixels[i] >> 3) << 10) |
            ((pixels[i + 1] >> 3) << 5) |
            (pixels[i + 2] >> 3),
        );
    }
    const blob = await encode(
      transparent || colors.size <= 256 ? "image/png" : "image/jpeg",
    );
    if (blob.size > 10 * 1024 * 1024)
      throw Error("Obrázek po zmenšení přesahuje 10 MB.");
    return blob;
  } finally {
    bitmap.close();
  }
}
type Pending = { blob: Blob; name: string; image: boolean };
export function ImageComposer({
  text,
  setText,
  send,
  editing,
  editLast,
  cancelEdit,
  token,
  active,
  thread,
}: {
  text: string;
  setText: (text: string) => void;
  send: (text: string) => void;
  editing: boolean;
  editLast: () => void;
  cancelEdit: () => void;
  token: string;
  active: boolean;
  thread: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const revision = useRef(0);
  const abort = useRef<XMLHttpRequest | undefined>(undefined);
  const busyRef = useRef(false);
  function cancel() {
    ++revision.current;
    abort.current?.abort();
    busyRef.current = false;
    setPending([]);
    setError("");
    setBusy(false);
    setProgress(undefined);
  }
  useEffect(() => {
    cancel();
  }, [token, thread, active]);
  useEffect(() => {
    if (editing) {
      cancel();
      field.current?.focus();
    }
  }, [editing]);
  useEffect(
    () => () => {
      ++revision.current;
      abort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!pending[0]?.image) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(pending[0].blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);
  async function choose(files: File[]) {
    if (!files.length || busyRef.current || !active || editing) return;
    const version = ++revision.current;
    setError("");
    setBusy(true);
    busyRef.current = true;
    try {
      const selected: Pending[] = [];
      for (const file of files) {
        // Bitmapy zachovávají dosavadní resize a odstranění EXIF. Ostatní typy jsou přílohy.
        const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
        const marker = String.fromCharCode(...bytes);
        const image =
          (bytes[0] === 0x89 && marker.slice(1, 4) === "PNG") ||
          (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
          marker.startsWith("GIF89a") ||
          marker.startsWith("GIF87a") ||
          (marker.startsWith("RIFF") && marker.slice(8, 12) === "WEBP") ||
          marker.startsWith("BM") ||
          (marker.slice(4, 8) === "ftyp" &&
            /^(avif|avis|heic|heix|mif1)$/.test(marker.slice(8, 12)));
        selected.push({
          blob: image ? await prepare(file) : file,
          name: cleanName(file.name),
          image,
        });
      }
      if (version === revision.current) setPending(selected);
    } catch (e) {
      if (version === revision.current)
        setError(
          e instanceof DOMException
            ? "Obrázek nelze připravit. Použij PNG, JPEG, WebP nebo GIF."
            : e instanceof Error
              ? e.message
              : "Soubor nelze připravit.",
        );
    } finally {
      if (version === revision.current) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  useEffect(() => {
    const panel = input.current?.closest(".chat-panel");
    if (!panel) return;
    const paste = (event: Event) => {
      const e = event as ClipboardEvent;
      const files = [...(e.clipboardData?.files || [])];
      if (files.length) {
        e.preventDefault();
        void choose(files);
      }
    };
    const over = (event: Event) => {
      const e = event as DragEvent;
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    };
    const leave = (event: Event) => {
      if (!panel.contains((event as DragEvent).relatedTarget as Node))
        setDragging(false);
    };
    const drop = (event: Event) => {
      const e = event as DragEvent;
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      setDragging(false);
      void choose(files);
    };
    panel.addEventListener("paste", paste);
    panel.addEventListener("dragover", over);
    panel.addEventListener("dragleave", leave);
    panel.addEventListener("drop", drop);
    return () => {
      panel.removeEventListener("paste", paste);
      panel.removeEventListener("dragover", over);
      panel.removeEventListener("dragleave", leave);
      panel.removeEventListener("drop", drop);
    };
  }, [active]);
  function upload(file: Pending) {
    return new Promise<{ url: string; name?: string; size: number }>(
      (resolve, reject) => {
        const request = new XMLHttpRequest();
        abort.current = request;
        request.open("POST", "/api/upload");
        request.timeout = 180000;
        request.setRequestHeader("Authorization", `Bearer ${token}`);
        request.setRequestHeader(
          "Content-Type",
          file.image ? file.blob.type : "application/octet-stream",
        );
        if (!file.image)
          request.setRequestHeader(
            "X-File-Name",
            encodeURIComponent(file.name),
          );
        request.upload.onprogress = (e) => {
          if (busyRef.current && e.lengthComputable)
            setProgress(Math.round((e.loaded * 100) / e.total));
        };
        request.onerror = () =>
          reject(
            Error("Soubor se nepodařilo nahrát. Zkontroluj připojení k síti."),
          );
        request.ontimeout = () =>
          reject(Error("Nahrávání trvalo příliš dlouho. Zkus to znovu."));
        request.onabort = () => reject(Error("Nahrávání zrušeno."));
        request.onload = () => {
          if (request.status < 200 || request.status >= 300) {
            reject(
              Error(
                request.status === 429
                  ? "Příliš mnoho souborů. Počkej 5 minut."
                  : request.status === 413
                    ? "Soubor je příliš velký pro úložiště."
                    : request.status === 401
                      ? "Připojení vypršelo. Připoj se znovu."
                      : request.status === 507
                        ? "Úložiště nemá dost místa pro tento soubor."
                        : "Soubor se nepodařilo nahrát. Zkus to znovu.",
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(request.responseText));
          } catch {
            reject(Error("Server vrátil neplatnou odpověď."));
          }
        };
        request.send(file.blob);
      },
    );
  }
  async function submit() {
    if (busyRef.current || !active || (!text.trim() && !pending.length)) return;
    setError("");
    if (
      new TextEncoder().encode(text).length >
      (pending.length ? 2800 : editing ? 3800 : 4000)
    ) {
      setError("Zpráva je příliš dlouhá. Zkrať text a zkus to znovu.");
      return;
    }
    if (!pending.length) {
      send(text);
      return;
    }
    if (!token) {
      setError("Připojení se obnovuje. Zkus soubor poslat za chvíli.");
      return;
    }
    const version = revision.current;
    setBusy(true);
    busyRef.current = true;
    try {
      for (let i = 0; i < pending.length; i++) {
        setProgress(0);
        const file = pending[i],
          result = await upload(file);
        if (version !== revision.current) return;
        const url = result.url;
        const attachment = file.image
          ? url
          : `📎 ${result.name || file.name} (${fileSize(result.size)})\n${url}`;
        const message = `${i === 0 && text.trim() ? `${text.trim()}\n` : ""}${attachment}`;
        if (new TextEncoder().encode(message).length > 4000)
          throw Error("Zpráva je příliš dlouhá. Zkrať doprovodný text.");
        send(message);
        setPending((old) => old.slice(1));
      }
    } catch (e) {
      if (version === revision.current)
        setError(e instanceof Error ? e.message : "Nahrání selhalo.");
    } finally {
      if (version === revision.current) {
        setBusy(false);
        busyRef.current = false;
        setProgress(undefined);
      }
    }
  }
  const image = pending.length === 1 && pending[0].image;
  return (
    <>
      {dragging && <div className="drop-hint">Pusť soubory do chatu</div>}
      <div className="image-compose">
        {(pending.length > 0 || busy) && (
          <div className="pending-image">
            {preview && <img src={preview} alt="Náhled před odesláním" />}
            <div>
              <strong>
                {image
                  ? "Obrázek je připravený"
                  : pending.length
                    ? `${fileCount(pending.length)} · ${pending[0].name}`
                    : "Připravuji soubory…"}
              </strong>
              <span>
                {progress !== undefined
                  ? `Nahrávání ${progress} %`
                  : "Můžeš připsat zprávu."}
              </span>
              {progress !== undefined && (
                <progress
                  aria-label="Průběh nahrávání"
                  value={progress}
                  max={100}
                />
              )}
              <button type="button" onClick={cancel}>
                Zrušit
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="upload-error" role="alert">
            {error}
          </p>
        )}
        {editing && (
          <div className="edit-bar" role="status">
            <span>Upravujete zprávu · Esc zrušit</span>
            <button type="button" aria-label="Zrušit úpravu" onClick={cancelEdit}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            ref={input}
            className="image-file-input"
            type="file"
            multiple
            aria-label="Vybrat soubory"
            onChange={(e) => {
              void choose([...(e.target.files || [])]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="attach-image"
            aria-label="Přidat soubor"
            title="Přidat soubor nebo obrázek"
            disabled={busy || !active || editing}
            onClick={() => input.current?.click()}
          >
            📎
          </button>
          <input
            ref={field}
            aria-label="Zpráva"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape" && editing) {
                e.preventDefault();
                cancelEdit();
              } else if (
                e.key === "ArrowUp" &&
                !editing &&
                !text &&
                !pending.length
              ) {
                e.preventDefault();
                editLast();
              }
            }}
            value={text}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              pending.length
                ? "Volitelná zpráva k příloze…"
                : `Napsat ${thread.startsWith("channel:") ? "do kanálu" : thread === "server" ? "na server" : "soukromou zprávu"}…`
            }
          />
          <button
            className={pending.length ? "send-image" : undefined}
            aria-label={
              pending.length
                ? image
                  ? "Odeslat obrázek"
                  : "Odeslat soubory"
                : editing
                  ? "Uložit úpravu"
                  : "Odeslat zprávu"
            }
            title={editing ? "Uložit úpravu" : "Odeslat"}
            disabled={busy || !active || (!text.trim() && !pending.length)}
            type="submit"
          >
            {busy ? (
              "…"
            ) : pending.length ? (
              "Odeslat"
            ) : (
              <Icon name="send" size={20} />
            )}
          </button>
          <span>
            {progress !== undefined
              ? `NAHRÁVÁNÍ ${progress} %`
              : busy
                ? "PŘIPRAVUJI…"
                : "ENTER PRO ODESLÁNÍ"}
          </span>
        </form>
      </div>
    </>
  );
}
