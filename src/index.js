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
    utilizationCap: 1.0,
    url: `https://kamino.com/multiply/${USDE_MARKET}/2erD9GTGcaQbLsVSQweg3HvMpfKxScmz95raWv8H4iPN/Q5av3wh8j9KCqSjs9njUdsPhrMSKBCUyr4VyUndUUFA`,
  },
];

const INLINE_KEYBOARD = {
  inline_keyboard: [[{ text: '📊 Check liquidity', callback_data: 'check' }]],
};

function fmt(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function fetchLiquidity() {
  // Hit each market's metrics endpoint once, even if multiple pairs use it.
  const markets = [...new Set(PAIRS.map((p) => p.market))];
  const reservesByMarket = new Map(
    await Promise.all(
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
  );

  return PAIRS.map((p) => {
    const r = reservesByMarket.get(p.market).get(p.reserve);
    if (!r) throw new Error(`reserve ${p.reserve} not in market ${p.market}`);
    const totalSupply = Number(r.totalSupply);
    const totalBorrow = Number(r.totalBorrow);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const headroom = Math.max(0, totalSupply * (p.utilizationCap - utilization));
    const cash = Math.max(0, totalSupply - totalBorrow);
    return {
      ...p,
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

function formatTable(data) {
  const lines = ['📊 <b>Borrow Capacity Remaining</b>', ''];
  for (const p of data) {
    const availStr = p.available > 0 ? `${fmt(p.available)} ${p.symbol}` : `0 ${p.symbol}`;
    lines.push(`<b>${p.name}</b>`);
    lines.push(`  Available: ${availStr}`);
    lines.push(`  Utilization: ${(p.utilization * 100).toFixed(2)}%`);
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
  const data = await fetchLiquidity();
  const prev = (await env.STATE.get('state', 'json')) || {};
  const next = {};
  for (const p of data) {
    const isOpen = p.available > 0;
    const wasOpen = prev[p.name]?.open === true;
    next[p.name] = {
      open: isOpen,
      available: p.available,
      utilizationPct: Number((p.utilization * 100).toFixed(2)),
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
  await env.STATE.put('state', JSON.stringify(next));
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
    // ack first so Telegram dismisses the spinner immediately
    await tg(env, { method: 'answerCallbackQuery', callback_query_id: cq.id });
    if (cq.data === 'check') {
      const data = await fetchLiquidity();
      await tg(env, {
        chat_id: cq.message.chat.id,
        text: formatTable(data),
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
      const intro = added
        ? "👋 Subscribed! You'll get a ping when borrow liquidity opens up.\n" +
          'Use /stop to unsubscribe, /check anytime for the current state.\n\n'
        : "👋 You're already subscribed. Current state:\n\n";
      await tg(env, {
        chat_id: chatId,
        text: intro + formatTable(data),
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
    } else if (text === '/who' && chatId === owner) {
      const subs = await getSubscribers(env);
      await tg(env, {
        chat_id: chatId,
        text: `Subscribers: ${subs.size}\n${[...subs].join(', ') || '(empty)'}`,
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
