import { useEffect, useRef, useState } from "react";
import { load, save } from "./types";

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
export function useServiceWorker(busy: boolean) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const registration = useRef<ServiceWorkerRegistration | undefined>(undefined);
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let disposed = false;
    const activate = () => {
      if (!busyRef.current)
        registration.current?.waiting?.postMessage({
          type: "ACTIVATE_WHEN_IDLE",
        });
    };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "CAN_UPDATE")
        event.ports[0]?.postMessage({ idle: !busyRef.current });
    };
    navigator.serviceWorker.addEventListener("message", message);
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        if (disposed) return;
        registration.current = reg;
        activate();
        reg.addEventListener("updatefound", () => {
          reg.installing?.addEventListener("statechange", activate);
        });
      })
      .catch(() => {
        /* Bez SW zůstává online aplikace funkční. */
      });
    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener("message", message);
    };
  }, []);
  useEffect(() => {
    if (!busy)
      registration.current?.waiting?.postMessage({
        type: "ACTIVATE_WHEN_IDLE",
      });
  }, [busy]);
  // controllerchange záměrně neobnovuje stránku, ani v jiném otevřeném tabu.
}
export function Install() {
  const [prompt, setPrompt] = useState<InstallEvent>();
  const [standalone, setStandalone] = useState(
    () =>
      matchMedia("(display-mode: standalone)").matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone,
  );
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const [hint, setHint] = useState(
    () => ios && !load("install-hint-dismissed", false),
  );
  useEffect(() => {
    const before = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallEvent);
    };
    const installed = () => {
      setStandalone(true);
      setPrompt(undefined);
    };
    const media = matchMedia("(display-mode: standalone)");
    const change = () => setStandalone(media.matches);
    window.addEventListener("beforeinstallprompt", before);
    window.addEventListener("appinstalled", installed);
    media.addEventListener("change", change);
    return () => {
      window.removeEventListener("beforeinstallprompt", before);
      window.removeEventListener("appinstalled", installed);
      media.removeEventListener("change", change);
    };
  }, []);
  if (standalone || (!prompt && !hint)) return null;
  return (
    <aside className="install-card" aria-label="Instalace Mluvky">
      <button
        className="secondary"
        onClick={() => {
          if (prompt)
            void prompt
              .prompt()
              .then(() => prompt.userChoice)
              .then(() => setPrompt(undefined))
              .catch(() => setPrompt(undefined));
          else setHint(true);
        }}
      >
        Přidat na plochu
      </button>
      {ios && hint && (
        <div className="install-hint">
          <span>V Safari: Sdílet → Přidat na plochu</span>
          <button
            aria-label="Zavřít nápovědu instalace"
            onClick={() => {
              setHint(false);
              save("install-hint-dismissed", true);
            }}
          >
            ×
          </button>
        </div>
      )}
    </aside>
  );
}
