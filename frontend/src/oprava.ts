// Úprava odeslaných zpráv: TS3 zprávu upravit neumí, proto odchází nová zpráva
//   ✎ oprava „<začátek původního textu>“: <nový text>
// a Mluvka ji u svých uživatelů zobrazí místo původní zprávy.
const QUOTE_LENGTH = 40;
const PREFIX = "✎ oprava „";
const imageUrl = /\.(png|jpe?g|gif|webp|avif|bmp)(?:[?#]|$)/i;

export interface Correction {
  quote: string;
  text: string;
}
export interface Corrigible {
  thread: string;
  from: number;
  uid?: string;
  text: string;
  edited?: boolean;
}

/** Zalomení řádků → mezera, uvozovky „ “ → ". */
export function normalizeQuote(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").replace(/[„“]/g, '"');
}
export function formatCorrection(shown: string, next: string): string {
  const points = [...normalizeQuote(shown)];
  const quote =
    points.length > QUOTE_LENGTH
      ? `${points.slice(0, QUOTE_LENGTH).join("")}…`
      : points.join("");
  return `${PREFIX}${quote}“: ${next}`;
}
export function parseCorrection(text: string): Correction | null {
  const match = /^✎ oprava „([^„“]+)“: ([\s\S]+)$/.exec(text);
  if (!match) return null;
  const quote = match[1].endsWith("…") ? match[1].slice(0, -1) : match[1];
  if (!quote || !match[2].trim()) return null;
  return { quote, text: match[2] };
}
function sameSender(a: Corrigible, b: { from: number; uid?: string }) {
  return a.uid && b.uid ? a.uid === b.uid : a.from === b.from;
}
/** Index nejnovější zprávy téhož odesílatele ve vlákně, kterou oprava cituje. */
export function findOriginal(
  messages: readonly Corrigible[],
  correction: Correction,
  sender: { from: number; uid?: string },
  thread: string,
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.thread === thread &&
      sameSender(m, sender) &&
      normalizeQuote(m.text).startsWith(correction.quote)
    )
      return i;
  }
  return -1;
}
/** Nahradí citovanou zprávu opravou; `null`, když původní zpráva chybí. */
export function applyCorrection<T extends Corrigible>(
  messages: readonly T[],
  correction: Correction,
  sender: { from: number; uid?: string },
  thread: string,
): T[] | null {
  const index = findOriginal(messages, correction, sender, thread);
  if (index < 0) return null;
  return messages.map((m, i) =>
    i === index ? { ...m, text: correction.text, edited: true } : m,
  );
}
/** Upravit jde jen čistě textová zpráva (bez přílohy, obrázku, souborové karty). */
export function editable(
  text: string,
  isFileUrl: (url: string) => boolean,
): boolean {
  if (!text.trim() || text.includes("📎") || /\[(IMG|URL)/i.test(text))
    return false;
  if (text.trimStart().startsWith("{") && text.includes('"msg_type"'))
    return false;
  for (const m of text.matchAll(/(?:https?|ts3file):\/\/[^\s<>[\]]+/gi))
    if (imageUrl.test(m[0]) || isFileUrl(m[0])) return false;
  return true;
}
