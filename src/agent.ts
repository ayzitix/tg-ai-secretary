import type { ConnectionRow, MessageRow, PendingRow, SettingRow } from "./db";

import { initAgentSchema } from "./db";
import type { Env } from "./env";
import { intVar, presenceEnabled, REGISTRY_ID } from "./env";
import { LlmError, complete } from "./llm";
import { formatOwnerNotification, isForwardRequest, parseReply, type ParsedReply } from "./notify";
import { dueAtForMode, replyMode, resolvePresence, type DevicePresenceRow, type Presence } from "./presence";
import { buildMessages } from "./prompt";
import type { TgBusinessConnection, TgMessage } from "./telegram";
import { callTelegram, sendBusinessMessage, sendBusinessTyping, sendMessage, TelegramError } from "./telegram";

const BUSINESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DELAY_MINUTES = 5;
const CANCELLED_TTL_MS = 60 * 60 * 1000;

const HELP_TEXT = `Команди:
/status — стан підключення, присутність і черга
/away — я не онлайн: відповідати одразу
/back — авто-режим за маячком клієнта
/pause — не відповідати ніде
/resume — знову відповідати
/delay 10 — через скільки хвилин відповідати, якщо стан невідомий
/prompt <текст> — додаткові інструкції для ШІ
/prompt reset — прибрати інструкції
/forget — стерти збережену історію
/test-notify — надіслати тестове сповіщення
/help — цей список`;

export type AgentRequest =
  | { type: "connection"; connection: TgBusinessConnection }
  | { type: "business_message"; message: TgMessage }
  | { type: "deleted"; chatId: number }
  | { type: "command"; text: string; fromId: number }
  | { type: "owner_online" }
  | { type: "sweep" };

export interface AgentReply {
  ok: boolean;
  reply?: string;
  error?: string;
}

