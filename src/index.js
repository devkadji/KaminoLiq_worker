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

// Each pair needs:
//   - reserve / depositReserve: borrow + collateral reserves (for util cap, LTV,
//     borrow APY)
//   - collTokenMint: identifies the collateral's underlying yield in Kamino's
//     /yields/{mint}/history endpoint (ONyc tokenizes a real-world credit pool)
// utilizationCap fields are FALLBACKS only — the actual cap is fetched on-chain
// every tick (see fetchLiveUtilizationCaps). The value here is used only if
// the Solana RPC fetch fails.
const ONYC_COLL_RESERVE = '6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ';
const ONYC_MINT = '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5';

const PAIRS = [
  {
    name: 'ONyc/USDG Multiply',
    symbol: 'USDG',
    market: ONRE_MARKET,
    reserve: 'JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw',
    depositReserve: ONYC_COLL_RESERVE,
    collTokenMint: ONYC_MINT,
    utilizationCap: 0.9,
    // Debt-side reward emitted to USDG borrowers, in USDG/week. Verified on
    // kamino.com tooltip "X.XK WEEKLY" — read off the page; update if Kamino
    // adjusts emissions. Effective APY = weeklyAmount × 52 / debtTotalBorrow,
    // tracks the reserve TVL automatically.
    debtRewardWeekly: 7500,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/${ONYC_COLL_RESERVE}/JBmLCoKqjdKSStK45onRqe6U6sxVgSpdXoeXe4h7NwJw`,
  },
  {
    name: 'ONyc/USDC Multiply',
    symbol: 'USDC',
    market: ONRE_MARKET,
    reserve: 'AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z',
    depositReserve: ONYC_COLL_RESERVE,
    collTokenMint: ONYC_MINT,
    utilizationCap: 0.9,
    debtRewardWeekly: 4370,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/${ONYC_COLL_RESERVE}/AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z`,
  },
  {
    name: 'ONyc/USDS Multiply',
    symbol: 'USDS',
    market: ONRE_MARKET,
    reserve: '3yDc9ARvtPLhYxZLgucZGuBtZ9bHshBvXTwHxGe3nhmC',
    depositReserve: ONYC_COLL_RESERVE,
    collTokenMint: ONYC_MINT,
    utilizationCap: 0.9,
    debtRewardWeekly: 0,
    url: `https://kamino.com/multiply/${ONRE_MARKET}/${ONYC_COLL_RESERVE}/3yDc9ARvtPLhYxZLgucZGuBtZ9bHshBvXTwHxGe3nhmC`,
  },
];

// --- Live on-chain cap reads ---
// Kamino can update a reserve's utilization cap at any time. Hardcoding it
// causes silent drift between the bot's "depositable" calculation and what the
// Kamino UI shows. To stay in sync, we read the actual cap directly from each
// reserve account via Solana RPC with a `dataSlice` (one byte per reserve, ~4
// bytes total per tick — much lighter than running the klend-sdk in a worker).
// Default RPC: api.mainnet-beta.solana.com blocks Cloudflare Workers' egress
// IPs with HTTP 403, so we use Allnodes' publicnode (no key, supports
// `dataSlice`, accepts requests from CF). Override via the SOLANA_RPC secret
// if you want to point at Helius/another provider.
const DEFAULT_SOLANA_RPC = 'https://solana-rpc.publicnode.com';
// Byte offset of `config.utilizationLimitBlockBorrowingAbovePct` (a u8 percent
// value 0..100) within Kamino's Reserve account data. Verified empirically by
// intersecting offsets where multiple reserves' values match across 4
// different debt reserves. Would only need updating if Kamino restructures
// the Reserve account in a program upgrade.
const UTIL_CAP_OFFSET = 5501;

