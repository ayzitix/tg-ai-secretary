const NOTIFY_MARKER = /(?:^|\n)[ \t]*\[NOTIFY\][ \t]*([\s\S]*)$/i;
const MAX_SUMMARY_LENGTH = 800;

const FORWARD_PATTERNS: RegExp[] = [
  /(?:^|[^\p{L}])(передай|передайте|перекажи|перекажіть)(?!\p{L})/iu,
  /(?:^|[^\p{L}])(повідом|повідомте|повідомити)(?!\p{L})/iu,
  /(?:^|[^\p{L}])(скажи|скажіть|напиши|напишіть)\s+(йому|їй|олексію)(?!\p{L})/iu,
  /нехай\s+(зв[’']яжеться|подзвонить|зателефонує|напише)(?!\p{L})/iu,
];

const AFFIRMATIVE = new Set([
  "так",
  "ага",
  "ок",
  "окей",
  "добре",
  "звісно",
  "давай",
  "згоден",
  "згодна",
  "підходить",
]);

export function isForwardRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length > 0 && words.length <= 3 && words.every((word) => AFFIRMATIVE.has(word))) {
    return true;
  }

  return FORWARD_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface ParsedReply {
  text: string;
  notify: string | null;
}

export function parseReply(raw: string): ParsedReply {
  const match = NOTIFY_MARKER.exec(raw);
  if (!match || match.index === undefined) {
    return { text: raw.trim(), notify: null };
  }

  const text = raw.slice(0, match.index).trim();
  const summary = (match[1] ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_LENGTH);
  return { text, notify: summary || null };
}

export interface OwnerNotification {
  title?: string | null;
  username?: string | null;
  chatId: number;
  summary: string;
}

export function formatOwnerNotification(input: OwnerNotification): string {
  const username = input.username?.trim().replace(/^@/, "") || null;
  const handle = username ? `@${username}` : null;
  const title = input.title?.trim() || null;

  const who = title && handle ? `${title} (${handle})` : title || handle || `Чат ${input.chatId}`;
  const link = username ? `https://t.me/${username}` : `tg://user?id=${input.chatId}`;

  return `${who} просить передати:\n\n${input.summary}\n\nВідкрити чат: ${link}`;
}
