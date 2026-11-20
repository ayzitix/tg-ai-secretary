# SETUP — for the owner and their AI agent

This is the short, executable checklist. Read `README.md` for the architecture.

> For an AI coding agent: follow the steps in order. Ask the human only for the
> four values in step 2. Never print secret values, never commit `.dev.vars`, and
> feed secrets to Cloudflare through stdin.

## What you get

A Telegram bot that is connected to one person's account through Telegram's
**Chat Automation**. When someone writes to that person in a private chat and the
person does not answer within `DELAY_MINUTES` (default 5), the bot writes a short
reply on their behalf, introducing itself as their AI assistant. If the person
answers first, the reply is cancelled.

## Requirements

- Node.js 20 or newer.
- A Cloudflare account (the free plan is enough, no card required).
- A Telegram bot from [@BotFather](https://t.me/BotFather).
- A Groq API key: https://console.groq.com/keys (free tier, no card required).

## 1. Create and enable the bot

1. In @BotFather: `/newbot`, pick a name and a username, copy the token.
2. Open `/mybots` → your bot → **Bot Settings** → **Secretary Mode** → turn it on.
   Without it Telegram will not allow the bot to be connected to an account.

## 2. Collect four values

| Value | Where to get it | Goes to |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | BotFather, after `/newbot` | Cloudflare secret |
| `TELEGRAM_WEBHOOK_SECRET` | generate: `openssl rand -hex 32` | Cloudflare secret |
| `GROQ_API_KEY` | https://console.groq.com/keys | Cloudflare secret |
| `OWNER_TELEGRAM_ID` | send `/start` to [@userinfobot](https://t.me/userinfobot) | Cloudflare secret |

`TELEGRAM_WEBHOOK_SECRET` is a password you invent: it must only contain
`A-Za-z0-9_-`, and it must match between `.dev.vars` and `setWebhook`.

Also set the owner's display name in `wrangler.jsonc`:

```jsonc
"OWNER_NAME": "Your Name"
```

## 3. Local install

```bash
npm install
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Fill `.dev.vars` with the four values. This file is git-ignored.

Check that nothing secret is staged:

```bash
git status --short
```

`.dev.vars` must not appear.

## 4. Deploy to Cloudflare

```bash
npx wrangler login          # opens the browser once
npm run typecheck
npm test
npm run deploy
```

Wrangler prints the Worker URL, for example
`https://tg-ai-secretary.<your-subdomain>.workers.dev`.

Upload the secrets **after** the first deploy, without printing them:

```bash
set -a; . ./.dev.vars; set +a
printf '%s' "$TELEGRAM_BOT_TOKEN"      | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$TELEGRAM_WEBHOOK_SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
printf '%s' "$GROQ_API_KEY"            | npx wrangler secret put GROQ_API_KEY
printf '%s' "$OWNER_TELEGRAM_ID"       | npx wrangler secret put OWNER_TELEGRAM_ID
```

## 5. Register the webhook

```bash
set -a; . ./.dev.vars; set +a
npm run webhook -- https://tg-ai-secretary.<your-subdomain>.workers.dev/telegram
```

The script sets `secret_token` and the required `allowed_updates`. Verify:

```bash
TELEGRAM_BOT_TOKEN=... npm run webhook -- --info
```

## 6. Connect the bot to the account (only the human can do this)

Telegram → **Settings** → **Chat Automation** → enter the bot's `@username` →
choose which chats it may access → enable:

- **Reply** (required, otherwise the bot can read but cannot answer);
- **Read messages** (so it sees the text).

Then send `/start` to the bot in its private chat. It replies with the status.

If the bot was connected before the first deploy, the `business_connection`
update may have been missed. Send any message in a managed chat once — the bot
fetches the connection itself via `getBusinessConnection`.

## 7. Test

1. Send `/delay 1` to the bot in its private chat.
2. From another account, write a work-related question to the owner.
3. Do not answer. Within about a minute the bot should reply as the assistant.
4. Reply yourself in another chat and repeat: the bot must stay silent.
5. Send `/delay 5` back.

Expected limitations: private chats only, and the bot can reply only within 24
hours of the last incoming message.

## What an AI agent must never do

- Print, log or commit any value from `.dev.vars`.
- Add `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY`, `OWNER_TELEGRAM_ID` or
  `TELEGRAM_WEBHOOK_SECRET` to `wrangler.jsonc`, README or source files.
- Run `wrangler deploy` before the account is logged in; ask the human to run
  `npx wrangler login` instead of asking for their password.

## Prompt you can give an AI agent

> Read SETUP.md and README.md in this repository. Set the project up end to end.
> Ask me only for the four secret values from step 2. Put them in `.dev.vars`,
> never print them, then deploy and register the webhook. When you are done,
> tell me exactly which two steps I must do in Telegram myself.