async function fetchLiveUtilizationCaps(env) {
  const rpcUrl = (env && env.SOLANA_RPC) || DEFAULT_SOLANA_RPC;
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
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status} (${rpcUrl})`);
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

// Calibration tier monitor (Binance prices).
//   tier_pct = RATIO_K × p_num / p_den
// RATIO_K is an opaque precomputed calibration constant. p_num and p_den come
// from a pair of Binance spot prices. Buckets: green ≥ RATIO_GREEN, yellow ≥
// RATIO_YELLOW, red below. A broadcast fires once when the bucket transitions
// into red (not every 5-min tick while it stays red) so subscribers aren't
// spammed.
const RATIO_K = 10821.935483870968;
const RATIO_GREEN = 10.2;
const RATIO_YELLOW = 10.1;

function fmt(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function pct(x, digits = 2) {
  if (!Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

function ratioBucket(ratioPct) {
  if (!Number.isFinite(ratioPct)) return null;
  if (ratioPct >= RATIO_GREEN) return 'green';
  if (ratioPct >= RATIO_YELLOW) return 'yellow';
  return 'red';
}

function ratioEmoji(bucket) {
  return bucket === 'green' ? '🟢' : bucket === 'yellow' ? '🟡' : bucket === 'red' ? '🔴' : '⚪';
}

async function fetchBnbNexoRatio() {
  // DefiLlama coins API: edge-friendly, no auth, both prices in one call.
  // Binance (451/418) and CoinGecko's free public endpoint (403) both block
  // many CF datacenter IPs. DefiLlama is purpose-built for serverless/edge.
  const url =
    'https://coins.llama.fi/prices/current/coingecko:binancecoin,coingecko:nexo';
  const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
  if (!res.ok) throw new Error(`Price API ${res.status}`);
  const obj = await res.json();
  const bnb = Number(obj?.coins?.['coingecko:binancecoin']?.price);
  const nexo = Number(obj?.coins?.['coingecko:nexo']?.price);
  if (!Number.isFinite(bnb) || !Number.isFinite(nexo) || bnb <= 0) {
    throw new Error(`Bad price payload: ${JSON.stringify(obj).slice(0, 80)}`);
  }
  const ratioPct = (RATIO_K * nexo) / bnb;
  return { bnb, nexo, ratioPct, bucket: ratioBucket(ratioPct) };
}

function formatRatioLine(r) {
  if (!r) return '⚪ <b>Current tier:</b> <i>fetch failed</i>';
  return `${ratioEmoji(r.bucket)} <b>Current tier:</b> ${r.ratioPct.toFixed(2)}%`;
}

// Each collateral token has an underlying yield (ONyc is a tokenized real-world
// credit pool). Kamino's own UI gets these from /yields/{mint}/history — hourly
// snapshots, take the most recent. We mirror that here so our "Max Leverage
// APY" math uses the same input Kamino displays.
async function fetchCollateralYields() {
  const mints = [...new Set(PAIRS.map((p) => p.collTokenMint))];
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const pairs = await Promise.all(
    mints.map(async (mint) => {
      try {
        const url = `https://api.kamino.finance/yields/${mint}/history?start=${start}&end=${end}`;
        const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
        if (!res.ok) throw new Error(`Kamino yields ${mint}: ${res.status}`);
        const arr = await res.json();
        const last = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
        const apy = last ? Number(last.apy) : NaN;
        return [mint, Number.isFinite(apy) ? apy : 0];
      } catch (e) {
        console.error(`collateral yield fetch failed for ${mint}: ${e.message}`);
        return [mint, 0];
      }
    }),
  );
  return Object.fromEntries(pairs);
}

