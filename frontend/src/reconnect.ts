// Rozprostře návrat více klientů po deployi. Zdroj náhody lze v testu nahradit.
export function reconnectDelay(attempt: number, random = Math.random): number {
  const jitter = Math.round(Math.min(1, Math.max(0, random())) * 10000);
  if (attempt <= 1) return jitter;
  return Math.min(30000, 1000 * 2 ** Math.min(attempt - 1, 5)) + jitter;
}
