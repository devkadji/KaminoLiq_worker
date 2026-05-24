// Kamino multiply liquidity bot — runs on Cloudflare Workers.
//
// Two entry points:
//   - scheduled(): cron tick (every 5 min). Computes liquidity, alerts on transition.
//   - fetch():     Telegram webhook. Handles /start, /check, and button taps.
//
// Data source: Kamino's public reserves/metrics endpoint (no auth, real-time).
// For these two reserves the binding cap is the reserve utilization cap (90%),
// so "Borrow Capacity Remaining" = min(cash, totalSupply * (cap - currentUtil)).

// Each pair has its own market + debt reserve + utilization cap. Caps come from
// the on-chain reserve config (verified once via klend-sdk); if Kamino changes
// a cap, update the constant here. Markets are deduplicated when fetching.
const ONRE_MARKET = '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8';
const USDE_MARKET = 'BJnbcRHqvppTyGesLzWASGKnmnF1wq9jZu6ExrjT7wvF';

const PAIRS = [
  {
    name: 'ONyc/USDG Multiply',
    symbol: 'USDG',
    market: ONRE_MARKET,
    reserve: 'JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw',
    utilizationCap: 0.9,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ/JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw`,
  },
  {
    name: 'ONyc/USDC Multiply',
    symbol: 'USDC',
    market: ONRE_MARKET,
    reserve: 'AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z',
    utilizationCap: 0.9,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ/AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z`,
  },
  {
    name: 'ONyc/USDS Multiply',
    symbol: 'USDS',
    market: ONRE_MARKET,
    reserve: '3yDc9ARvtPLhYxZLgucZGuBtZ9bHshBvXTwHxGe3nhmC',
    utilizationCap: 0.9,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ/3yDc9ARvtPLhYxZLgucZGuBtZ9bHshBvXTwHxGe3nhmC`,
  },
  {
    name: 'USDe/USDG Multiply',
    symbol: 'USDG',
    market: USDE_MARKET,
    reserve: 'Q5av3wh8j9KCqSjs9njUdsPhrMSKBCUyr4VyUndUUFA',
    // utilizationCap fields are now FALLBACKS only — the actual cap is fetched
    // on-chain every tick (see fetchLiveUtilizationCaps). The value here is
    // used only if the Solana RPC fetch fails.
    utilizationCap: 0.95,
    url: `https://kamino.com/multiply/${USDE_MARKET}/2erD9GTGcaQbLsVSQweg3HvMpfKxScmz95raWv8H4iPN/Q5av3wh8j9KCqSjs9njUdsPhrMSKBCUyr4VyUndUUFA`,
  },
];

// --- Live on-chain cap reads ---
// Kamino can update a reserve's utilization cap at any time. Hardcoding it
// causes silent drift between the bot's "depositable" calculation and what the
// Kamino UI shows. To stay in sync, we read the actual cap directly from each
// reserve account via Solana RPC with a `dataSlice` (one byte per reserve, ~4
// bytes total per tick — much lighter than running the klend-sdk in a worker).
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
// Byte offset of `config.utilizationLimitBlockBorrowingAbovePct` (a u8 percent
// value 0..100) within Kamino's Reserve account data. Verified empirically by
// intersecting offsets where multiple reserves' values match across 4
// different debt reserves. Would only need updating if Kamino restructures
// the Reserve account in a program upgrade.
const UTIL_CAP_OFFSET = 5501;