export class AccountAgent implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    initAgentSchema(this.sql);
  }

  async fetch(request: Request): Promise<Response> {
    let body: AgentRequest;
    try {
      body = (await request.json()) as AgentRequest;
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }

    try {
      switch (body.type) {
        case "connection":
          return json(await this.onConnection(body.connection));
        case "business_message":
          return json(await this.onBusinessMessage(body.message));
        case "deleted":
          this.cancelPending(body.chatId);
          return json({ ok: true });
        case "command":
          return json(await this.onCommand(body.text));
        case "owner_online":
          this.cancelAllPending();
          await this.scheduleNextAlarm();
          return json({ ok: true });
        case "sweep":
          await this.sweep();
          return json({ ok: true });
        default:
          return json({ ok: false, error: "unknown request" }, 400);
      }
    } catch (error) {
      console.error("agent request failed", error);
      return json({ ok: false, error: String(error) }, 500);
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.processDue();
    } catch (error) {
      console.error("alarm failed", error);
      throw error;
    }
  }

  private async onConnection(connection: TgBusinessConnection): Promise<AgentReply> {
    this.sql.exec(
      `INSERT INTO connections (id, user_id, user_chat_id, rights, is_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         user_chat_id = excluded.user_chat_id,
         rights = excluded.rights,
         is_enabled = excluded.is_enabled,
         updated_at = excluded.updated_at`,
      connection.id,
      connection.user.id,
      connection.user_chat_id ?? null,
      JSON.stringify(connection.rights ?? {}),
      connection.is_enabled ? 1 : 0,
      Date.now(),
    );

    if (!connection.is_enabled) {
      this.cancelAllPending();
      await this.scheduleNextAlarm();
    }

    return { ok: true };
  }

  private async onBusinessMessage(message: TgMessage): Promise<AgentReply> {
    const connectionId = message.business_connection_id;
    if (!connectionId) return { ok: false, error: "no business_connection_id" };

    const connection = this.connection(connectionId) ?? (await this.fetchConnection(connectionId));
    if (!connection) return { ok: false, error: "connection is not registered yet" };
    if (!connection.is_enabled || this.isPaused()) return { ok: true };
    if (message.chat.type !== "private") return { ok: true };
    if (message.from?.is_bot || message.sender_business_bot) return { ok: true };

    const chatId = message.chat.id;
    const text = (message.text ?? message.caption ?? "").trim();
    this.upsertChat(
      chatId,
      message.chat.first_name ?? message.chat.username ?? message.chat.title ?? null,
      message.chat.username ?? null,
    );

    if (message.from?.id === connection.user_id) {
      this.recordMessage(chatId, "owner", text || "[без тексту]", Date.now());
      this.cancelPending(chatId);
      await this.scheduleNextAlarm();
      return { ok: true };
    }

    this.recordMessage(chatId, "in", text || "[без тексту]", Date.now());
    if (!text) return { ok: true };

    const now = Date.now();
    const forward = isForwardRequest(text);
    const mode = replyMode(this.setting("presence_override"), await this.ownerPresence(connection.user_id));
    const dueAt = forward ? now : dueAtForMode(mode, now, this.awayDelayMs(), this.delayMs());

    if (dueAt === null) {
      this.cancelPending(chatId);
      await this.scheduleNextAlarm();
      return { ok: true };
    }

    this.schedulePending(chatId, connectionId, dueAt);
    await this.scheduleNextAlarm();
    return { ok: true };
  }

  private async processDue(): Promise<void> {
    const now = Date.now();
    const due = this.sql
      .exec<PendingRow>(
        `SELECT chat_id, connection_id, due_at, cancelled, created_at
         FROM pending
         WHERE cancelled = 0 AND due_at <= ?
         ORDER BY due_at
         LIMIT 10`,
        now,
      )
      .toArray();

    for (const row of due) {
      const stillPending = this.sql
        .exec<{ cancelled: number }>(`SELECT cancelled FROM pending WHERE chat_id = ?`, row.chat_id)
        .toArray()[0];
      if (!stillPending || stillPending.cancelled === 1) continue;

      const connection = this.connection(row.connection_id);
      if (!connection || !connection.is_enabled || this.isPaused()) {
        this.cancelPending(row.chat_id);
        continue;
      }

      const rights = parseRights(connection.rights);
      if (rights.can_reply === false) {
        this.cancelPending(row.chat_id);
        await this.warnOnce(
          "missed_reply_right",
          connection,
          "У бота немає права відповідати. Увімкніть дозвіл «Відповідати» в Налаштування → Автоматизація чатів.",
        );
        continue;
      }

      const lastIncoming = this.lastIncomingAt(row.chat_id);
      if (lastIncoming === null || now - lastIncoming > BUSINESS_WINDOW_MS) {
        this.cancelPending(row.chat_id);
        continue;
      }

      const history = this.recentMessages(row.chat_id);
      if (history.length === 0) {
        this.cancelPending(row.chat_id);
        continue;
      }

      const lastIncomingMessage = [...history].reverse().find((item) => item.direction === "in");
      const forwardRequested = lastIncomingMessage ? isForwardRequest(lastIncomingMessage.text) : false;

      let parsed: ParsedReply;
      try {
        await sendBusinessTyping(this.env, row.connection_id, row.chat_id).catch(() => undefined);
        parsed = parseReply(
          await complete(
            this.env,
            buildMessages(history, this.setting("prompt"), {
              forwardRequested,
              ownerName: this.env.OWNER_NAME,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof LlmError && error.retryAfterSeconds > 0) {
          this.reschedulePending(row.chat_id, Date.now() + error.retryAfterSeconds * 1000);
          continue;
        }
        this.dropPending(row.chat_id);
        console.error("reply failed", error);
        await this.warnOnce(
          `reply_failed:${row.chat_id}:${Math.floor(now / 3_600_000)}`,
          connection,
          `Не вдалося відповісти в чаті ${row.chat_id}: ${errorMessage(error)}`,
        );
        continue;
      }

      const outgoing = parsed.text || "Передав власнику.";
      try {
        await sendBusinessMessage(this.env, row.connection_id, row.chat_id, outgoing);
        this.recordMessage(row.chat_id, "out", outgoing, Date.now());
      } catch (error) {
        if (error instanceof TelegramError && error.retryAfterSeconds > 0) {
          this.reschedulePending(row.chat_id, Date.now() + error.retryAfterSeconds * 1000);
          continue;
        }
        console.error("reply delivery failed", error);
        await this.warnOnce(
          `send_failed:${row.chat_id}:${Math.floor(now / 3_600_000)}`,
          connection,
          `Не вдалося відповісти в чаті ${row.chat_id}: ${errorMessage(error)}`,
        );
      }

      if (forwardRequested) {
        const summary = parsed.notify ?? fallbackSummary(history);
        if (summary) await this.notifyOwner(connection, row.chat_id, summary);
      }

      this.dropPending(row.chat_id);
    }

    await this.scheduleNextAlarm();
  }

  private async onCommand(text: string): Promise<AgentReply> {
    const connection = this.primaryConnection();
    if (!connection) {
      return {
        ok: false,
        reply: "Бот ще не підключений до акаунта. У Telegram: Налаштування → Автоматизація чатів.",
      };
    }

    const [rawCommand = "", ...rest] = text.trim().split(/\s+/);
    const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";
    const argument = rest.join(" ").trim();

    switch (command) {
      case "/start":
      case "/status": {
        const presence = await this.ownerPresence(connection.user_id);
        return { ok: true, reply: this.statusText(connection, presence) };
      }
      case "/help":
        return { ok: true, reply: HELP_TEXT };
      case "/away":
        this.setSetting("presence_override", "away");
        return { ok: true, reply: "Режим away. Відповідатиму одразу, навіть якщо ви в мережі." };
      case "/back":
        this.sql.exec(`DELETE FROM settings WHERE key = 'presence_override'`);
        return { ok: true, reply: "Авто-режим. Стан беру з маячка клієнта." };
      case "/test-notify": {
        const target = connection.user_chat_id;
        if (!target) {
          return { ok: false, reply: "Немає chat_id для сповіщень — перепідключіть бота в «Автоматизації чатів»." };
        }
        const sample = formatOwnerNotification({
          title: "Марія",
          username: "maria_dev",
          chatId: target,
          summary: "Просить рахунок за жовтень до п'ятниці.",
        });
        await sendMessage(this.env, target, `Тест сповіщення.\n\n${sample}`);
        return { ok: true, reply: "Надіслав тестове сповіщення." };
      }
      case "/pause":
        this.setSetting("paused", "1");
        return { ok: true, reply: "Пауза. Бот не відповідатиме, доки ви не надішлете /resume." };
      case "/resume":
        this.setSetting("paused", "0");
        return { ok: true, reply: "Знову активний." };
      case "/delay": {
        const minutes = Number(argument);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          return { ok: false, reply: "Вкажіть кількість хвилин від 1 до 1440: /delay 10" };
        }
        this.setSetting("delay_minutes", String(Math.floor(minutes)));
        return {
          ok: true,
          reply: `Нова затримка: ${Math.floor(minutes)} хв. Діє для наступних повідомлень.`,
        };
      }
      case "/prompt": {
        if (!argument) {
          const current = this.setting("prompt");
          return { ok: true, reply: current ? `Поточні інструкції:\n${current}` : "Додаткових інструкцій немає." };
        }
        if (argument === "reset") {
          this.sql.exec(`DELETE FROM settings WHERE key = 'prompt'`);
          return { ok: true, reply: "Додаткові інструкції прибрано." };
        }
        this.setSetting("prompt", argument.slice(0, 2000));
        return { ok: true, reply: "Інструкції збережено." };
      }
      case "/forget": {
        const rows = this.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM messages`).toArray();
        const total = rows[0]?.total ?? 0;
        this.sql.exec(`DELETE FROM messages`);
        return { ok: true, reply: `Історію стерто (${total} повідомлень).` };
      }
      default:
        return { ok: false, reply: `Невідома команда. ${HELP_TEXT}` };
    }
  }

  private statusText(connection: ConnectionRow, presence: Presence): string {
    const rights = parseRights(connection.rights);
    const pending = this.sql
      .exec<{ total: number }>(`SELECT COUNT(*) AS total FROM pending WHERE cancelled = 0`)
      .toArray()[0];
    const chats = this.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM chats`).toArray()[0];
    const messages = this.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM messages`).toArray()[0];
    const delayMinutes = Math.round(this.delayMs() / 60_000);
    const awaySeconds = Math.round(this.awayDelayMs() / 1000);
    const override = this.setting("presence_override");
    const presenceOn = presenceEnabled(this.env);

    return [
      `Підключення: ${connection.id}`,
      `Стан: ${connection.is_enabled ? "активне" : "вимкнене"}`,
      presenceOn
        ? `Присутність: ${presence}${override ? ` (вручну: ${override})` : ""}`
        : "Присутність: вимкнено (працює таймер)",
      `Пауза: ${this.isPaused() ? "так" : "ні"}`,
      presenceOn
        ? `Відповідь: away через ${awaySeconds} с, онлайн — тиша, невідомо — ${delayMinutes} хв`
        : `Відповідь: через ${delayMinutes} хв`,
      `Чатів у пам'яті: ${chats?.total ?? 0}`,
      `Очікують відповіді: ${pending?.total ?? 0}`,
      `Повідомлень в історії: ${messages?.total ?? 0}`,
      `Права: reply=${rights.can_reply !== false}, read=${rights.can_read_messages !== false}`,
    ].join("\n");
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    await this.processDue();

    this.sql.exec(`DELETE FROM pending WHERE cancelled = 1 AND created_at < ?`, now - CANCELLED_TTL_MS);
    this.sql.exec(`DELETE FROM pending WHERE due_at < ?`, now - BUSINESS_WINDOW_MS);

    const ttlDays = intVar(this.env.HISTORY_TTL_DAYS, 7);
    this.sql.exec(`DELETE FROM messages WHERE ts < ?`, now - ttlDays * 24 * 60 * 60 * 1000);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.sql
      .exec<{ due_at: number | null }>(`SELECT MIN(due_at) AS due_at FROM pending WHERE cancelled = 0`)
      .toArray()[0];

    if (!row || row.due_at === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(row.due_at, Date.now() + 500));
  }

  private async warnOnce(key: string, connection: ConnectionRow, text: string): Promise<void> {
    if (this.setting(`warned:${key}`) === "1") return;
    if (connection.user_chat_id === null) return;
    this.setSetting(`warned:${key}`, "1");
    await sendMessage(this.env, connection.user_chat_id, text).catch((error) => {
      console.error("warning delivery failed", error);
    });
  }

  private connection(id: string): ConnectionRow | null {
    return (
      this.sql.exec<ConnectionRow>(`SELECT * FROM connections WHERE id = ?`, id).toArray()[0] ?? null
    );
  }

  private async fetchConnection(connectionId: string): Promise<ConnectionRow | null> {
    try {
      const connection = await callTelegram<TgBusinessConnection>(this.env, "getBusinessConnection", {
        business_connection_id: connectionId,
      });
      await this.onConnection(connection);
      await this.registerConnection(connection);
      return this.connection(connectionId);
    } catch (error) {
      console.error("failed to fetch business connection", error);
      return null;
    }
  }

  private async registerConnection(connection: TgBusinessConnection): Promise<void> {
    const stub = this.env.REGISTRY.get(this.env.REGISTRY.idFromName(REGISTRY_ID));
    await stub
      .fetch("https://registry.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "upsert",
          connectionId: connection.id,
          userId: connection.user.id,
          isEnabled: connection.is_enabled,
        }),
      })
      .catch((error) => console.error("registry upsert failed", error));
  }

  private primaryConnection(): ConnectionRow | null {
    return (
      this.sql
        .exec<ConnectionRow>(`SELECT * FROM connections ORDER BY updated_at DESC LIMIT 1`)
        .toArray()[0] ?? null
    );
  }

  private setting(key: string): string | null {
    return this.sql.exec<SettingRow>(`SELECT value FROM settings WHERE key = ?`, key).toArray()[0]?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private isPaused(): boolean {
    return this.setting("paused") === "1";
  }

  private delayMs(): number {
    const stored = this.setting("delay_minutes");
    const minutes = intVar(stored ?? this.env.DELAY_MINUTES, DEFAULT_DELAY_MINUTES);
    return Math.min(Math.max(minutes, 1), 1440) * 60_000;
  }

  private awayDelayMs(): number {
    return intVar(this.env.AWAY_DELAY_SECONDS, 15) * 1000;
  }

  private presenceTtlMs(): number {
    return intVar(this.env.PRESENCE_TTL_SECONDS, 90) * 1000;
  }

  private async ownerPresence(userId: number): Promise<Presence> {
    if (!presenceEnabled(this.env)) return "unknown";
    try {
      const stub = this.env.REGISTRY.get(this.env.REGISTRY.idFromName(REGISTRY_ID));
      const response = await stub.fetch("https://registry.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "presenceGet", userId }),
      });
      if (!response.ok) return "unknown";
      const data = (await response.json()) as { devices?: DevicePresenceRow[] };
      return resolvePresence(data.devices ?? [], Date.now(), this.presenceTtlMs());
    } catch (error) {
      console.error("presence lookup failed", error);
      return "unknown";
    }
  }

  private upsertChat(chatId: number, title: string | null, username: string | null): void {
    this.sql.exec(
      `INSERT INTO chats (chat_id, title, username) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         title = COALESCE(excluded.title, chats.title),
         username = COALESCE(excluded.username, chats.username)`,
      chatId,
      title,
      username,
    );
  }

  private async notifyOwner(connection: ConnectionRow, chatId: number, summary: string): Promise<void> {
    const target = connection.user_chat_id;
    if (!target) {
      console.error("owner notification skipped: user_chat_id is unknown");
      return;
    }

    const chat = this.sql
      .exec<{ title: string | null; username: string | null }>(
        `SELECT title, username FROM chats WHERE chat_id = ?`,
        chatId,
      )
      .toArray()[0];

    const text = formatOwnerNotification({
      title: chat?.title ?? null,
      username: chat?.username ?? null,
      chatId,
      summary,
    });

    try {
      await sendMessage(this.env, target, text);
    } catch (error) {
      console.error("owner notification failed", error);
    }
  }

  private recordMessage(chatId: number, direction: string, text: string, ts: number): void {
    this.sql.exec(
      `INSERT INTO messages (chat_id, direction, text, ts) VALUES (?, ?, ?, ?)`,
      chatId,
      direction,
      text.slice(0, 4000),
      ts,
    );
  }

  private recentMessages(chatId: number): MessageRow[] {
    return this.sql
      .exec<MessageRow>(
        `SELECT id, chat_id, direction, text, ts FROM messages
         WHERE chat_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT 8`,
        chatId,
      )
      .toArray()
      .reverse();
  }

  private lastIncomingAt(chatId: number): number | null {
    const row = this.sql
      .exec<{ ts: number | null }>(
        `SELECT MAX(ts) AS ts FROM messages WHERE chat_id = ? AND direction = 'in'`,
        chatId,
      )
      .toArray()[0];
    return row?.ts ?? null;
  }

  private schedulePending(chatId: number, connectionId: string, dueAt: number): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO pending (chat_id, connection_id, due_at, cancelled, created_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         connection_id = excluded.connection_id,
         due_at = excluded.due_at,
         cancelled = 0,
         created_at = excluded.created_at`,
      chatId,
      connectionId,
      dueAt,
      now,
    );
  }

  private reschedulePending(chatId: number, dueAt: number): void {
    this.sql.exec(`UPDATE pending SET due_at = ? WHERE chat_id = ?`, dueAt, chatId);
  }

  private cancelPending(chatId: number): void {
    this.sql.exec(`UPDATE pending SET cancelled = 1 WHERE chat_id = ?`, chatId);
  }

  private cancelAllPending(): void {
    this.sql.exec(`UPDATE pending SET cancelled = 1 WHERE cancelled = 0`);
  }

  private dropPending(chatId: number): void {
    this.sql.exec(`DELETE FROM pending WHERE chat_id = ?`, chatId);
  }
}

function parseRights(raw: string): Record<string, boolean> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackSummary(history: MessageRow[]): string | null {
  const incoming = history
    .filter((item) => item.direction === "in")
    .slice(-2)
    .map((item) => item.text.trim())
    .filter(Boolean);
  const summary = incoming.join(" / ").slice(0, 500);
  return summary || null;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