// Collateral reserves have their own deposit cap (e.g. ONyc currently caps
// supply at 86.5M tokens; once near full, new multiply positions can't open
// even when the debt-side borrow cap has headroom). We fetch the cap + decimals
// from /reserves/{coll}/metrics/history — basic /reserves/metrics doesn't
// include reserveDepositLimit. One small HTTP per unique collateral reserve.
async function fetchCollateralCaps() {
  const seen = new Map();
  for (const p of PAIRS) {
    seen.set(p.depositReserve, { market: p.market, reserve: p.depositReserve });
  }
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const out = await Promise.all(
    [...seen.values()].map(async ({ market, reserve }) => {
      try {
        const url = `https://api.kamino.finance/kamino-market/${market}/reserves/${reserve}/metrics/history?start=${start}&end=${end}`;
        const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
        if (!res.ok) throw new Error(`coll cap ${reserve}: ${res.status}`);
        const data = await res.json();
        const hist = Array.isArray(data?.history) ? data.history : [];
        const m = hist[hist.length - 1]?.metrics;
        if (!m) return [reserve, null];
        const decimals = Number(m.decimals) || 0;
        // 0 = uncapped in klend; treat as Infinity downstream.
        const limitRaw = Number(m.reserveDepositLimit || 0);
        const depositLimit = limitRaw > 0 ? limitRaw / (10 ** decimals) : Infinity;
        return [reserve, { decimals, depositLimit }];
      } catch (e) {
        console.error(`coll cap fetch failed for ${reserve}: ${e.message}`);
        return [reserve, null];
      }
    }),
  );
  return Object.fromEntries(out);
}

// --- Borrow rate from the on-chain curve ---
// Kamino's /reserves/metrics `borrowApy` is systematically inflated: as of
// 2026-08-31 it reads ~1.58x (in APR terms) the rate the on-chain borrow
// curve gives at the reserve's live utilization, for every ONRE debt reserve
// (USDG 14.96% vs 9.25%, USDC 12.23% vs 7.59%). The kamino.com UI's
// "Max Leverage APY" matches the curve value, so using the metrics field made
// our number ~10 points too low. We therefore compute the borrow APY
// ourselves: interpolate the reserve's borrowCurve (from metrics/history,
// where it's exposed) at the live utilization from /reserves/metrics, then
// APR -> APY via continuous compounding (klend compounds per slot).
function borrowApyFromCurve(curve, utilization) {
  if (!Array.isArray(curve) || curve.length < 2) return null;
  const pts = curve
    .map(([x, y]) => [Number(x), Number(y)])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  const u = Math.min(Math.max(utilization, pts[0][0]), pts[pts.length - 1][0]);
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (u <= x1 || i === pts.length - 1) {
      const apr = x1 > x0 ? y0 + ((y1 - y0) * (u - x0)) / (x1 - x0) : y1;
      return Math.expm1(apr);
    }
  }
  return null;
}

// One metrics/history call per debt reserve (the basic /reserves/metrics
// doesn't expose borrowCurve). The curve changes only when Kamino retunes a
// reserve, so a fetch failure just means we fall back to the (inflated)
// metrics borrowApy for that tick — logged, never fatal.
async function fetchDebtCurves() {
  const seen = new Map();
  for (const p of PAIRS) seen.set(p.reserve, p.market);
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const out = await Promise.all(
    [...seen.entries()].map(async ([reserve, market]) => {
      try {
        const url = `https://api.kamino.finance/kamino-market/${market}/reserves/${reserve}/metrics/history?start=${start}&end=${end}`;
        const res = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false } });
        if (!res.ok) throw new Error(`debt curve ${reserve}: ${res.status}`);
        const data = await res.json();
        const hist = Array.isArray(data?.history) ? data.history : [];
        const m = hist[hist.length - 1]?.metrics;
        return [reserve, m?.borrowCurve || null];
      } catch (e) {
        console.error(`debt curve fetch failed for ${reserve}: ${e.message}`);
        return [reserve, null];
      }
    }),
  );
  return Object.fromEntries(out);
}