async function fetchLiveUtilizationCaps() {
  const addrs = PAIRS.map((p) => p.reserve);
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getMultipleAccounts',
    params: [
      addrs,
      { encoding: 'base64', dataSlice: { offset: UTIL_CAP_OFFSET, length: 1 } },
    ],
  };
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Solana RPC: ${json.error.message || JSON.stringify(json.error)}`);
  const accs = json.result?.value || [];
  const out = {};
  for (let i = 0; i < addrs.length; i++) {
    const acc = accs[i];
    if (!acc?.data?.[0]) continue;
    const byte = atob(acc.data[0]).charCodeAt(0);
    // Sanity check — cap should be a percent 0..100. Anything else means our
    // offset is wrong (Kamino changed the struct?) — discard and fall back.
    if (Number.isFinite(byte) && byte >= 0 && byte <= 100) {
      out[addrs[i]] = byte / 100;
    }
  }
  return out;
}

const INLINE_KEYBOARD = {
  inline_keyboard: [[{ text: '📊 Check liquidity', callback_data: 'check' }]],
};

function fmt(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function fetchLiquidity() {
  // Hit each market's metrics endpoint once, even if multiple pairs use it.
  const markets = [...new Set(PAIRS.map((p) => p.market))];
  // In parallel: fetch per-market metrics AND on-chain live utilization caps.
  const [metricsArr, liveCaps] = await Promise.all([
    Promise.all(
      markets.map(async (m) => {
        const res = await fetch(
          `https://api.kamino.finance/kamino-market/${m}/reserves/metrics`,
          { cf: { cacheTtl: 0, cacheEverything: false } },
        );
        if (!res.ok) throw new Error(`Kamino API ${m}: ${res.status}`);
        const arr = await res.json();
        return [m, new Map(arr.map((r) => [r.reserve, r]))];
      }),
    ),
    fetchLiveUtilizationCaps().catch((e) => {
      console.error('on-chain cap fetch failed, using hardcoded fallbacks:', e.message);
      return {};
    }),
  ]);
  const reservesByMarket = new Map(metricsArr);

  return PAIRS.map((p) => {
    const r = reservesByMarket.get(p.market).get(p.reserve);
    if (!r) throw new Error(`reserve ${p.reserve} not in market ${p.market}`);
    // Use live cap when available; fall back to hardcoded if the RPC call failed.
    const utilizationCap = liveCaps[p.reserve] ?? p.utilizationCap;
    const totalSupply = Number(r.totalSupply);
    const totalBorrow = Number(r.totalBorrow);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const headroom = Math.max(0, totalSupply * (utilizationCap - utilization));
    const cash = Math.max(0, totalSupply - totalBorrow);
    return {
      ...p,
      utilizationCap,         // overrides the hardcoded value with the live one
      utilization,
      available: Math.min(headroom, cash),
    };
  });
}

async function tg(env, payload) {
  const method = payload.method || 'sendMessage';
  delete payload.method;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
  return res.json();
}

