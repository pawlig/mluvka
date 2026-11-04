import { useEffect, useRef, useState } from "react";
import type { AudioEngine } from "./audio";
import type { Settings } from "./types";

export interface NotificationTarget {
  thread: string;
  server: string;
  name: string;
}
type BadgeNavigator = Navigator & {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};
export function readNotificationTarget(): NotificationTarget | undefined {
  if (!location.hash.startsWith("#konverzace=")) return;
  const hash = location.hash.slice(12);
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const data = JSON.parse(decodeURIComponent(hash));
    if (
      typeof data.server === "string" &&
      typeof data.name === "string" &&
      /^(server|channel:\d+|private:\d+)$/.test(data.thread)
    )
      return data;
  } catch {
    /* Poškozený cíl nemění připojení. */
  }
}
export function useNotifications(
  audio: AudioEngine,
  settings: Settings,
  view: {
    thread: string;
    channel?: number;
    mobile: string;
    server: string;
    connected: boolean;
    title?: string;
  },
) {
  const [unread, setUnread] = useState<Record<string, number>>({});
  const latest = useRef({ settings, view });
  latest.current = { settings, view };
  const chatVisible = () =>
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    (!matchMedia("(max-width: 699px)").matches ||
      latest.current.view.mobile === "chat");
  useEffect(() => {
    const read = () => {
      if (!chatVisible()) return;
      const key = latest.current.view.thread;
      setUnread((old) => (old[key] ? { ...old, [key]: 0 } : old));
    };
    read();
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    const media = matchMedia("(max-width: 699px)");
    media.addEventListener("change", read);
    return () => {
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      media.removeEventListener("change", read);
    };
  }, [view.thread, view.mobile, view.connected]);
  useEffect(() => {
    setUnread((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => !key.startsWith("channel:")),
      ),
    );
  }, [view.channel]);
  useEffect(() => {
    if (!view.connected) setUnread({});
  }, [view.connected, view.server]);
  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  useEffect(() => {
    document.title = `${total ? `(${total}) ` : ""}Mluvka${view.title ? ` · ${view.title}` : ""}`;
    const nav = navigator as BadgeNavigator;
    try {
      const result = total ? nav.setAppBadge?.(total) : nav.clearAppBadge?.();
      void result?.catch(() => {});
    } catch {
      /* OS může odznaky zakázat. */
    }
  }, [total, view.title]);

  function receive(
    kind: "channel" | "server" | "private" | "poke",
    target: NotificationTarget,
    text: string,
    channelName?: string,
  ) {
    const { settings: s } = latest.current;
    const unseen =
      target.thread !== latest.current.view.thread || !chatVisible();
    if (kind !== "poke" && !unseen) return;
    if (kind !== "poke")
      setUnread((old) => ({
        ...old,
        [target.thread]: (old[target.thread] || 0) + 1,
      }));
    if (kind === "private" || kind === "poke") {
      try {
        navigator.vibrate?.(60);
      } catch {
        /* Vibrace jsou volitelné. */
      }
    }
    const enabled = {
      channel: s.notifyChannel,
      server: s.notifyServer,
      private: s.notifyPrivate,
      poke: s.notifyPoke,
    }[kind];
    if (enabled && !s.deafen && s.notifyVolume > 0)
      void audio.notify(kind === "poke" ? "poke" : "zprava");
    if (
      document.visibilityState !== "visible" &&
      s.systemNotifications &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      "serviceWorker" in navigator
    ) {
      // getRegistration nezůstane čekat jako ready, pokud je SW nedostupný.
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) =>
          reg?.showNotification(
            `${target.name}${kind === "poke" ? " · Šťouchnutí" : channelName ? ` · ${channelName}` : ""}`,
            {
              body: text.slice(0, 120),
              tag: `${target.server}:${kind === "poke" ? "poke:" : ""}${target.thread}`,
              icon: "/icons/192.png",
              data: target,
              ...(kind === "private" || kind === "poke"
                ? { renotify: true }
                : {}),
            },
          ),
        )
        .catch(() => {});
    }
  }
  function forget(key: string) {
    setUnread((old) => {
      const next = { ...old };
      delete next[key];
      return next;
    });
  }
  return { unread, total, receive, forget };
}
export function UnreadBadge({ count = 0 }: { count?: number }) {
  return count > 0 ? (
    <span className="unread-badge" aria-label={`${count} nepřečtených`}>
      {count > 99 ? "99+" : count}
    </span>
  ) : null;
}