async function fetchLiquidity(env) {
  // Hit each market's metrics endpoint once, even if multiple pairs use it.
  const markets = [...new Set(PAIRS.map((p) => p.market))];
  // In parallel: per-market metrics, on-chain util caps, per-collateral yields,
  // per-collateral deposit caps.
  const [metricsArr, liveCaps, collYields, collCaps, debtCurves] = await Promise.all([
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
    fetchLiveUtilizationCaps(env).catch((e) => {
      console.error('on-chain cap fetch failed, using hardcoded fallbacks:', e.message);
      return {};
    }),
    fetchCollateralYields(),
    fetchCollateralCaps(),
    fetchDebtCurves(),
  ]);
  const reservesByMarket = new Map(metricsArr);

  return PAIRS.map((p) => {
    const market = reservesByMarket.get(p.market);
    const r = market.get(p.reserve);
    if (!r) throw new Error(`reserve ${p.reserve} not in market ${p.market}`);
    const deposit = market.get(p.depositReserve);
    if (!deposit) throw new Error(`deposit reserve ${p.depositReserve} not in market ${p.market}`);
    // Use live cap when available; fall back to hardcoded if the RPC call failed.
    const utilizationCap = liveCaps[p.reserve] ?? p.utilizationCap;
    const totalSupply = Number(r.totalSupply);
    const totalBorrow = Number(r.totalBorrow);
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;
    const headroom = Math.max(0, totalSupply * (utilizationCap - utilization));
    const cash = Math.max(0, totalSupply - totalBorrow);

    // APY math — mirrors Kamino UI's "Max Leverage APY":
    //   maxLeverage     = 1 / (1 - depositMaxLtv)             (base LTV)
    //   debtRewardApy   = debtRewardWeekly × 52 / totalBorrow (debt-side farm)
    //   combinedBorrow  = debtBorrowApy − debtRewardApy        (net cost)
    //   maxApy          = maxLev × collYield − (maxLev − 1) × combinedBorrow
    // Reward emission rate is hardcoded per pair from the kamino.com tooltip
    // ("X.XK WEEKLY"). Update PAIRS[i].debtRewardWeekly when Kamino changes it.
    const depositMaxLtv = Number(deposit.maxLtv) || 0;
    const collateralYield = collYields[p.collTokenMint] ?? 0;
    // Curve-derived borrow APY (see borrowApyFromCurve). The raw metrics
    // borrowApy is only the fallback when the curve fetch failed.
    const curveApy = borrowApyFromCurve(debtCurves[p.reserve], utilization);
    const debtBorrowApy = curveApy ?? (Number(r.borrowApy) || 0);
    const debtRewardApy = totalBorrow > 0
      ? (p.debtRewardWeekly * 52) / totalBorrow
      : 0;
    const combinedBorrowApy = Math.max(0, debtBorrowApy - debtRewardApy);
    const maxLeverage = depositMaxLtv > 0 && depositMaxLtv < 1
      ? 1 / (1 - depositMaxLtv)
      : 1;
    const maxApy = maxLeverage * collateralYield - (maxLeverage - 1) * combinedBorrowApy;

    // Borrow-side headroom (existing math: min of util-cap room and cash).
    const borrowSideAvailable = Math.min(headroom, cash);

    // Collateral-side headroom translated into equivalent additional debt-
    // borrow capacity. For a multiply position at leverage L with $E of equity,
    // the position supplies E×L of collateral (USD) and borrows E×(L-1) of
    // debt. Inverting: the maximum new debt-borrow allowed by a coll-cap C is
    // C_usd × (L-1)/L. Since our debt tokens are USD stablecoins (~$1), this
    // is directly comparable to borrowSideAvailable.
    const collCap = collCaps[p.depositReserve];
    const collTotalSupply = Number(deposit.totalSupply);
    const collTotalSupplyUsd = Number(deposit.totalSupplyUsd);
    const collPriceUsd = collTotalSupply > 0 ? collTotalSupplyUsd / collTotalSupply : 1;
    let collHeadroomTokens = Infinity;
    let collEqAvailable = Infinity;
    if (collCap && Number.isFinite(collCap.depositLimit)) {
      collHeadroomTokens = Math.max(0, collCap.depositLimit - collTotalSupply);
      if (maxLeverage > 1) {
        collEqAvailable = collHeadroomTokens * collPriceUsd * (maxLeverage - 1) / maxLeverage;
      }
    }

    const available = Math.min(borrowSideAvailable, collEqAvailable);
    // Tag which cap is the binding constraint so the alert can call it out.
    // Default 'borrow' when both are equal or coll data unavailable.
    const bindingCap = collEqAvailable < borrowSideAvailable ? 'collateral' : 'borrow';

    return {
      ...p,
      utilizationCap,         // overrides the hardcoded value with the live one
      utilization,
      available,
      borrowSideAvailable,
      bindingCap,
      collHeadroomTokens: Number.isFinite(collHeadroomTokens) ? collHeadroomTokens : null,
      collTokenSymbol: deposit.liquidityToken,
      collateralYield,
      debtBorrowApy,
      debtRewardApy,
      combinedBorrowApy,
      depositMaxLtv,
      maxLeverage,
      maxApy,
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
  ];
  // Ratio block from the last cron tick (snapshots written by older deploys
  // won't have this field — skip silently).
  if (snapshot.ratio && Number.isFinite(snapshot.ratio.ratioPct)) {
    const r = snapshot.ratio;
    lines.push(
      `Current tier:     ${ratioEmoji(r.bucket)} ${r.ratioPct.toFixed(2)}%` +
        ` (${relTime(r.checkedAt)})`,
    );
  }
  lines.push('');
  lines.push('<b>Per-pair last seen:</b>');
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
    const bindingStr = s.bindingCap === 'collateral'
      ? `  <i>binding: ${s.collTokenSymbol || 'coll'} supply</i>`
      : '';
    const summary = s.open
      ? `🟢 <b>depositable: yes</b> (${fmt(s.available)} ${p.symbol})${bindingStr}`
      : `🔴 <b>depositable: no</b>  <i>util ${utilStr}% / cap ${capStr}%</i>${bindingStr}`;
    lines.push(`  ${p.name}  ${summary}  (${relTime(s.checkedAt)})`);
    // APY block exists only on snapshots written by post-APY deploys; skip on older.
    if (s.maxApyPct != null && s.maxLeverage != null) {
      const borrowStr = (s.debtRewardApyPct ?? 0) > 0
        ? `borrow ${(s.debtBorrowApyPct ?? 0).toFixed(2)}% − reward ${s.debtRewardApyPct.toFixed(2)}%`
        : `borrow ${(s.debtBorrowApyPct ?? 0).toFixed(2)}%`;
      lines.push(
        `    <i>max-lev APY ${s.maxApyPct.toFixed(2)}% @ ${s.maxLeverage.toFixed(2)}x` +
          ` · coll ${(s.collateralYieldPct ?? 0).toFixed(2)}% · ${borrowStr}</i>`,
      );
    }
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

function formatTable(data, ratio) {
  const lines = ['📊 <b>Borrow Capacity Remaining</b>', ''];
  lines.push(formatRatioLine(ratio));
  lines.push('');
  for (const p of data) {
    const utilStr = (p.utilization * 100).toFixed(2);
    const capStr = (p.utilizationCap * 100).toFixed(0);
    lines.push(`<b>${p.name}</b>`);
    const bindingStr = p.bindingCap === 'collateral'
      ? ` <i>(binding: ${p.collTokenSymbol || 'coll'} supply${p.collHeadroomTokens != null ? `, ${fmt(p.collHeadroomTokens)} ${p.collTokenSymbol || ''} cap headroom` : ''})</i>`
      : '';
    if (p.available > 0) {
      lines.push(`  🟢 <b>Depositable: yes</b> — ${fmt(p.available)} ${p.symbol}${bindingStr}`);
    } else {
      lines.push(`  🔴 <b>Depositable: no</b>${bindingStr}`);
    }
    lines.push(`  <i>util ${utilStr}% / cap ${capStr}%</i>`);
    const borrowStr = p.debtRewardApy > 0
      ? `borrow ${pct(p.debtBorrowApy)} − reward ${pct(p.debtRewardApy)} = ${pct(p.combinedBorrowApy)}`
      : `borrow ${pct(p.debtBorrowApy)}`;
    lines.push(
      `  <i>max-lev APY ${pct(p.maxApy)} @ ${p.maxLeverage.toFixed(2)}x` +
        ` · coll ${pct(p.collateralYield)} · ${borrowStr}</i>`,
    );
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

// Dead-man's-switch heartbeat. Cloudflare can silently stop invoking a Worker's
// cron trigger while leaving the schedule registered (observed 2026-07-19: the
// */5 schedule stalled for ~33h with no error). A watchdog INSIDE this worker
// can't detect its own non-execution, so we ping an EXTERNAL monitor
// (healthchecks.io / cron-job.org / betterstack) on every tick. When the pings
// stop, that monitor alerts — catching a stalled cron in minutes, not days.
//
// Set the ping URL as a secret:  wrangler secret put HEARTBEAT_URL
// No-ops if unset, so the worker runs fine without it. Never throws — a
// monitoring failure must not affect the actual liquidity check.
async function pingHeartbeat(env, ok) {
  const base = env && env.HEARTBEAT_URL;
  if (!base) return;
  // healthchecks.io convention: POST <url> on success, <url>/fail on failure.
  const url = ok ? base : `${base.replace(/\/$/, '')}/fail`;
  try {
    await fetch(url, { method: 'POST' });
  } catch (err) {
    console.error('heartbeat ping failed (non-fatal):', err.message);
  }
}

async function handleScheduled(env) {
  // Load previous snapshot (pairs + last tick) in one read. We'll write the
  // updated combined snapshot ONCE at the end — saves 1 KV write per tick
  // compared to the old two-key approach (`state` + `lastTick`).
  const snapshot = await loadSnapshot(env);
  const tickRecord = { at: new Date().toISOString(), ok: false };
  let nextPairs = snapshot.pairs || {};
  let nextRatio = snapshot.ratio || null;
  let caught = null;
  try {
    // Pairs and ratio fetched in parallel — independent endpoints. A ratio
    // fetch failure must not abort the pair-check tick (and vice versa).
    const [pairsResult, ratioResult] = await Promise.allSettled([
      runCron(env, snapshot.pairs || {}),
      runRatioCheck(env, snapshot.ratio || null),
    ]);
    if (pairsResult.status === 'fulfilled') {
      nextPairs = pairsResult.value;
    } else {
      throw pairsResult.reason;
    }
    if (ratioResult.status === 'fulfilled') {
      nextRatio = ratioResult.value;
    } else {
      console.error('ratio check failed:', ratioResult.reason?.message || ratioResult.reason);
      // Keep prior ratio in the snapshot so /status still shows stale-but-real data.
    }
    tickRecord.ok = true;
  } catch (err) {
    tickRecord.error = String(err.message || err).slice(0, 200);
    caught = err;
  }
  // Single write — combines tick heartbeat + per-pair state + ratio state.
  await env.STATE.put(
    'snapshot',
    JSON.stringify({ tick: tickRecord, pairs: nextPairs, ratio: nextRatio }),
  );
  // External dead-man's switch — fires whether or not the tick succeeded so a
  // repeatedly-failing cron is caught too (via the /fail path). Awaited but
  // non-fatal (pingHeartbeat swallows its own errors).
  await pingHeartbeat(env, tickRecord.ok);
  if (caught) throw caught;
}

// Fetches the calibration tier, broadcasts once on transition INTO red,
// returns the new snapshot field. Stays mute while already-red (avoids
// 5-min spam).
async function runRatioCheck(env, prev) {
  const r = await fetchBnbNexoRatio();
  const prevBucket = prev?.bucket ?? null;
  if (r.bucket === 'red' && prevBucket !== 'red') {
    await broadcast(env, {
      text:
        `🔴 <b>Current tier:</b> ${r.ratioPct.toFixed(2)}%\n` +
        `Below the ${RATIO_YELLOW}% threshold.`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: INLINE_KEYBOARD,
    });
  }
  return {
    bnb: r.bnb,
    nexo: r.nexo,
    ratioPct: Number(r.ratioPct.toFixed(4)),
    bucket: r.bucket,
    checkedAt: new Date().toISOString(),
  };
}

// Pure-ish: takes the previous per-pair state in, returns the new per-pair
// state out. Side effects = Telegram broadcasts on transitions. No KV writes
// (handleScheduled is the one place that writes the combined snapshot).
async function runCron(env, prev) {
  const data = await fetchLiquidity(env);
  const next = {};
  for (const p of data) {
    const isOpen = p.available > 0;
    const wasOpen = prev[p.name]?.open === true;
    next[p.name] = {
      open: isOpen,
      available: p.available,
      borrowSideAvailable: p.borrowSideAvailable,
      bindingCap: p.bindingCap,
      collHeadroomTokens: p.collHeadroomTokens,
      collTokenSymbol: p.collTokenSymbol,
      utilizationPct: Number((p.utilization * 100).toFixed(2)),
      utilizationCapPct: Number((p.utilizationCap * 100).toFixed(0)),
      maxApyPct: Number((p.maxApy * 100).toFixed(2)),
      maxLeverage: Number(p.maxLeverage.toFixed(2)),
      collateralYieldPct: Number((p.collateralYield * 100).toFixed(2)),
      debtBorrowApyPct: Number((p.debtBorrowApy * 100).toFixed(2)),
      debtRewardApyPct: Number((p.debtRewardApy * 100).toFixed(2)),
      combinedBorrowApyPct: Number((p.combinedBorrowApy * 100).toFixed(2)),
      checkedAt: new Date().toISOString(),
    };
    if (isOpen && !wasOpen) {
      const rewardStr = p.debtRewardApy > 0
        ? `, borrow ${pct(p.debtBorrowApy)} − reward ${pct(p.debtRewardApy)}`
        : `, borrow ${pct(p.debtBorrowApy)}`;
      const bindingLine = p.bindingCap === 'collateral'
        ? `Binding cap: ${p.collTokenSymbol || 'coll'} supply (${fmt(p.collHeadroomTokens)} ${p.collTokenSymbol || ''} headroom)\n`
        : '';
      await broadcast(env, {
        text:
          `🟢 <b>${p.name}</b>\n` +
          `Borrow liquidity is now <b>available</b>: <b>${fmt(p.available)} ${p.symbol}</b>\n` +
          bindingLine +
          `Utilization: ${(p.utilization * 100).toFixed(2)}%\n` +
          `Max-lev APY: ${pct(p.maxApy)} @ ${p.maxLeverage.toFixed(2)}x ` +
          `(coll ${pct(p.collateralYield)}${rewardStr})\n` +
          `<a href="${p.url}">Open position on Kamino</a>`,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    } else if (!isOpen && wasOpen) {
      const reasonStr = p.bindingCap === 'collateral'
        ? `${p.collTokenSymbol || 'collateral'} supply at cap`
        : `utilization ${(p.utilization * 100).toFixed(2)}%`;
      await broadcast(env, {
        text:
          `🔴 <b>${p.name}</b>\n` +
          `Borrow liquidity is closed again (${reasonStr}).`,
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
      const [data, ratio] = await Promise.all([
        fetchLiquidity(env),
        fetchBnbNexoRatio().catch((e) => {
          console.error('ratio fetch failed:', e.message);
          return null;
        }),
      ]);
      const prefix = newlySubscribed
        ? "✅ You're now subscribed to alerts (use /stop to unsubscribe).\n\n"
        : '';
      await tg(env, {
        chat_id: chatId,
        text: prefix + formatTable(data, ratio),
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
      const [data, ratio] = await Promise.all([
        fetchLiquidity(env),
        fetchBnbNexoRatio().catch((e) => {
          console.error('ratio fetch failed:', e.message);
          return null;
        }),
      ]);
      const isOwner = chatId === owner;
      const subscribeNote = isOwner
        ? '<i>(you are the bot owner — you always receive alerts)</i>\n\n'
        : added
          ? "✅ You're now subscribed.\n\n"
          : '<i>(already subscribed)</i>\n\n';
      await tg(env, {
        chat_id: chatId,
        text: welcomeText() + subscribeNote + formatTable(data, ratio),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: INLINE_KEYBOARD,
      });
    } else if (text === '/check') {
      const [data, ratio] = await Promise.all([
        fetchLiquidity(env),
        fetchBnbNexoRatio().catch((e) => {
          console.error('ratio fetch failed:', e.message);
          return null;
        }),
      ]);
      await tg(env, {
        chat_id: chatId,
        text: formatTable(data, ratio),
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
