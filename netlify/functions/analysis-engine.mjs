/* ==========================================================
   TRADE EDGE – ANALYSIS ENGINE (pure functions, no network)
   api.mjs downloads the data (Yahoo Finance, Forex Factory,
   news RSS feeds, CFTC COT) and hands it to these functions.
   Output = one structured "report" per pair (see buildReport).
========================================================== */

export const FX_CODES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']);

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const rnd = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);

/* ---------- which instrument is it? ---------- */
export function pairInfo(symbol) {
  const clean = String(symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (clean === 'XAUUSD' || clean === 'XAGUSD') {
    return { kind: 'metal', base: clean.slice(0, 3), quote: 'USD', ccys: ['USD'], metal: clean.slice(0, 3) };
  }
  if (clean.length === 6 && FX_CODES.has(clean.slice(0, 3)) && FX_CODES.has(clean.slice(3))) {
    return { kind: 'fx', base: clean.slice(0, 3), quote: clean.slice(3), ccys: [clean.slice(0, 3), clean.slice(3)], metal: '' };
  }
  return { kind: 'other', base: '', quote: '', ccys: [], metal: '' };
}

const YAHOO_TICKERS = {
  'XAU/USD': 'GC=F', 'XAG/USD': 'SI=F', 'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
  'USD/JPY': 'JPY=X', 'USD/CHF': 'CHF=X', 'USD/CAD': 'CAD=X',
  'USOIL': 'CL=F', 'WTI': 'CL=F', 'US30': '^DJI', 'NAS100': '^NDX', 'US100': '^NDX',
  'SPX500': '^GSPC', 'US500': '^GSPC', 'GER40': '^GDAXI', 'DAX': '^GDAXI'
};
export function yahooTicker(symbol) {
  const key = String(symbol || '').toUpperCase().trim();
  if (YAHOO_TICKERS[key]) return YAHOO_TICKERS[key];
  const clean = key.replace(/[^A-Z]/g, '');
  return clean.length === 6 ? clean + '=X' : '';
}

/* CFTC "Commitments of Traders" market names (legacy futures-only report) */
export const COT_NAMES = {
  EUR: 'EURO FX - CHICAGO%', GBP: 'BRITISH POUND%', JPY: 'JAPANESE YEN%', CHF: 'SWISS FRANC%',
  CAD: 'CANADIAN DOLLAR%', AUD: 'AUSTRALIAN DOLLAR%', NZD: 'NEW ZEALAND DOLLAR%',
  USD: 'USD INDEX%', XAU: 'GOLD - COMMODITY EXCHANGE%', XAG: 'SILVER - COMMODITY EXCHANGE%'
};
export const cotCurrencies = info => (info.kind === 'metal' ? [info.metal] : info.kind === 'fx' ? info.ccys : []);

/* ---------- indicators ---------- */
export function sma(v, n) {
  if (v.length < n) return null;
  let s = 0;
  for (let i = v.length - n; i < v.length; i++) s += v[i];
  return s / n;
}

function emaSeries(v, n) {
  const out = new Array(v.length).fill(NaN);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let e = v.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

/* Wilder RSI (the same RSI that TradingView shows) */
export function rsiWilder(v, n = 14) {
  if (v.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function atrWilder(h, l, c, n = 14) {
  if (c.length <= n) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

export function macd(v) {
  if (v.length < 40) return null;
  const e12 = emaSeries(v, 12), e26 = emaSeries(v, 26);
  const line = v.map((_, i) => (Number.isFinite(e12[i]) && Number.isFinite(e26[i]) ? e12[i] - e26[i] : NaN)).filter(Number.isFinite);
  const sig = emaSeries(line, 9);
  const hist = line.map((x, i) => (Number.isFinite(sig[i]) ? x - sig[i] : NaN)).filter(Number.isFinite);
  if (hist.length < 2) return null;
  return { line: line[line.length - 1], signal: sig[sig.length - 1], hist: hist[hist.length - 1], prevHist: hist[hist.length - 2] };
}

/* swing highs / lows (fractals) */
export function swings(h, l, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < h.length - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (h[i] <= h[i - j] || h[i] <= h[i + j]) isH = false;
      if (l[i] >= l[i - j] || l[i] >= l[i + j]) isL = false;
    }
    if (isH) hi.push({ i, p: h[i] });
    if (isL) lo.push({ i, p: l[i] });
  }
  return { hi, lo };
}

const trendOf = (p, a, b) => (a == null ? 'neutral'
  : p > a && (b == null || a >= b) ? 'bullish'
  : p < a && (b == null || a <= b) ? 'bearish' : 'neutral');
const tval = t => (t === 'bullish' ? 1 : t === 'bearish' ? -1 : 0);

function weekStartUtc(ms) {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7;                 // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/* ---------- TECHNICAL: daily + weekly candles -> numbers, levels, score ---------- */
export function techFromCandles(D, W, nowMs = Date.now()) {
  const { c, h, l } = D;
  const n = c.length;
  const price = c[n - 1], prev = c[n - 2];
  const dec = price >= 500 ? 2 : price >= 50 ? 3 : 5;
  const r = x => rnd(x, dec);

  const s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
  const rsi14 = rsiWilder(c, 14);
  const m = macd(c);
  const atr = atrWilder(h, l, c, 14);
  const hi20 = Math.max(...h.slice(-20)), lo20 = Math.min(...l.slice(-20));
  const pos20 = hi20 > lo20 ? (price - lo20) / (hi20 - lo20) : 0.5;
  const sw = swings(h.slice(-120), l.slice(-120), 3);
  let structure = 'range';
  if (sw.hi.length >= 2 && sw.lo.length >= 2) {
    const [h1, h2] = sw.hi.slice(-2).map(x => x.p);
    const [l1, l2] = sw.lo.slice(-2).map(x => x.p);
    if (h2 > h1 && l2 > l1) structure = 'bullish';
    else if (h2 < h1 && l2 < l1) structure = 'bearish';
  }
  const d1trend = trendOf(price, s20, s50);

  let w = null;
  if (W && W.c.length >= 12) {
    const wc = W.c, wp = wc[wc.length - 1];
    const ws10 = sma(wc, 10), ws20 = sma(wc, 20);
    const watr = atrWilder(W.h, W.l, wc, 14);
    w = { trend: trendOf(wp, ws10, ws20), sma10: r(ws10), sma20: r(ws20), rsi14: rnd(rsiWilder(wc, 14), 1), atr: r(watr) };
    const cut = weekStartUtc(nowMs) - 12 * 3600e3;
    let pi = -1;
    for (let i = W.t.length - 1; i >= 0; i--) if (W.t[i] < cut) { pi = i; break; }
    if (pi >= 0) {
      const H = W.h[pi], L = W.l[pi], C = wc[pi], P = (H + L + C) / 3;
      w.prev = { high: r(H), low: r(L), close: r(C) };
      w.pivots = { pp: r(P), r1: r(2 * P - L), s1: r(2 * P - H), r2: r(P + (H - L)), s2: r(P - (H - L)) };
    }
  }

  /* support / resistance: swing points + last week high/low + weekly pivots + 20-day range */
  const atrRef = (w && w.atr) ? w.atr / 2.2 : (atr || price * 0.005);
  const cand = [];
  sw.hi.concat(sw.lo).forEach(x => cand.push({ p: x.p, tag: 'swing' }));
  cand.push({ p: hi20, tag: 'range20High' }, { p: lo20, tag: 'range20Low' });
  if (w && w.prev) cand.push({ p: w.prev.high, tag: 'prevWeekHigh' }, { p: w.prev.low, tag: 'prevWeekLow' });
  if (w && w.pivots) for (const k of ['r2', 'r1', 'pp', 's1', 's2']) cand.push({ p: w.pivots[k], tag: 'pivot' });
  const gap = atrRef * 0.4;
  const pick = arr => {
    const out = [];
    for (const x of arr) { if (out.every(o => Math.abs(o.p - x.p) >= gap)) out.push(x); if (out.length === 2) break; }
    return out.map(x => ({ p: r(x.p), tag: x.tag }));
  };
  const resistance = pick(cand.filter(x => x.p > price + atrRef * 0.15).sort((a, b) => a.p - b.p));
  const support = pick(cand.filter(x => x.p < price - atrRef * 0.15).sort((a, b) => b.p - a.p));

  /* technical score  -1 … +1 */
  let sc = 0.25 * tval(d1trend) + 0.15 * tval(structure), used = 0.4;
  if (w) { sc += 0.25 * tval(w.trend); used += 0.25; }
  if (m) { sc += 0.15 * sign(m.hist) * (Math.abs(m.hist) > Math.abs(m.prevHist) ? 1 : 0.6); used += 0.15; }
  if (rsi14 != null) { sc += 0.1 * (rsi14 > 55 ? 1 : rsi14 < 45 ? -1 : 0); used += 0.1; }
  if (s200 != null) { sc += 0.1 * (price > s200 ? 1 : -1); used += 0.1; }
  const score = clamp(sc / used);

  return {
    price: r(price), dailyPct: prev ? rnd((price / prev - 1) * 100, 2) : null, decimals: dec,
    d1: { trend: d1trend, sma20: r(s20), sma50: r(s50), sma200: r(s200), rsi14: rnd(rsi14, 1), atr: r(atr),
      macdHist: m ? rnd(m.hist, dec + 1) : null, macdRising: m ? Math.abs(m.hist) > Math.abs(m.prevHist) && sign(m.hist) === sign(m.prevHist) : null },
    w1: w, structure, range20: { high: r(hi20), low: r(lo20), pos: rnd(pos20 * 100, 0) },
    expectedWeekRange: r((w && w.atr) ? w.atr : (atr ? atr * 2.2 : null)),
    support, resistance, score: rnd(score, 3),
    overbought: rsi14 != null && rsi14 >= 70, oversold: rsi14 != null && rsi14 <= 30
  };
}

/* cross-market instruments (DXY, US10Y, S&P500, VIX) */
export function contextFromCandles(D) {
  const c = D.c, n = c.length, last = c[n - 1];
  return {
    last: rnd(last, 3), d1: rnd((last / c[n - 2] - 1) * 100, 2),
    d20: n > 21 ? rnd((last / c[n - 21] - 1) * 100, 2) : null,
    trend: trendOf(last, sma(c, 20), sma(c, 50))
  };
}

const RISK_BETA = { AUD: 1, NZD: 1, CAD: 0.5, GBP: 0.3, EUR: 0.2, USD: -0.3, JPY: -1, CHF: -0.6, XAU: -0.2, XAG: 0.1 };

export function interReport(info, ctx) {
  if (!ctx || info.kind === 'other') return null;
  const tr = k => (ctx[k] ? tval(ctx[k].trend) : 0);
  const usdSide = info.base === 'USD' ? 1 : info.quote === 'USD' ? -1 : 0;
  const dxy = tr('DXY'), tnx = tr('US10Y'), spx = tr('SPX');
  const vix = ctx.VIX;
  const vixTone = vix ? (-tval(vix.trend) * 0.3 + (vix.last > 25 ? -0.3 : vix.last < 15 ? 0.2 : 0)) : 0;
  const riskTone = clamp(spx * 0.7 + vixTone);
  const beta = (RISK_BETA[info.base] ?? 0) - (RISK_BETA[info.quote] ?? 0);

  const eDxy = usdSide * dxy;
  const eTnx = info.kind === 'metal' ? -tnx : (info.base === 'USD' && info.quote === 'JPY') ? tnx : usdSide * tnx;
  const eRisk = riskTone * beta;
  const score = clamp(eDxy * 0.5 + eTnx * (info.kind === 'metal' || (info.base === 'USD' && info.quote === 'JPY') ? 0.3 : 0.15) + eRisk * 0.4);

  const eff = v => (v > 0.05 ? 'bullish' : v < -0.05 ? 'bearish' : 'neutral');
  const rows = [];
  if (ctx.DXY) rows.push({ key: 'DXY', ...ctx.DXY, effect: eff(eDxy) });
  if (ctx.US10Y) rows.push({ key: 'US10Y', ...ctx.US10Y, effect: eff(eTnx) });
  if (ctx.SPX) rows.push({ key: 'SPX', ...ctx.SPX, effect: eff(eRisk) });
  if (ctx.VIX) rows.push({ key: 'VIX', ...ctx.VIX, effect: eff(eRisk) });
  return rows.length ? { score: rnd(score, 3), rows } : null;
}

/* ---------- FUNDAMENTAL 1: calendar (event risk) ---------- */
export function calendarReport(info, news, nowMs = Date.now()) {
  if (!info.ccys.length) return { events: [], highCount: 0, mediumCount: 0, next: null };
  const rel = (news || []).filter(n => info.ccys.includes(String(n.currency || '').toUpperCase()) && /high|medium/i.test(String(n.impact || '')))
    .map(n => ({
      ccy: String(n.currency || '').toUpperCase(), title: n.title, impact: /high/i.test(n.impact) ? 'High' : 'Medium',
      datetime: new Date(n.datetime).toISOString(), forecast: n.forecast || '', previous: n.previous || '', actual: n.actual || ''
    }))
    .sort((a, b) => a.datetime.localeCompare(b.datetime));
  const high = rel.filter(e => e.impact === 'High');
  const picked = high.concat(rel.filter(e => e.impact !== 'High')).slice(0, 14).sort((a, b) => a.datetime.localeCompare(b.datetime));
  const next = high.find(e => Date.parse(e.datetime) > nowMs) || null;
  return { events: picked, highCount: high.length, mediumCount: rel.length - high.length, next };
}

/* ---------- FUNDAMENTAL 2: headline tone from news sites ---------- */
const CCY_WORDS = {
  USD: /\b(usd|dollar|greenback|fed|fomc|powell|treasur\w*|nonfarm|payrolls?|us (?:cpi|inflation|economy|jobs|gdp))\b/i,
  EUR: /\b(eur|euro|ecb|lagarde|eurozone|euro area|bund|german\w*)\b/i,
  GBP: /\b(gbp|pound|sterling|boe|bank of england|bailey|gilts?|uk (?:cpi|gdp|inflation|economy|jobs))\b/i,
  JPY: /\b(jpy|yen|boj|bank of japan|ueda|japan\w*|jgb)\b/i,
  CHF: /\b(chf|franc|snb|swiss)\b/i,
  AUD: /\b(aud|aussie|rba|australia\w*)\b/i,
  NZD: /\b(nzd|kiwi|rbnz|new zealand)\b/i,
  CAD: /\b(cad|loonie|boc|bank of canada|canad\w*)\b/i,
  XAU: /\b(gold|xau|bullion)\b/i,
  XAG: /\b(silver|xag)\b/i
};
const POS = /\b(hawkish|hikes?|hiked|raise[sd]? (?:rates?|interest)|rate hike|stronger|strong|beats?|rall(?:y|ies|ied)|gains?|gained|rises?|rose|jumps?|jumped|surges?|surged|climbs?|climbed|higher|firm|boost\w*|upbeat|resilient|hotter|hot|accelerat\w*|robust|optimis\w*|upgrade[sd]?|lifts?|advances?)\b/gi;
const NEG = /\b(dovish|cuts?|rate cut|weaker|weak|miss(?:es|ed)?|falls?|fell|drops?|dropped|slump\w*|slides?|slid|tumbles?|tumbled|lower|recession|slowdown|slow\w*|contract\w*|concerns?|worr\w*|downgrade[sd]?|sell-?off|declines?|declined|losses|loses|plunge[sd]?|easing|eases?|eased|pressure|slips?|slipped)\b/gi;

function mentioned(title) {
  const t = String(title || '').replace(/\b(canadian|australian|new zealand|aussie|kiwi|hong kong|singapore)\s+dollars?\b/gi, ' $1 ');
  return Object.keys(CCY_WORDS).filter(k => CCY_WORDS[k].test(t));
}
const toneOf = title => {
  const p = (String(title).match(POS) || []).length, n = (String(title).match(NEG) || []).length;
  return sign(p - n);
};

export function headlineReport(info, items) {
  if (!info.ccys.length || !Array.isArray(items) || !items.length) return null;
  const watch = info.kind === 'metal' ? [info.metal, 'USD'] : info.ccys;
  const sum = {}, cnt = {};
  watch.forEach(k => { sum[k] = 0; cnt[k] = 0; });
  const rel = [];
  for (const it of items) {
    const ms = mentioned(it.title);
    const hit = ms.filter(k => watch.includes(k));
    if (!hit.length) continue;
    const tone = toneOf(it.title);
    const exclusive = ms.length === 1;                    // headline talks about one currency only -> safe to score
    if (exclusive) { sum[hit[0]] += tone; cnt[hit[0]] += 1; }
    rel.push({ title: it.title, link: it.link || '', source: it.source || '', datetime: it.datetime || '', tone: exclusive ? tone : null });
  }
  const tones = {};
  watch.forEach(k => { tones[k] = { tone: rnd(sum[k] / (cnt[k] + 3), 2), n: cnt[k] }; });   // +3 = shrink small samples
  const scored = watch.reduce((a, k) => a + cnt[k], 0);
  let score = 0;
  if (info.kind === 'metal') score = clamp(tones[info.metal].tone - 0.5 * tones.USD.tone);
  else score = clamp((tones[info.base].tone - tones[info.quote].tone) * 1.2);
  return { score: rnd(score, 3), scored, total: rel.length, tones, items: rel.slice(0, 5) };
}

/* ---------- POSITIONING: CFTC COT (large speculators) ---------- */
export function cotReport(info, map) {
  const ccys = cotCurrencies(info);
  if (!ccys.length || !map) return null;
  const items = ccys.map(c => (map[c] ? { ccy: c, ...map[c] } : null)).filter(Boolean);
  if (!items.length) return null;
  let tilt;
  if (info.kind === 'metal') tilt = items[0].ratio;
  else {
    const b = map[info.base], q = map[info.quote];
    tilt = (b ? b.ratio : 0) - (q ? q.ratio : 0);
  }
  return { score: rnd(clamp(tilt * 2), 3), items };
}

/* ---------- POSITIONING: the buyer/seller % you typed in the bot (read as a crowd, contrarian) ---------- */
export function retailReport(buy, sell) {
  const b = Number(buy), s = Number(sell);
  if (!Number.isFinite(b) || !Number.isFinite(s) || b + s <= 0) return null;
  const bp = b / (b + s) * 100;
  const score = Math.abs(bp - 50) < 10 ? 0 : clamp((50 - bp) / 25);
  return { buy: rnd(bp, 0), sell: rnd(100 - bp, 0), score: rnd(score, 3), crowd: bp >= 60 ? 'long' : bp <= 40 ? 'short' : 'balanced' };
}

/* ---------- put everything together ---------- */
const WEIGHTS = { tech: 0.45, fund: 0.25, cot: 0.12, inter: 0.12, retail: 0.06 };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtDay = iso => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });

export function buildReport({ symbol, info, tech, calendar, headlines, cot, inter, retail, sources, nowMs = Date.now() }) {
  const factors = [];
  if (tech) factors.push({ key: 'tech', score: tech.score, weight: WEIGHTS.tech });
  if (headlines && headlines.scored >= 2) factors.push({ key: 'fund', score: headlines.score, weight: WEIGHTS.fund * Math.min(1, headlines.scored / 6) });   // few headlines = less weight
  if (cot) factors.push({ key: 'cot', score: cot.score, weight: WEIGHTS.cot });
  if (inter) factors.push({ key: 'inter', score: inter.score, weight: WEIGHTS.inter });
  if (retail) factors.push({ key: 'retail', score: retail.score, weight: WEIGHTS.retail });
  if (!factors.length) return null;

  const wsum = factors.reduce((a, f) => a + f.weight, 0);
  const total = factors.reduce((a, f) => a + f.weight * f.score, 0) / wsum * 100;
  const score = Math.round(total);
  const bias = score >= 18 ? 'bullish' : score <= -18 ? 'bearish' : 'neutral';
  const agree = factors.filter(f => sign(f.score) === sign(total) && Math.abs(f.score) >= 0.1).length;
  const ratio = agree / factors.length;
  const confidence = (Math.abs(score) >= 45 && ratio >= 0.7 && factors.length >= 3) ? 'high'
    : (Math.abs(score) >= 25 && ratio >= 0.5) ? 'medium' : 'low';

  const notes = [];
  if (tech && tech.overbought) notes.push('overbought');
  if (tech && tech.oversold) notes.push('oversold');
  if (calendar && calendar.next && Date.parse(calendar.next.datetime) - nowMs < 36 * 3600e3) notes.push('eventSoon');
  const fF = factors.find(f => f.key === 'fund'), fT = factors.find(f => f.key === 'tech');
  if (fF && fT && Math.abs(fF.score) >= 0.3 && Math.abs(fT.score) >= 0.3 && sign(fF.score) !== sign(fT.score)) notes.push('conflict');
  if (retail && retail.crowd !== 'balanced' && Math.abs(retail.buy - 50) >= 15) notes.push('crowded');
  if (tech && tech.stale) notes.push('staleTech');
  if (calendar && calendar.highCount >= 3) notes.push('busyWeek');

  /* English text (Telegram weekly plan + control panel). The website builds its own text in EN / አማ from the numbers. */
  const sg = x => (x > 0 ? '+' : '') + x;
  const levels = tech ? [
    tech.support.length ? 'Support ' + tech.support.map(x => x.p).join(' / ') : '',
    tech.resistance.length ? 'Resistance ' + tech.resistance.map(x => x.p).join(' / ') : ''
  ].filter(Boolean).join(' · ') : '';
  const techText = tech ? [
    `Daily ${cap(tech.d1.trend)}`, tech.w1 ? `Weekly ${cap(tech.w1.trend)}` : '', `Structure ${cap(tech.structure)}`,
    tech.d1.rsi14 != null ? `RSI14 ${tech.d1.rsi14}` : '', tech.d1.macdHist != null ? `MACD ${tech.d1.macdHist >= 0 ? '+' : '−'}` : '',
    tech.expectedWeekRange ? `Expected weekly range ≈ ${tech.expectedWeekRange}` : '', levels,
    tech.w1 && tech.w1.pivots ? `Weekly pivot ${tech.w1.pivots.pp}` : ''
  ].filter(Boolean).join(' · ') : 'Technical feed temporarily unavailable.';

  const funParts = [];
  if (headlines && headlines.scored) {
    funParts.push('Headline tone: ' + Object.entries(headlines.tones).filter(([, v]) => v.n > 0)
      .map(([k, v]) => `${k} ${v.tone > 0.15 ? 'positive' : v.tone < -0.15 ? 'negative' : 'neutral'}`).join(', '));
  }
  if (calendar && calendar.events.length) {
    funParts.push('Key events: ' + calendar.events.slice(0, 5)
      .map(e => `${fmtDay(e.datetime)} ${e.ccy} ${e.title}${e.forecast ? ` (F ${e.forecast}${e.previous ? ' / P ' + e.previous : ''})` : ''}`).join(' | '));
  } else if (calendar) funParts.push('No high/medium-impact events this week for this pair.');
  if (cot) funParts.push('COT net (large specs): ' + cot.items.map(i => `${i.ccy} ${i.net >= 0 ? '+' : ''}${i.net}`).join(', '));
  const fundText = funParts.join(' | ') || 'Fundamental feeds temporarily unavailable.';

  const driver = factors.slice().sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))[0];
  const driverName = { tech: 'technicals', fund: 'news tone', cot: 'COT positioning', inter: 'cross-market flows', retail: 'crowd positioning' }[driver.key];
  const summary = `${symbol}: ${cap(bias)} bias (score ${sg(score)}, ${confidence} confidence). Main driver: ${driverName}.`
    + (notes.includes('eventSoon') ? ' High-impact news is close – reduce size around it.' : '')
    + (notes.includes('overbought') ? ' RSI is overbought.' : '') + (notes.includes('oversold') ? ' RSI is oversold.' : '');

  return {
    v: 2, generatedAt: new Date(nowMs).toISOString(),
    bias, score, confidence, factors: factors.map(f => ({ key: f.key, score: rnd(f.score, 2), weight: f.weight })), notes,
    tech: tech || null, calendar: calendar || null, headlines: headlines || null, cot: cot || null,
    inter: inter || null, retail: retail || null, sources: sources || [],
    text: { summary, technical: techText, fundamental: fundText }
  };
}
