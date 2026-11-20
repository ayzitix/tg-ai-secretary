import type { Env } from "./env";

export interface TgUser {
  id: number;
  is_bot?: boolean;
  is_premium?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  business_connection_id?: string;
  sender_business_bot?: TgUser;
  is_from_offline?: boolean;
}

export interface TgBusinessConnection {
  id: string;
  user: TgUser;
  user_chat_id: number;
  date: number;
  rights?: Record<string, boolean>;
  is_enabled: boolean;
}

export interface TgDeletedBusinessMessages {
  business_connection_id: string;
  chat: TgChat;
  message_ids: number[];
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  business_connection?: TgBusinessConnection;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: TgDeletedBusinessMessages;
}

interface ApiEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

const API_ROOT = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;

export async function callTelegram<T>(
  env: Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${API_ROOT}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data: ApiEnvelope<T>;
  try {
    data = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new TelegramError(`Telegram ${method}: non-JSON response`, response.status, 0);
  }

  if (!data.ok) {
    const retryAfter = Number(data.parameters?.retry_after ?? response.headers.get("retry-after") ?? 0);
    throw new TelegramError(
      `Telegram ${method} failed: ${data.description ?? response.status}`,
      data.error_code ?? response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
    );
  }

  return data.result as T;
}

export function splitText(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  for (const chunk of splitText(text)) {
    await callTelegram(env, "sendMessage", { chat_id: chatId, text: chunk });
  }
}

export async function sendBusinessMessage(
  env: Env,
  businessConnectionId: string,
  chatId: number,
  text: string,
): Promise<void> {
  for (const chunk of splitText(text)) {
    await callTelegram(env, "sendMessage", {
      business_connection_id: businessConnectionId,
      chat_id: chatId,
      text: chunk,
    });
  }
}

export async function sendBusinessTyping(
  env: Env,
  businessConnectionId: string,
  chatId: number,
): Promise<void> {
  await callTelegram(env, "sendChatAction", {
    business_connection_id: businessConnectionId,
    chat_id: chatId,
    action: "typing",
  });
}
