import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import type { Login } from "./types";

export interface Invitation {
  v: 1;
  server: string;
  password?: string;
  channel?: string;
  channelPassword?: string;
  name?: string;
}
export function decodeInvitation(value: string): Invitation {
  const url = new URL(value, location.href);
  if (!/^https?:$/.test(url.protocol) || !url.hash.startsWith("#pozvanka="))
    throw Error("invalid");
  const encoded = url.hash.slice(10);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 16000)
    throw Error("invalid");
  const bytes = Uint8Array.from(
    atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const data = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !data ||
    data.v !== 1 ||
    typeof data.server !== "string" ||
    !data.server.trim() ||
    data.server.length > 512 ||
    /[\s\/?#@]/.test(data.server)
  )
    throw Error("invalid");
  const result: Invitation = { v: 1, server: data.server };
  for (const key of [
    "password",
    "channel",
    "channelPassword",
    "name",
  ] as const) {
    if (
      data[key] !== undefined &&
      (typeof data[key] !== "string" || data[key].length > 1024)
    )
      throw Error("invalid");
    if (data[key]) result[key] = data[key];
  }
  return result;
}
export function readInvitation(): { invitation?: Invitation; error?: string } {
  if (!location.hash.startsWith("#pozvanka")) return {};
  const url = location.href;
  // Odstranit ještě před vykreslením a připojením; fragment nikdy nejde přes HTTP.
  history.replaceState(null, "", location.pathname + location.search);
  try {
    return { invitation: decodeInvitation(url) };
  } catch {
    return {
      error: "Pozvánka je neplatná nebo poškozená. Vyplňte připojení ručně.",
    };
  }
}
export function invitationLogin(
  invitation: Invitation,
  nickname: string,
): Login {
  return {
    nickname,
    server: invitation.server,
    password: invitation.password || "",
    channel: invitation.channel || "",
    channel_password: invitation.channelPassword || "",
    remember: true,
    passwords: true,
    auto: true,
  };
}
function encodeInvitation(data: Invitation) {
  const json = JSON.stringify(data);
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${location.origin}/#pozvanka=${encoded}`;
}
export function InvitationDetails({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return active ? (
    <details className="invitation-details">
      <summary>Upravit podrobnosti</summary>
      {children}
    </details>
  ) : (
    <>{children}</>
  );
}
export function InviteDialog({
  login,
  name,
  close,
}: {
  login: Login;
  name: string;
  close: () => void;
}) {
  const [password, setPassword] = useState(!!login.password);
  const [channel, setChannel] = useState(true);
  const [channelPassword, setChannelPassword] = useState(false);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const url = encodeInvitation({
    v: 1,
    server: login.server,
    ...(name ? { name } : {}),
    ...(password && login.password ? { password: login.password } : {}),
    ...(channel && login.channel ? { channel: login.channel } : {}),
    ...(channel && channelPassword && login.channel_password
      ? { channelPassword: login.channel_password }
      : {}),
  });
  useEffect(() => {
    let active = true;
    setQr("");
    void QRCode.toDataURL(url, {
      width: 280,
      margin: 4,
      errorCorrectionLevel: "M",
    })
      .then((value) => {
        if (active) setQr(value);
      })
      .catch(() => {
        if (active)
          setStatus("Odkaz je pro QR kód příliš dlouhý. Zkopírujte ho.");
      });
    return () => {
      active = false;
    };
  }, [url]);
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal invite-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pozvat na server"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <div className="eyebrow">SPOLU NA JEDNÉ FREKVENCI</div>
            <h2>Pozvat na server</h2>
          </div>
          <button aria-label="Zavřít pozvánku" onClick={close}>
            ×
          </button>
        </header>
        <p>{name}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={password}
            disabled={!login.password}
            onChange={(e) => setPassword(e.target.checked)}
          />
          Včetně hesla serveru
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={channel}
            onChange={(e) => setChannel(e.target.checked)}
          />
          Rovnou do mého kanálu
        </label>
        {channel && login.channel_password && (
          <label className="check">
            <input
              type="checkbox"
              checked={channelPassword}
              onChange={(e) => setChannelPassword(e.target.checked)}
            />
            I heslo kanálu
          </label>
        )}
        {((password && login.password) ||
          (channel && channelPassword && login.channel_password)) && (
          <p className="invite-warning">
            {password && login.password
              ? "Odkaz obsahuje heslo serveru"
              : "Odkaz obsahuje heslo kanálu"}{" "}
            — posílej ho jen lidem, kterým věříš.
          </p>
        )}
        <label>
          Odkaz pozvánky
          <textarea
            aria-label="Odkaz pozvánky"
            readOnly
            value={url}
            rows={3}
            onFocus={(e) => e.target.select()}
          />
        </label>
        {qr && (
          <figure className="invite-qr">
            <img src={qr} alt="QR kód pozvánky" width="280" height="280" />
            <figcaption>Naskenuj telefonem a přidej se.</figcaption>
          </figure>
        )}
        <p role="status">{status}</p>
        <footer>
          <button
            className="primary"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(url)
                .then(() => setStatus("Odkaz zkopírován."))
                .catch(() => setStatus("Označte a zkopírujte odkaz ručně."));
              if (!navigator.clipboard)
                setStatus("Označte a zkopírujte odkaz ručně.");
            }}
          >
            Kopírovat
          </button>
          {!!navigator.share && (
            <button
              className="secondary"
              onClick={() =>
                void navigator
                  .share({ title: `Pozvánka na ${name}`, url })
                  .catch(() => {})
              }
            >
              Sdílet
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
export function PasteInvitation({
  accept,
  close,
}: {
  accept: (url: string) => void;
  close: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Vložit pozvánku"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Vložit pozvánku</h2>
          <button aria-label="Zavřít vložení pozvánky" onClick={close}>
            ×
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            accept(value.trim());
          }}
        >
          <label>
            Odkaz pozvánky
            <textarea
              aria-label="Odkaz pozvánky"
              autoFocus
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Podržte a vložte odkaz ze schránky"
              rows={4}
            />
          </label>
          {!!navigator.clipboard?.readText && (
            <button
              type="button"
              className="secondary"
              onClick={() =>
                void navigator.clipboard
                  .readText()
                  .then(setValue)
                  .catch(() => {})
              }
            >
              Načíst ze schránky
            </button>
          )}
          <button className="primary" type="submit">
            Otevřít pozvánku
          </button>
        </form>
      </section>
    </div>
  );
}
