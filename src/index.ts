import type { AgentReply, AgentRequest } from "./agent";
import { AccountAgent } from "./agent";
import type { Env } from "./env";
import { ownerTelegramId, presenceEnabled, REGISTRY_ID } from "./env";
import { Registry } from "./registry";
import type { RegistryRequest } from "./registry";
import type { TgMessage, TgUpdate } from "./telegram";
import { sendMessage } from "./telegram";

export { AccountAgent, Registry };

const MAX_SWEEP_CONNECTIONS = 50;

interface RegistryReply {
  ok: boolean;
  connections?: string[];
  devices?: Array<{ device_id: string; state: string; updated_at: number }>;
  error?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/presence") {
      return handlePresence(request, env);
    }

    if (url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (!env.TELEGRAM_WEBHOOK_SECRET) {
      console.error("TELEGRAM_WEBHOOK_SECRET is not configured");
      return new Response("Misconfigured", { status: 503 });
    }

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    ctx.waitUntil(
      routeUpdate(env, update).catch((error) => {
        console.error("failed to route update", error);
      }),
    );

    return new Response("ok");
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepAll(env).catch((error) => {
        console.error("sweep failed", error);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function routeUpdate(env: Env, update: TgUpdate): Promise<void> {
  if (update.business_connection) {
    const connection = update.business_connection;
    await callRegistry(env, {
      type: "upsert",
      connectionId: connection.id,
      userId: connection.user.id,
      isEnabled: connection.is_enabled,
    });
    await callAgent(env, connection.id, { type: "connection", connection });
    return;
  }

  if (update.business_message) {
    const message = update.business_message;
    const connectionId = message.business_connection_id;
    if (!connectionId) return;
    await callAgent(env, connectionId, { type: "business_message", message });
    return;
  }

  if (update.deleted_business_messages) {
    const deleted = update.deleted_business_messages;
    await callAgent(env, deleted.business_connection_id, {
      type: "deleted",
      chatId: deleted.chat.id,
    });
    return;
  }

  if (update.edited_business_message) {
    return;
  }

  if (update.message) {
    await handleOwnerMessage(env, update.message);
  }
}

async function handleOwnerMessage(env: Env, message: TgMessage): Promise<void> {
  const ownerId = ownerTelegramId(env);
  const from = message.from;
  if (!from) return;

  if (message.chat.type !== "private") return;

  if (ownerId === null) {
    await sendMessage(env, message.chat.id, "OWNER_TELEGRAM_ID не налаштований на сервері.");
    return;
  }

  if (from.id !== ownerId) {
    await sendMessage(env, message.chat.id, "Це приватний бот власника акаунта.");
    return;
  }

  const connections = await connectionsOf(env, ownerId);
  if (connections.length === 0) {
    await sendMessage(
      env,
      message.chat.id,
      "Бот ще не підключений до вашого акаунта.\nTelegram → Налаштування → Автоматизація чатів → додайте @username бота.",
    );
    return;
  }

  const text = message.text ?? "";
  if (!text.trim()) return;

  const replies: string[] = [];
  for (const connectionId of connections) {
    try {
      const result = await callAgent(env, connectionId, { type: "command", text, fromId: ownerId });
      if (result.reply) {
        replies.push(connections.length > 1 ? `[${connectionId.slice(0, 8)}] ${result.reply}` : result.reply);
      }
    } catch (error) {
      console.error("command failed", error);
      replies.push(`Помилка для підключення ${connectionId.slice(0, 8)}: ${String(error)}`);
    }
  }

  await sendMessage(env, message.chat.id, replies.join("\n\n") || "Готово.");
}

async function sweepAll(env: Env): Promise<void> {
  const listed = await callRegistry(env, { type: "list" });
  const connections = (listed.connections ?? []).slice(0, MAX_SWEEP_CONNECTIONS);
  const results = await Promise.allSettled(
    connections.map((connectionId) => callAgent(env, connectionId, { type: "sweep" })),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("sweep of a connection failed", result.reason);
    }
  }
}

async function connectionsOf(env: Env, userId: number): Promise<string[]> {
  const listed = await callRegistry(env, { type: "byOwner", userId });
  return listed.connections ?? [];
}

async function handlePresence(request: Request, env: Env): Promise<Response> {
  if (!presenceEnabled(env)) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (!env.PRESENCE_TOKEN) {
    return new Response("Misconfigured", { status: 503 });
  }
  const token = request.headers.get("X-Presence-Token") ?? "";
  if (!safeEqual(token, env.PRESENCE_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ownerId = ownerTelegramId(env);
  if (ownerId === null) {
    return new Response("OWNER_TELEGRAM_ID is not configured", { status: 503 });
  }

  let body: { state?: string; device?: string };
  try {
    body = (await request.json()) as { state?: string; device?: string };
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const state = body.state === "online" ? "online" : body.state === "away" ? "away" : null;
  if (!state) {
    return new Response("Bad request", { status: 400 });
  }
  const device = (body.device ?? "phone").slice(0, 32);

  await callRegistry(env, { type: "presenceSet", userId: ownerId, deviceId: device, state });

  if (state === "online") {
    await cancelPendingForOwner(env, ownerId);
  }

  return new Response(null, { status: 204 });
}

async function cancelPendingForOwner(env: Env, userId: number): Promise<void> {
  const listed = await callRegistry(env, { type: "byOwner", userId });
  const connections = (listed.connections ?? []).slice(0, MAX_SWEEP_CONNECTIONS);
  await Promise.allSettled(
    connections.map((connectionId) => callAgent(env, connectionId, { type: "owner_online" })),
  );
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function agentStub(env: Env, connectionId: string): DurableObjectStub {
  return env.ACCOUNT_AGENT.get(env.ACCOUNT_AGENT.idFromName(connectionId));
}

function registryStub(env: Env): DurableObjectStub {
  return env.REGISTRY.get(env.REGISTRY.idFromName(REGISTRY_ID));
}

async function callAgent(env: Env, connectionId: string, payload: AgentRequest): Promise<AgentReply> {
  const response = await agentStub(env, connectionId).fetch("https://agent.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`agent responded with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as AgentReply;
}

async function callRegistry(env: Env, payload: RegistryRequest): Promise<RegistryReply> {
  const response = await registryStub(env).fetch("https://registry.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`registry responded with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as RegistryReply;
}
