export const REGISTRY_ID = "global";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  GROQ_API_KEY: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  OWNER_TELEGRAM_ID?: string;
  OWNER_NAME?: string;
  DELAY_MINUTES?: string;
  HISTORY_TTL_DAYS?: string;
  AWAY_DELAY_SECONDS?: string;
  PRESENCE_TTL_SECONDS?: string;
  PRESENCE_ENABLED?: string;
  PRESENCE_TOKEN?: string;
  ACCOUNT_AGENT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
}

export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function ownerTelegramId(env: Env): number | null {
  const parsed = Number(env.OWNER_TELEGRAM_ID);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function presenceEnabled(env: Env): boolean {
  return (env.PRESENCE_ENABLED ?? "").toLowerCase() === "true";
}
