export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    wave: (
      <>
        <path d="M3 14v-4m5 9V5m5 16V3m5 14V7m5 7v-4" />
      </>
    ),
    mic: (
      <>
        <rect x="8" y="2" width="8" height="13" rx="4" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
      </>
    ),
    micOff: (
      <>
        <path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2m2-4V5a4 4 0 0 0-7-2M5 10v2a7 7 0 0 0 12 5M12 19v3m-4 0h8" />
      </>
    ),
    headphones: (
      <>
        <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
        <rect x="3" y="12" width="4" height="9" rx="2" />
        <rect x="17" y="12" width="4" height="9" rx="2" />
      </>
    ),
    deaf: (
      <>
        <path d="m3 3 18 18M4 8a9 9 0 0 0-1 4v5m6-14a9 9 0 0 1 12 9v5" />
        <path d="M3 12h4v9H3zm14 6v3h4" />
      </>
    ),
    channel: (
      <>
        <path d="m5 7 14 0M4 17h14M10 3 6 21M18 3l-4 18" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="12" rx="3" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" />
      </>
    ),
    chat: <path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z" />,
    settings: (
      <>
        <path d="m9 3 6 0 1 3 3 1 2 5-2 2v4l-5 3-3-2-4 1-4-4 1-4-1-3 4-4Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    leave: (
      <>
        <path d="M9 3H4v18h5m5-14 5 5-5 5m-7-5h13" />
      </>
    ),
    send: <path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 22v-3a8 8 0 0 1 16 0v3" />
      </>
    ),
    server: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6h.01M7 17h.01m4-11h6m-6 11h6" />
      </>
    ),
    moon: <path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10h.01" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.user}
    </svg>
  );
}
