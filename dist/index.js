var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var MARKET = "47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8";
var KAMINO_URL = `https://api.kamino.finance/kamino-market/${MARKET}/reserves/metrics`;
var UTILIZATION_CAP = 0.9;
var PAIRS = [
  {
    name: "ONyc/USDG Multiply",
    symbol: "USDG",
    reserve: "JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw",
    url: "https://kamino.com/multiply/47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8/6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ/JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw"
  },
  {
    name: "ONyc/USDC Multiply",
    symbol: "USDC",
    reserve: "AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z",
    url: "https://kamino.com/multiply/47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8/6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ/AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z"
  }
];
var INLINE_KEYBOARD = {
  inline_keyboard: [[{ text: "\u{1F4CA} Check liquidity", callback_data: "check" }]]
};
function fmt(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
__name(fmt, "fmt");
async function fetchLiquidity() {
  const res = await fetch(KAMINO_URL, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) throw new Error(`Kamino API ${res.status}`);
  const reserves = await res.json();
  const byAddr = new Map(reserves.map((r) => [r.reserve, r]));
  return PAIRS.map((p) => {
    const r = byAddr.get(p.reserve);
    if (!r) throw new Error(`reserve ${p.reserve} not in API response`);
    const totalSupply = Number(r.totalSupply);
    const totalBorrow = Number(r.totalBorrow);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const headroom = Math.max(0, totalSupply * (UTILIZATION_CAP - utilization));
    const cash = Math.max(0, totalSupply - totalBorrow);
    return {
      ...p,
      utilization,
      available: Math.min(headroom, cash)
    };
  });
}
__name(fetchLiquidity, "fetchLiquidity");
async function tg(env, payload) {
  const method = payload.method || "sendMessage";
  delete payload.method;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${await res.text()}`);
  return res.json();
}
__name(tg, "tg");
function formatTable(data) {
  const lines = ["\u{1F4CA} <b>Borrow Capacity Remaining</b>", ""];
  for (const p of data) {
    const availStr = p.available > 0 ? `${fmt(p.available)} ${p.symbol}` : `0 ${p.symbol}`;
    lines.push(`<b>${p.name}</b>`);
    lines.push(`  Available: ${availStr}`);
    lines.push(`  Utilization: ${(p.utilization * 100).toFixed(2)}%`);
    lines.push("");
  }
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
  lines.push(`<i>Checked: ${ts} UTC</i>`);
  return lines.join("\n");
}
__name(formatTable, "formatTable");
async function handleScheduled(env) {
  const data = await fetchLiquidity();
  const prev = await env.STATE.get("state", "json") || {};
  const next = {};
  for (const p of data) {
    const isOpen = p.available > 0;
    const wasOpen = prev[p.name]?.open === true;
    next[p.name] = {
      open: isOpen,
      available: p.available,
      utilizationPct: Number((p.utilization * 100).toFixed(2)),
      checkedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (isOpen && !wasOpen) {
      await tg(env, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `\u{1F7E2} <b>${p.name}</b>
Borrow liquidity is now <b>available</b>: <b>${fmt(p.available)} ${p.symbol}</b>
Utilization: ${(p.utilization * 100).toFixed(2)}%
<a href="${p.url}">Open position on Kamino</a>`,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD
      });
    } else if (!isOpen && wasOpen) {
      await tg(env, {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: `\u{1F534} <b>${p.name}</b>
Borrow liquidity is closed again (utilization ${(p.utilization * 100).toFixed(2)}%).`,
        parse_mode: "HTML",
        reply_markup: INLINE_KEYBOARD
      });
    }
  }
  await env.STATE.put("state", JSON.stringify(next));
}
__name(handleScheduled, "handleScheduled");
async function handleWebhook(request, env) {
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }
  const update = await request.json();
  if (update.callback_query) {
    const cq = update.callback_query;
    await tg(env, { method: "answerCallbackQuery", callback_query_id: cq.id });
    if (cq.data === "check") {
      const data = await fetchLiquidity();
      await tg(env, {
        chat_id: cq.message.chat.id,
        text: formatTable(data),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD
      });
    }
    return new Response("ok");
  }
  if (update.message?.text) {
    const text = update.message.text.trim();
    if (text === "/start" || text === "/check") {
      const data = await fetchLiquidity();
      await tg(env, {
        chat_id: update.message.chat.id,
        text: (text === "/start" ? "\u{1F44B} Hi! I monitor Kamino multiply liquidity and ping you when it opens.\n\n" : "") + formatTable(data),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD
      });
    }
  }
  return new Response("ok");
}
__name(handleWebhook, "handleWebhook");
var index_default = {
  async fetch(request, env, ctx) {
    try {
      return await handleWebhook(request, env);
    } catch (err) {
      console.error("webhook error:", err.stack || err.message);
      return new Response("ok");
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      handleScheduled(env).catch((err) => console.error("cron error:", err.stack || err.message))
    );
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