function relTime(iso) {
  if (!iso) return 'never';
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Single combined snapshot — replaces the old `state` + `lastTick` two-key
// pattern with one key holding both. Cuts KV writes per cron tick from 2 → 1,
// which keeps us comfortably inside the free-tier 1000 writes/day limit.
async function loadSnapshot(env) {
  const snap = await env.STATE.get('snapshot', 'json');
  if (snap && snap.pairs) return snap;
  // Fallback for the very first invocation after this deploy: stitch together
  // the old two keys so we don't lose open/closed armed state and double-fire
  // existing-open transitions as "newly opened".
  const tick = await env.STATE.get('lastTick', 'json');
  const pairs = (await env.STATE.get('state', 'json')) || {};
  return { tick: tick || null, pairs };
}

async function formatStatus(env) {
  const snapshot = await loadSnapshot(env);
  const lastTick = snapshot.tick;
  const state = snapshot.pairs || {};
  const subs = await getSubscribers(env);
  const cron = '*/5 * * * *';

  const ageMin = lastTick?.at
    ? (Date.now() - new Date(lastTick.at).getTime()) / 60000
    : Infinity;
  const emoji = ageMin <= 10 ? '🟢' : ageMin <= 30 ? '🟡' : '🔴';

  let tickLine;
  if (!lastTick?.at) {
    tickLine = 'never';
  } else {
    const ts = lastTick.at.replace('T', ' ').slice(0, 19);
    const status = lastTick.ok ? 'ok' : `FAILED: ${lastTick.error || 'unknown'}`;
    tickLine = `${ts} UTC  (${relTime(lastTick.at)}, ${status})`;
  }

  const lines = [
    `${emoji} <b>Bot status</b>`,
    '',
    `Last cron tick:   ${tickLine}`,
    `Cron schedule:    <code>${cron}</code>`,
    `Subscribers:      ${subs.size} (+ owner)`,
    `Pairs monitored:  ${PAIRS.length}`,
    '',
    '<b>Per-pair last seen:</b>',
  ];
  for (const p of PAIRS) {
    const s = state[p.name];
    if (!s) {
      lines.push(`  ${p.name} — no data yet`);
      continue;
    }
    const utilStr = Number(s.utilizationPct).toFixed(2);
    // Prefer the live on-chain cap stored on the snapshot; fall back to the
    // hardcoded PAIRS value for snapshots written before this field existed.
    const capStr = ((s.utilizationCapPct ?? p.utilizationCap * 100)).toFixed(0);
    const summary = s.open
      ? `🟢 <b>depositable: yes</b> (${fmt(s.available)} ${p.symbol})`
      : `🔴 <b>depositable: no</b>  <i>util ${utilStr}% / cap ${capStr}%</i>`;
    lines.push(`  ${p.name}  ${summary}  (${relTime(s.checkedAt)})`);
  }
  return lines.join('\n');
}

function welcomeText() {
  const products = PAIRS.map((p) => `• ${p.name}`).join('\n');
  return (
    '👋 <b>Welcome to KaminoLiq bot!</b>\n\n' +
    'I watch borrow liquidity on these Kamino multiply products and ping you when a deposit window opens or closes:\n\n' +
    products +
    '\n\n' +
    '<b>Commands:</b>\n' +
    '/check — show current depositable status for all products\n' +
    '/status — bot health (last cron tick, subscriber count, per-pair last-seen)\n' +
    '/stop — unsubscribe from alerts\n' +
    '/start — re-read this welcome (and re-subscribe if needed)\n\n' +
    'You will get a 🟢 message when liquidity opens up, and a 🔴 message when it closes again. ' +
    'Tap the <b>📊 Check liquidity</b> button on any of my messages to refresh on demand.\n\n'
  );
}

function formatTable(data) {
  const lines = ['📊 <b>Borrow Capacity Remaining</b>', ''];
  for (const p of data) {
    const utilStr = (p.utilization * 100).toFixed(2);
    const capStr = (p.utilizationCap * 100).toFixed(0);
    lines.push(`<b>${p.name}</b>`);
    if (p.available > 0) {
      lines.push(`  🟢 <b>Depositable: yes</b> — ${fmt(p.available)} ${p.symbol}`);
    } else {
      lines.push(`  🔴 <b>Depositable: no</b>`);
    }
    lines.push(`  <i>util ${utilStr}% / cap ${capStr}%</i>`);
    lines.push('');
  }
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  lines.push(`<i>Checked: ${ts} UTC</i>`);
  return lines.join('\n');
}

// --- Subscribers ----------------------------------------------------------
// Public subscribe model: anyone who /starts the bot gets future alerts.
// /stop removes them. The owner (env.TELEGRAM_CHAT_ID) is always a recipient
// regardless of the list, as a safety net.

async function getSubscribers(env) {
  const arr = (await env.STATE.get('subscribers', 'json')) || [];
  return new Set(arr.map(Number));
}

async function saveSubscribers(env, set) {
  await env.STATE.put('subscribers', JSON.stringify([...set]));
}

async function addSubscriber(env, chatId) {
  const subs = await getSubscribers(env);
  if (subs.has(chatId)) return false;
  subs.add(chatId);
  await saveSubscribers(env, subs);
  return true;
}

async function removeSubscriber(env, chatId) {
  const subs = await getSubscribers(env);
  if (!subs.has(chatId)) return false;
  subs.delete(chatId);
  await saveSubscribers(env, subs);
  return true;
}

// Send the same payload to every subscriber + the owner. If anyone has blocked
// the bot or has an invalid chat, drop them from the subscriber list silently.
async function broadcast(env, payload) {
  const owner = Number(env.TELEGRAM_CHAT_ID);
  const subs = await getSubscribers(env);
  const recipients = new Set([...subs, owner]);
  const blocked = [];

  await Promise.all(
    [...recipients].map(async (chat_id) => {
      try {
        await tg(env, { ...payload, chat_id });
      } catch (err) {
        const msg = String(err.message || '');
        // 403 = bot blocked by user; 400 chat not found = chat deleted/inaccessible.
        if (msg.includes(' 403') || msg.includes('bot was blocked') || msg.includes('chat not found')) {
          if (chat_id !== owner) blocked.push(chat_id);
          console.log(`drop unreachable chat ${chat_id}: ${msg}`);
        } else {
          console.error(`send to ${chat_id} failed: ${msg}`);
        }
      }
    }),
  );

  if (blocked.length) {
    const subs2 = await getSubscribers(env);
    for (const id of blocked) subs2.delete(id);
    await saveSubscribers(env, subs2);
  }
}

async function handleScheduled(env) {
  // Load previous snapshot (pairs + last tick) in one read. We'll write the
  // updated combined snapshot ONCE at the end — saves 1 KV write per tick
  // compared to the old two-key approach (`state` + `lastTick`).
  const snapshot = await loadSnapshot(env);
  const tickRecord = { at: new Date().toISOString(), ok: false };
  let nextPairs = snapshot.pairs || {};
  let caught = null;
  try {
    nextPairs = await runCron(env, snapshot.pairs || {});
    tickRecord.ok = true;
  } catch (err) {
    tickRecord.error = String(err.message || err).slice(0, 200);
    caught = err;
  }
  // Single write — combines tick heartbeat + per-pair state.
  await env.STATE.put(
    'snapshot',
    JSON.stringify({ tick: tickRecord, pairs: nextPairs }),
  );
  if (caught) throw caught;
}

// Pure-ish: takes the previous per-pair state in, returns the new per-pair
// state out. Side effects = Telegram broadcasts on transitions. No KV writes
// (handleScheduled is the one place that writes the combined snapshot).
async function runCron(env, prev) {
  const data = await fetchLiquidity();
  const next = {};
  for (const p of data) {
    const isOpen = p.available > 0;
    const wasOpen = prev[p.name]?.open === true;
    next[p.name] = {
      open: isOpen,
      available: p.available,
      utilizationPct: Number((p.utilization * 100).toFixed(2)),
      utilizationCapPct: Number((p.utilizationCap * 100).toFixed(0)),
      checkedAt: new Date().toISOString(),
    };
    if (isOpen && !wasOpen) {
      await broadcast(env, {
        text:
          `🟢 <b>${p.name}</b>\n` +
          `Borrow liquidity is now <b>available</b>: <b>${fmt(p.available)} ${p.symbol}</b>\n` +
          `Utilization: ${(p.utilization * 100).toFixed(2)}%\n` +
          `<a href="${p.url}">Open position on Kamino</a>`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    } else if (!isOpen && wasOpen) {
      await broadcast(env, {
        text:
          `🔴 <b>${p.name}</b>\n` +
          `Borrow liquidity is closed again (utilization ${(p.utilization * 100).toFixed(2)}%).`,
        parse_mode: 'HTML',
        reply_markup: INLINE_KEYBOARD,
      });
    }
  }
  return next;
}

async function handleWebhook(request, env) {
  // Telegram echoes WEBHOOK_SECRET in this header on every POST. Reject anything else.
  if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  const update = await request.json();

  // Inline-keyboard button taps
  if (update.callback_query) {
    const cq = update.callback_query;
    // Best-effort ack so Telegram dismisses the spinner. Don't let an ack failure
    // (expired query id, transient Telegram error) prevent the subscribe + reply.
    try {
      await tg(env, { method: 'answerCallbackQuery', callback_query_id: cq.id });
    } catch (err) {
      console.error('answerCallbackQuery failed (non-fatal):', err.message);
    }
    if (cq.data === 'check') {
      const chatId = cq.message.chat.id;
      const owner = Number(env.TELEGRAM_CHAT_ID);
      // Auto-subscribe on first button tap so users don't have to know about /start.
      // Skip for the owner (they always receive alerts; the notice would be misleading).
      const newlySubscribed = chatId !== owner && (await addSubscriber(env, chatId));
      const data = await fetchLiquidity();
      const prefix = newlySubscribed
        ? "✅ You're now subscribed to alerts (use /stop to unsubscribe).\n\n"
        : '';
      await tg(env, {
        chat_id: chatId,
        text: prefix + formatTable(data),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    }
    return new Response('ok');
  }

  // Text commands
  if (update.message?.text) {
    const text = update.message.text.trim();
    const chatId = update.message.chat.id;
    const owner = Number(env.TELEGRAM_CHAT_ID);

    if (text === '/start') {
      const added = await addSubscriber(env, chatId);
      const data = await fetchLiquidity();
      const isOwner = chatId === owner;
      const subscribeNote = isOwner
        ? '<i>(you are the bot owner — you always receive alerts)</i>\n\n'
        : added
          ? "✅ You're now subscribed.\n\n"
          : '<i>(already subscribed)</i>\n\n';
      await tg(env, {
        chat_id: chatId,
        text: welcomeText() + subscribeNote + formatTable(data),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    } else if (text === '/check') {
      const data = await fetchLiquidity();
      await tg(env, {
        chat_id: chatId,
        text: formatTable(data),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    } else if (text === '/stop') {
      let msg;
      if (chatId === owner) {
        msg = "You're the bot owner — you always receive alerts. /stop is a no-op here.";
      } else {
        const removed = await removeSubscriber(env, chatId);
        msg = removed
          ? '🔕 Unsubscribed. Use /start to subscribe again.'
          : "You weren't subscribed.";
      }
      await tg(env, { chat_id: chatId, text: msg });
    } else if (text === '/status') {
      await tg(env, {
        chat_id: chatId,
        text: await formatStatus(env),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } else if (text === '/who' && chatId === owner) {
      const subs = await getSubscribers(env);
      // Owner always receives, count them in total recipients regardless of /start.
      const all = new Set([...subs, owner]);
      const lines = [...all].map((id) => (id === owner ? `${id} (owner)` : `${id}`));
      await tg(env, {
        chat_id: chatId,
        text: `Total recipients: ${all.size}\n${lines.join('\n')}`,
      });
    }
  }

  return new Response('ok');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleWebhook(request, env);
    } catch (err) {
      console.error('webhook error:', err.stack || err.message);
      return new Response('ok'); // always 200 to Telegram so it doesn't retry-storm
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      handleScheduled(env).catch((err) => console.error('cron error:', err.stack || err.message)),
    );
  },
};
