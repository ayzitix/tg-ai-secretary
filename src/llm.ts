import type { Env } from "./env";
import type { ChatMessage } from "./prompt";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly status: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REPLY_LENGTH = 3000;

export async function complete(env: Env, messages: ChatMessage[]): Promise<string> {
  if (!env.GROQ_API_KEY) {
    throw new LlmError("LLM API key is not configured", 0, 500);
  }

  const baseUrl = env.LLM_BASE_URL.replace(/\/+$/, "");
  const payload: Record<string, unknown> = {
    model: env.LLM_MODEL,
    messages,
    temperature: 0.8,
    max_tokens: 400,
  };
  // gpt-oss models spend output tokens on hidden reasoning; "low" keeps replies
  // fast and inside the free tier's tokens-per-minute budget.
  if (/gpt-oss/i.test(env.LLM_MODEL)) {
    payload.reasoning_effort = "low";
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GROQ_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const detail = await response.text().catch(() => "");
    const retry = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
    throw new LlmError(
      `LLM ${response.status}: ${detail.slice(0, 300)}`,
      retry,
      response.status,
    );
  }

  const data = (await response.json()) as CompletionResponse;
  const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
  const cleaned = sanitize(raw);
  if (!cleaned) {
    throw new LlmError("LLM returned an empty reply", 0, 502);
  }
  return cleaned;
}

export function sanitize(raw: string): string {
  let text = raw.trim();

  if (
    (text.startsWith('"') && text.endsWith('"') && text.length > 1) ||
    (text.startsWith("«") && text.endsWith("»") && text.length > 1)
  ) {
    text = text.slice(1, -1).trim();
  }

  text = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s+\n/g, "\n")
    .trim();

  if (text.length > MAX_REPLY_LENGTH) {
    const cut = Math.max(text.lastIndexOf(". ", MAX_REPLY_LENGTH), text.lastIndexOf("\n", MAX_REPLY_LENGTH));
    text = (cut > 0 ? text.slice(0, cut + 1) : text.slice(0, MAX_REPLY_LENGTH)).trim();
  }

  return text;
}
