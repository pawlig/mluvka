import { useEffect, useRef, useState } from "react";
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
    let blob = await encode("image/webp");
    if (blob.type !== "image/webp") blob = await encode("image/jpeg");
    if (blob.size > 10 * 1024 * 1024)
      throw Error("Obrázek po zmenšení přesahuje 10 MB.");
    return blob;
  } finally {
    bitmap.close();
  }
}
export function ImageComposer({
  text,
  setText,
  send,
  token,
  active,
  thread,
}: {
  text: string;
  setText: (text: string) => void;
  send: (text: string) => void;
  token: string;
  active: boolean;
  thread: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Blob>();
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const revision = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const busyRef = useRef(false);
  function cancel() {
    ++revision.current;
    abort.current?.abort();
    busyRef.current = false;
    setPending(undefined);
    setError("");
    setBusy(false);
  }
  useEffect(() => {
    cancel();
  }, [token, thread, active]);
  useEffect(
    () => () => {
      ++revision.current;
      abort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!pending) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(pending);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);
  async function choose(file?: File) {
    if (!file || busyRef.current || !active) return;
    const version = ++revision.current;
    setError("");
    setBusy(true);
    busyRef.current = true;
    try {
      const blob = await prepare(file);
      if (version === revision.current) setPending(blob);
    } catch {
      if (version === revision.current)
        setError(
          "Obrázek nelze připravit. Použij PNG, JPEG, WebP nebo GIF (do 8 MB), ostatní obrázky do 50 MB.",
        );
    } finally {
      if (version === revision.current) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  // Schránka i drop platí pro celý panel, nikoli jen pro textové pole.
  useEffect(() => {
    const panel = input.current?.closest(".chat-panel");
    if (!panel) return;
    const paste = (event: Event) => {
      const e = event as ClipboardEvent;
      const file = [...(e.clipboardData?.items || [])]
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (file) {
        e.preventDefault();
        void choose(file);
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
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      setDragging(false);
      void choose(file);
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
  async function submit() {
    if (busyRef.current || !active || (!text.trim() && !pending)) return;
    setError("");
    if (new TextEncoder().encode(text).length > (pending ? 3000 : 4000)) {
      setError("Zpráva je příliš dlouhá. Zkrať text a zkus to znovu.");
      return;
    }
    if (!pending) {
      send(text);
      return;
    }
    if (!token) {
      setError("Připojení se obnovuje. Zkus obrázek poslat za chvíli.");
      return;
    }
    const version = revision.current;
    setBusy(true);
    busyRef.current = true;
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await fetch("/api/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": pending.type,
        },
        body: pending,
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error(
          response.status === 429
            ? "Příliš mnoho obrázků. Počkej 5 minut."
            : response.status === 413
              ? "Obrázek je příliš velký."
              : response.status === 401
                ? "Připojení vypršelo. Připoj se znovu."
                : "Obrázek se nepodařilo nahrát. Zkus to znovu.",
        );
      const { url } = await response.json();
      if (version !== revision.current) return;
      const message = `${text.trim() ? `${text.trim()}\n` : ""}[IMG]${url}[/IMG]`;
      if (new TextEncoder().encode(message).length > 4000)
        throw Error("Zpráva je příliš dlouhá. Zkrať doprovodný text.");
      send(message);
      setPending(undefined);
    } catch (e) {
      if (version === revision.current)
        setError(e instanceof Error ? e.message : "Nahrání selhalo.");
    } finally {
      if (version === revision.current) {
        setBusy(false);
        busyRef.current = false;
      }
    }
  }
  return (
    <>
      {dragging && <div className="drop-hint">Pusť obrázek do chatu</div>}
      <div className="image-compose">
        {pending && (
          <div className="pending-image">
            {preview && <img src={preview} alt="Náhled před odesláním" />}
            <div>
              <strong>Obrázek je připravený</strong>
              <span>Můžeš připsat zprávu.</span>
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
            accept="image/*"
            aria-label="Vybrat obrázek"
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="attach-image"
            aria-label="Přidat obrázek"
            title="Přidat obrázek"
            disabled={busy || !active}
            onClick={() => input.current?.click()}
          >
            📎
          </button>
          <input
            aria-label="Zpráva"
            value={text}
            maxLength={2000}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              pending
                ? "Volitelná zpráva k obrázku…"
                : `Napsat ${thread.startsWith("channel:") ? "do kanálu" : thread === "server" ? "na server" : "soukromou zprávu"}…`
            }
          />
          <button
            className={pending ? "send-image" : undefined}
            aria-label={pending ? "Odeslat obrázek" : "Odeslat zprávu"}
            title={busy ? "Připravuji obrázek…" : "Odeslat"}
            disabled={busy || !active || (!text.trim() && !pending)}
            type="submit"
          >
            {busy ? "…" : pending ? "Odeslat" : <Icon name="send" size={20} />}
          </button>
          <span>{busy ? "PŘIPRAVUJI OBRÁZEK…" : "ENTER PRO ODESLÁNÍ"}</span>
        </form>
      </div>
    </>
  );
}
