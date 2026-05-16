# Kamino liquidity worker

Cloudflare Worker that monitors Kamino multiply borrow liquidity for four loops:

- **ONyc/USDG Multiply** (OnRe market, utilization cap 90%)
- **ONyc/USDC Multiply** (OnRe market, utilization cap 90%)
- **ONyc/USDS Multiply** (OnRe market, utilization cap 90%)
- **USDe/USDG Multiply** (separate market, utilization cap 100%)

Replaces an earlier GitHub Actions cron (which suffered 30+ minute schedule drift).

## What it does

| Trigger | What runs | What you see |
|---|---|---|
| Cron `*/5 * * * *` (reliable, fires on time) | Computes `Borrow Capacity Remaining` for both pairs, compares to last state in KV | Telegram broadcast **only on transition** (closed → open, or open → closed) to all subscribers |
| Telegram `/start` | Subscribes the chat to future alerts, replies with current state | Welcome message + live table |
| Telegram `/check` or **📊 Check liquidity** button | Live computation | Live table |
| Telegram `/stop` | Unsubscribes the chat | Confirmation |
| Telegram `/status` | Bot health check | Last cron tick + age, schedule, subscriber count, per-pair last-seen |
| Telegram `/who` (owner only) | Lists subscribers | Subscriber count + chat ids |

Subscribers are stored in Workers KV (key `subscribers`). The owner — the chat
id set as `TELEGRAM_CHAT_ID` — is **always** a recipient and can't be removed.
If any other subscriber blocks the bot, they're dropped from the list silently
on the next alert.

For these reserves the binding cap is the reserve utilization cap, so:
```
available = min(  totalSupply * (utilizationCap - currentUtilization),   totalSupply - totalBorrow  )
```
…clamped at zero. Reproduces what Kamino's UI shows. Per-pair `utilizationCap`
is hardcoded in `src/index.js` (verified once with klend-sdk against the
on-chain reserve config). Data comes from the public
`api.kamino.finance/kamino-market/{m}/reserves/metrics` endpoint — no auth, no
on-chain RPC, no klend-sdk on the worker (which keeps the bundle small).

## Files

| File | Purpose |
|---|---|
| `src/index.js` | Worker code — exports `fetch` (webhook) and `scheduled` (cron) handlers |
| `wrangler.toml` | Cloudflare config: cron schedule, KV binding |
| `package.json` | Scripts only — no runtime deps |

## Local dev / deployment

```bash
npm install -g wrangler
wrangler login                # one-time, browser auth
wrangler kv namespace create STATE   # if the namespace id in wrangler.toml is stale
wrangler deploy
```

### Secrets

Stored in Cloudflare via `wrangler secret put` (never in this repo):

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | your numeric chat id |
| `WEBHOOK_SECRET` | random string, echoed by Telegram on every webhook POST for auth |

Set them like this (pipe stdin — `wrangler secret put` reads it):

```bash
printf '%s' 'YOUR_BOT_TOKEN'       | wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' 'YOUR_CHAT_ID'         | wrangler secret put TELEGRAM_CHAT_ID
openssl rand -hex 24 | tr -d '\n'  | wrangler secret put WEBHOOK_SECRET
```

### Register the Telegram webhook

After `wrangler deploy` prints the URL, point Telegram at it:

```bash
WORKER_URL="https://kamino-liquidity-worker.<your-subdomain>.workers.dev"
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"$WORKER_URL\",\"secret_token\":\"<WEBHOOK_SECRET>\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

Verify with:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Logs

```bash
wrangler tail
```

Streams worker stdout/stderr in real time (cron ticks and webhook calls).

## Tuning

- **Cron frequency** — edit `crons = ["*/5 * * * *"]` in `wrangler.toml`. Cloudflare's
  free tier covers up to 1 schedule every 1 min.
- **Pairs / market** — edit `PAIRS` and `MARKET` constants at the top of `src/index.js`.
- **Utilization cap** — `UTILIZATION_CAP = 0.9`. Update if Kamino changes it.
- **What counts as "available"** — currently `> 0`. Add a threshold by changing the
  comparison in `handleScheduled`.

## Notes

- The worker hashes Telegram's `x-telegram-bot-api-secret-token` header against
  `WEBHOOK_SECRET` and rejects anything else with 401 — so the worker URL is safe
  to share but can't be triggered by random internet traffic.
- State lives in Workers KV (binding `STATE`, key `state`). KV is eventually
  consistent across edge nodes; for a 5-minute cron this is fine, but two
  near-simultaneous cron ticks could race. Worker cron is single-tenant per
  schedule, so this doesn't happen in practice.
