#!/usr/bin/env node
// Registers the Telegram webhook for the Worker.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/set-webhook.mjs https://<worker>.<subdomain>.workers.dev/telegram
//   TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs --info
//   TELEGRAM_BOT_TOKEN=... node scripts/set-webhook.mjs --delete
//
// Put the secrets in your shell, not in this file.

const API = "https://api.telegram.org";
const ALLOWED_UPDATES = [
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  "message",
];

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = args.find((arg) => arg.startsWith("--"));
const url = args.find((arg) => !arg.startsWith("--"));

async function call(method, payload) {
  const response = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`${method}: ${data.description ?? response.status}`);
  }
  return data.result;
}

if (flag === "--info") {
  const info = await call("getWebhookInfo");
  console.log(JSON.stringify(info, null, 2));
  process.exit(0);
}

if (flag === "--delete") {
  console.log(await call("deleteWebhook", { drop_pending_updates: false }));
  process.exit(0);
}

if (!url || !/^https:\/\//.test(url)) {
  console.error("Usage: node scripts/set-webhook.mjs https://<worker>.workers.dev/telegram");
  process.exit(1);
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!secret) {
  console.error("TELEGRAM_WEBHOOK_SECRET is not set");
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET must match ^[A-Za-z0-9_-]{1,256}$ (Telegram requirement)");
  process.exit(1);
}

await call("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ALLOWED_UPDATES,
  drop_pending_updates: false,
});

console.log(`Webhook set to ${url}`);
console.log(JSON.stringify(await call("getWebhookInfo"), null, 2));
