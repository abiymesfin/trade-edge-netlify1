/* ==========================================================
   TRADE EDGE  -  Netlify function (API + Telegram bot)
   ----------------------------------------------------------
   /api/...        data for the website / Telegram Mini App
   /api/telegram   Telegram sends bot messages here (webhook)
   /api/setup      open once in a browser to connect the bot
   /uploads/...    screenshots and model pictures
   Data lives in Netlify Blobs:  db (all records), flow (the
   bot's current form), img/<name> (pictures).
========================================================== */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { Bot, InlineKeyboard } from 'grammy';
import {
  pairInfo, yahooTicker, COT_NAMES, cotCurrencies, techFromCandles, contextFromCandles, interReport,
  calendarReport, headlineReport, cotReport, retailReport, buildReport
} from './analysis-engine.mjs';

export const config = { path: ['/api/*', '/uploads/*'] };

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID);
const SETUP_KEY = process.env.SETUP_KEY || '';
const LOCK_KEY = 'trade-edge-write-lock';
const LOCK_TTL_MS = 120_000;

/* ---------------------------------------------------------
   STATE  (loaded at the start of every request, saved at the end)
--------------------------------------------------------- */
let store;
let db;            // accounts, models, trades, pairs ...
let flow;          // the form the bot is asking right now: { name, i, data } or null
let flowKey = 'flow'; // each person has their own form: 'flow' (owner) or 'flow-<userId>'
let scope = null;  // set while a subscriber's own data is swapped in (see enterScope)
let dirty;         // db changed?
let flowDirty;     // flow changed?
let pendingWrites; // pictures to store
let pendingDeletes;// pictures to remove
let lockToken = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readLockRecord() {
  if (!store) return null;
  try {
    // Read as text so a lock written by an older/broken build as
    // `store.set(key, object)` cannot crash JSON decoding with
    // `"[object Object]" is not valid JSON`.
    const raw = await store.get(LOCK_KEY, { type: 'text', consistency: 'strong' });
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); }
      catch {
        // One-time cleanup for the malformed legacy lock. The lock is only
        // ephemeral, so deleting a value that cannot be parsed is safe.
        await store.delete(LOCK_KEY).catch(() => {});
        return null;
      }
    }
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

async function acquireWriteLock(timeoutMs = 30_000) {
  if (!store) store = getStore({ name: 'trade-edge', consistency: 'strong' });
  const token = crypto.randomBytes(18).toString('hex');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      // Conditional JSON writes must use setJSON; `set` only accepts
      // ArrayBuffer, Blob, or string values.
      const created = await store.setJSON(LOCK_KEY, {
        token,
        expiresAt: Date.now() + LOCK_TTL_MS
      }, { onlyIfNew: true });
      if (created?.modified === true) {
        lockToken = token;
        return;
      }
    } catch (e) {
      // A transient Blobs error should not turn /api/setup into a 500.
      console.error('write-lock create failed:', e);
    }

    const current = await readLockRecord();
    if (!current) continue;
    if (current.token === token && Number(current.expiresAt) > Date.now()) {
      lockToken = token;
      return;
    }
    if (Number(current.expiresAt) <= Date.now()) {
      await store.delete(LOCK_KEY).catch(() => {});
      continue;
    }
    await sleep(250);
  }
  throw new Error('The server is busy saving another change. Please try again.');
}

async function releaseWriteLock() {
  if (!lockToken || !store) return;
  try {
    const current = await readLockRecord();
    if (current && current.token === lockToken) await store.delete(LOCK_KEY);
  } finally {
    lockToken = null;
  }
}

const emptyDb = () => ({
  accounts: [], models: [], trades: [], pairs: [], pairsUpdatedAt: null, siteUrl: '',
  users: [],                                        // website accounts (subscribers + the owner)
  plans: [{ id: 'monthly', name: 'Monthly', days: 30, price: '' }],
  payments: [],                                     // payment requests from subscribers
  gifts: [],                                        // complimentary access grants
  promos: [],                                       // promo / gift codes made in the bot (redeemed at sign-up)
  userData: {},                                     // each subscriber's OWN accounts / models / trades / pairs (the owner's stay in the main lists)
  botUsername: '',                                  // for the "Open bot" link on the website
  plansV2: false,                                   // the 1 / 3 / 6 / 12 month plans were added
  hideFromViewers: false,                           // control panel switch: subscribers do not see ETB amounts, notes and screenshots
  payInfo: '',                                      // legacy/general payment instructions
  paymentMethods: [
    { id: 'bank', region: 'et', name: 'Ethiopian bank transfer', instructions: 'Add your Ethiopian bank name and account details in the admin panel.' },
    { id: 'telebirr', region: 'et', name: 'Telebirr', instructions: 'Add your Telebirr number and payment instructions in the admin panel.' },
    { id: 'crypto', region: 'intl', name: 'Cryptocurrency', instructions: 'Add your wallet address, network and accepted coins in the admin panel.' }
  ],
  linkTokens: {},                                  // one-time Telegram deep-link tokens
  features: null,                                   // services listed on every plan (null = built-in list); edited in the bot: Plans & prices
  trialDays: null,                                  // free-trial length (null = TRIAL_DAYS); edited in the bot
  recommended: '',                                  // plan highlighted on the website ('' = 3rd plan, 'none' = no highlight)
  edit: null,                                       // owner's pending bot edit { k, id, n } (waiting for the next text message)
  signups: [],                                      // sign-up times (spam limit)
  loginAttempts: {},                                // short lockouts keyed by email + client IP (never the account itself)
  // Monday reminder. 06:00 on the standard clock = 12:00 ጠዋት (Ethiopian clock), time zone UTC+3
  reminder: { enabled: true, hour: 6, utcOffset: 3, lastSent: '', custom: false }
});

async function loadState() {
  store = getStore({ name: 'trade-edge', consistency: 'strong' });
  db = Object.assign(emptyDb(), (await store.get('db', { type: 'json' })) || {});
  if (!db.reminder.custom) db.reminder.hour = 6;   // default until you choose another hour with /reminder
  db.paymentMethods = Array.isArray(db.paymentMethods) && db.paymentMethods.length ? db.paymentMethods : emptyDb().paymentMethods;
  db.linkTokens = db.linkTokens && typeof db.linkTokens === 'object' ? db.linkTokens : {};
  flowKey = 'flow'; scope = null;
  flow = (await store.get('flow', { type: 'json' })) || null;
  dirty = false; flowDirty = false; pendingWrites = []; pendingDeletes = [];
  ensureCatalogPlans();
}

async function flushState() {
  for (const w of pendingWrites) {
    await store.set('img/' + w.name, w.data, { metadata: { contentType: w.type } });
  }
  for (const n of pendingDeletes) await store.delete('img/' + n);
  if (dirty) await store.setJSON('db', db);
  if (flowDirty) {
    if (flow) await store.setJSON(flowKey, flow);
    else await store.delete(flowKey);
  }
}

/* ---------------------------------------------------------
   EACH SUBSCRIBER HAS THEIR OWN DATA
   The owner's accounts / models / trades / pairs live in db.accounts ... as always.
   For a subscriber, enterScope() swaps THEIR lists into db.accounts ... for the rest of the
   request, so all the existing code (bot forms, website API) works unchanged on their data.
   leaveScope() puts everything back (it runs at the end of every request).
--------------------------------------------------------- */
const emptyUserData = () => ({ accounts: [], models: [], trades: [], pairs: [], pairsUpdatedAt: null });
function enterScope(uid) {
  if (scope || !uid) return;
  db.userData = db.userData || {};
  const ud = db.userData[uid] || (db.userData[uid] = Object.assign(emptyUserData(), {}));
  scope = { uid, ud, saved: { accounts: db.accounts, models: db.models, trades: db.trades, pairs: db.pairs, pairsUpdatedAt: db.pairsUpdatedAt } };
  db.accounts = ud.accounts; db.models = ud.models; db.trades = ud.trades; db.pairs = ud.pairs; db.pairsUpdatedAt = ud.pairsUpdatedAt;
}
function leaveScope() {
  if (!scope) return;
  const { ud, saved } = scope;
  ud.accounts = db.accounts; ud.models = db.models; ud.trades = db.trades; ud.pairs = db.pairs; ud.pairsUpdatedAt = db.pairsUpdatedAt;
  Object.assign(db, saved);
  scope = null;
}

const save = () => { dirty = true; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const randomName = ext => crypto.randomBytes(12).toString('hex') + ext;

function removeFile(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return;
  pendingDeletes.push(url.slice('/uploads/'.length));
}

function removeRecord(coll, id) {
  const rec = db[coll].find(r => r.id === id);
  if (!rec) return false;
  if (coll === 'accounts') {
    if (rec.image) removeFile(rec.image);
    db.trades.filter(t => t.accountId === id).forEach(t => (t.images || []).forEach(removeFile));
    db.trades = db.trades.filter(t => t.accountId !== id);
  }
  if (coll === 'trades') (rec.images || []).forEach(removeFile);
  if (coll === 'models' && rec.image) removeFile(rec.image);
  if (coll === 'users') {
    db.payments = db.payments.filter(p => p.userId !== id);
    const ud = (db.userData || {})[id];
    if (ud) { ud.accounts.forEach(a => removeFile(a.image)); ud.models.forEach(m => removeFile(m.image)); ud.trades.forEach(t => (t.images || []).forEach(removeFile)); delete db.userData[id]; }
  }
  db[coll] = db[coll].filter(r => r.id !== id);
  if (coll === 'pairs') db.pairsUpdatedAt = new Date().toISOString();
  save();
  return true;
}

/* ---------------------------------------------------------
   SMALL HELPERS
--------------------------------------------------------- */
class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }
});
const text = (body, status = 200) => new Response(body, {
  status, headers: { 'content-type': 'text/plain; charset=utf-8' }
});
const toArrayBuffer = buf => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const siteUrl = () => db.siteUrl || '';
const isHttps = u => /^https:\/\//i.test(u || '');
const webhookSecret = () =>
  crypto.createHash('sha256').update('te-webhook:' + BOT_TOKEN).digest('hex').slice(0, 48);

/* ---------------------------------------------------------
   WHO IS CALLING?  Telegram signs the Mini App data.
--------------------------------------------------------- */
function telegramUser(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
  const x = Buffer.from(calc), y = Buffer.from(hash);
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  if (!(Date.now() / 1000 - Number(params.get('auth_date') || 0) < 3 * 86400)) return null;
  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

/* ---------------------------------------------------------
   WEBSITE ACCOUNTS + SUBSCRIPTIONS
   - Anyone can sign up, but sees nothing until the owner approves a payment.
   - Subscribers (and the owner's own web login) can only LOOK.
   - Changing data is possible only from Telegram (owner).
--------------------------------------------------------- */
/* ---------------------------------------------------------
   PLANS  (1 / 3 / 6 / 12 months)  -  price = months x PRICE_PER_MONTH
   Change PRICE_PER_MONTH below to change every plan price.
--------------------------------------------------------- */
const PRICE_PER_MONTH = 1500;          // ETB for one month
const PLAN_MONTHS = [1, 3, 6, 12];
const TRIAL_DAYS = 3;                  // free trial for every new sign-up (the owner can change it in the bot: Plans & prices)
const DEFAULT_FEATURES = [
  'Live market prices & economic news calendar',
  'Pair analysis with buy / sell bias',
  'Private trading journal with screenshots',
  'Unlimited accounts, models and trades',
  'Win rate, P/L and performance tracking',
  'Telegram bot control & weekly Monday plan'
];
const trialDays = () => (Number.isInteger(db.trialDays) && db.trialDays >= 1 && db.trialDays <= 90 ? db.trialDays : TRIAL_DAYS);
const featureList = () => (Array.isArray(db.features) ? db.features : DEFAULT_FEATURES);
const siteCfg = () => ({ features: featureList(), trialDays: trialDays(), recommended: db.recommended || '' });
const money0 = n => Number(n).toLocaleString('en-US');

function catalogPlan(m) {
  return {
    id: 'm' + m, name: m === 1 ? '1 Month' : m + ' Months', months: m,
    days: m === 12 ? 365 : m * 30, amount: m * PRICE_PER_MONTH, price: money0(m * PRICE_PER_MONTH) + ' ETB'
  };
}

// Runs once: adds the four standard plans (keeps any plan you made yourself).
function ensureCatalogPlans() {
  if (db.plansV2) return;
  const have = new Set(db.plans.map(p => p.id));
  for (const m of PLAN_MONTHS) if (!have.has('m' + m)) db.plans.push(catalogPlan(m));
  const legacy = db.plans.find(p => p.id === 'monthly' && !p.price);
  if (legacy && !db.payments.some(p => p.planId === 'monthly')) db.plans = db.plans.filter(p => p !== legacy);
  db.plans.sort((a, b) => a.days - b.days);
  db.plansV2 = true;   // saved together with the next change (never writes on its own)
}

const SESSION_DAYS = 30;
const DAY = 864e5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPassword(pw, pass) {
  const got = crypto.scryptSync(pw, pass.salt, 32);
  const want = Buffer.from(pass.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sessionKey = u => crypto.createHash('sha256').update('te-session:' + BOT_TOKEN + u.pass.hash).digest();
const sessionCookie = (value, maxAge) =>
  `te_session=${value}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
const withSession = u => ({ 'set-cookie': sessionCookie(makeSession(u), SESSION_DAYS * 86400) });

function makeSession(u) {
  const exp = Date.now() + SESSION_DAYS * DAY;
  const sig = crypto.createHmac('sha256', sessionKey(u)).update(`${u.id}.${exp}`).digest('hex');
  return `${u.id}.${exp}.${sig}`;
}

function sessionUser(req) {
  const m = /(?:^|;\s*)te_session=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!uid || !exp || !sig || !(Number(exp) > Date.now())) return null;
  const u = db.users.find(x => x.id === uid);
  if (!u) return null;
  const calc = crypto.createHmac('sha256', sessionKey(u)).update(`${uid}.${exp}`).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

// 'active' | 'expired' | 'pending' (never paid) | 'blocked'
const accessState = u => (u.blocked ? 'blocked'
  : (u.owner || u.expiresAt > Date.now()) ? 'active'
  : u.expiresAt ? 'expired' : 'pending');
const publicUser = u => ({ name: u.name, email: u.email, owner: !!u.owner, expiresAt: u.expiresAt || 0, plan: u.plan || '', trial: !!u.trial });
const planList = () => db.plans.map(p => ({ id: p.id, name: p.name, days: p.days, price: p.price, months: p.months || 0, amount: p.amount || 0, note: p.note || '' }));
const dateOf = ms => localTime(ms).toISOString().slice(0, 10);

function pendingPayment(u) {
  const p = db.payments.find(x => x.userId === u.id && x.status === 'pending');
  if (!p) return null;
  const plan = db.plans.find(x => x.id === p.planId);
  return { planName: plan ? plan.name : '', reference: p.reference, createdAt: p.createdAt };
}

// "You are signed in, but need to pay / are blocked"
const gate = (u, state) => json({
  state, user: publicUser(u), plans: planList(), payInfo: db.payInfo || '', paymentMethods: db.paymentMethods || [], pending: pendingPayment(u), ...siteCfg()
}, state === 'blocked' ? 403 : 402);

function extendUser(u, days, planName) {
  const base = Math.max(Date.now(), u.expiresAt || 0);
  u.expiresAt = base + days * DAY;
  u.plan = planName || u.plan;
  u.trial = false;
  save();
}

const notifyOwner = (message, extra) =>
  getBot().api.sendMessage(OWNER_ID, message, extra).catch(e => console.error('notify failed', e));

function loginKey(req, email) {
  const ip = req.headers.get('x-nf-client-connection-ip')
    || String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  return crypto.createHmac('sha256', String(BOT_TOKEN)).update(`login:${email}:${ip}`).digest('hex');
}

function clearOldLoginAttempts(now) {
  for (const [key, rec] of Object.entries(db.loginAttempts || {})) {
    if (!rec || Number(rec.windowUntil) <= now) delete db.loginAttempts[key];
  }
}

async function login(req) {
  const { body } = await readRequest(req);
  const email = String(body.email || '').trim().toLowerCase();
  const user = db.users.find(u => u.email === email);
  const now = Date.now();
  clearOldLoginAttempts(now);
  const key = loginKey(req, email);
  const rec = db.loginAttempts[key] || { fails: 0, windowUntil: now + 15 * 60000, lockedUntil: 0 };
  if (Number(rec.lockedUntil) > now) {
    return json({ error: `Too many tries from this device. Wait ${Math.ceil((rec.lockedUntil - now) / 60000)} minutes.` }, 429);
  }
  const ok = user ? checkPassword(String(body.password || ''), user.pass) : false;
  if (!ok) {
    rec.fails = Number(rec.fails || 0) + 1;
    rec.windowUntil = now + 15 * 60000;
    if (rec.fails >= 5) rec.lockedUntil = now + 15 * 60000;
    db.loginAttempts[key] = rec;
    save();
    return json({ error: 'Wrong email or password' }, 401);
  }
  delete db.loginAttempts[key];
  save();
  return json({ ok: true }, 200, withSession(user));
}

async function subscribe(req, user) {
  if (user.blocked) return gate(user, 'blocked');
  const { body } = await readRequest(req);
  const plan = db.plans.find(p => p.id === String(body.planId || ''));
  const methodId = String(body.methodId || '').trim();
  const method = (db.paymentMethods || []).find(x => x.id === methodId);
  const reference = String(body.reference || '').trim().slice(0, 120);
  const network = String(body.network || '').trim().slice(0, 40);
  if (!plan) return bad('Choose a plan');
  if (!method) return bad('Choose a payment method');
  if (!reference) return bad('Enter your payment reference or transaction ID');
  if (method.region === 'intl' && method.id === 'crypto' && !network) return bad('Enter the crypto network used');
  db.payments = db.payments.filter(p => !(p.userId === user.id && p.status === 'pending'));
  const pay = { id: newId(), userId: user.id, planId: plan.id, methodId: method.id, methodName: method.name, network, reference, createdAt: new Date().toISOString(), status: 'pending' };
  db.payments.push(pay);
  save();
  await notifyOwner(
    `💳 Payment request\n${user.name} (${user.email})\nPlan: ${plan.name} – ${plan.days} days ${plan.price || ''}\nMethod: ${method.name}${network ? ' (' + network + ')' : ''}\nReference/TxID: ${reference}`,
    { reply_markup: new InlineKeyboard().text('✅ Approve', 'pay:ok:' + pay.id).text('❌ Reject', 'pay:no:' + pay.id) }
  );
  return json({ ok: true });
}

/* ---------------------------------------------------------
   TELEGRAM MEMBERS  (no e-mail: your Telegram account is your login)
   - Anyone who opens the bot gets an account with a free trial (or a promo code's time).
   - On the website (Chrome) they sign in with a code the bot gives them: /code
--------------------------------------------------------- */
function tgDisplayName(t) {
  return [t.first_name, t.last_name].filter(Boolean).join(' ').trim() || (t.username ? '@' + t.username : 'Telegram ' + t.id);
}

// finds the member for this Telegram person, or creates the account. payload = promo code from a link.
async function memberFromTelegram(t, payload) {
  let user = db.users.find(u => u.tgId === t.id);
  if (!user && payload.startsWith('link_')) user = consumeTelegramLink(payload.slice(5), t.id);
  let created = false, note = '';
  if (!user) {
    created = true;
    const now = Date.now();
    user = {
      id: newId(), tgId: t.id, name: tgDisplayName(t).slice(0, 80), email: '', contact: t.username ? '@' + t.username : 'Telegram ID ' + t.id,
      pass: hashPassword(crypto.randomBytes(24).toString('hex')),      // nobody knows it: they sign in through Telegram
      createdAt: new Date().toISOString(), expiresAt: 0, plan: '', blocked: false, owner: false
    };
    db.users.push(user);
    const chk = payload ? findUsablePromo(payload) : null;
    if (chk && chk.promo) {
      redeemPromo(user, chk.promo);                                    // a promo code replaces the free trial
      note = `\n🎁 Promo code ${chk.promo.code}: ${promoLabel(chk.promo)} free`;
    } else {
      user.expiresAt = now + trialDays() * DAY; user.plan = 'Free trial'; user.trial = true;
      note = `\n🆓 ${trialDays()}-day free trial started` + (payload ? ' (the promo code was not valid)' : '');
    }
    save();
    await notifyOwner(`🆕 New member\n${user.name}${user.contact ? '\n' + user.contact : ''}${note}`);
  } else if (payload && user.expiresAt && !user.owner) {
    // already a member and opened a link with a code: use it (silently ignored if not valid)
    const chk = findUsablePromo(payload);
    if (chk.promo) { redeemPromo(user, chk.promo); await notifyOwner(`🎁 Promo code ${chk.promo.code} used by ${user.name} – ${promoLabel(chk.promo)}`); }
  }
  return { user, created };
}

function createTelegramLink(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.linkTokens[token] = { userId: user.id, expiresAt: Date.now() + 15 * 60 * 1000 };
  save();
  return { token, botUsername: db.botUsername || '' };
}

function consumeTelegramLink(token, tgId) {
  const rec = db.linkTokens && db.linkTokens[token];
  if (!rec || Number(rec.expiresAt) < Date.now()) return null;
  const user = db.users.find(u => u.id === rec.userId && !u.owner);
  if (!user || (user.tgId && user.tgId !== tgId)) return null;
  if (db.users.some(u => u.tgId === tgId && u.id !== user.id)) return null;
  user.tgId = tgId;
  delete db.linkTokens[token];
  save();
  return user;
}

// website sign up: name + e-mail + password (+ optional promo code). Starts the free trial.
async function signup(req) {
  const { body } = await readRequest(req);
  const name = String(body.name || '').trim().slice(0, 80);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(body.password || '');
  const promoText = String(body.promo || '').trim();
  if (!name) return bad('Name is required');
  if (!EMAIL_RE.test(email)) return bad('Enter a valid email');
  if (password.length < 8) return bad('Password must be at least 8 characters');
  if (db.users.some(u => u.email === email)) return json({ error: 'This email is already registered. Please sign in.' }, 409);
  let promo = null;
  if (promoText) { const chk = findUsablePromo(promoText); if (chk.error) return bad(chk.error); promo = chk.promo; }
  const now = Date.now();
  db.signups = (db.signups || []).filter(t => now - t < 3600e3);
  if (db.signups.length >= 10) return json({ error: 'Too many sign-ups right now. Try again later.' }, 429);
  db.signups.push(now);
  const tg = telegramUser(req.headers.get('x-tg-init-data'));
  const user = {
    id: newId(), name, email, contact: String(body.contact || '').trim().slice(0, 80), pass: hashPassword(password),
    createdAt: new Date().toISOString(), expiresAt: 0, plan: '', blocked: false, owner: false,
    ...(tg && tg.id !== OWNER_ID ? { tgId: tg.id } : {})
  };
  db.users.push(user);
  let note;
  if (promo) { redeemPromo(user, promo); note = `🎁 Promo code ${promo.code}: ${promoLabel(promo)} free`; }
  else { user.expiresAt = now + trialDays() * DAY; user.plan = 'Free trial'; user.trial = true; note = `🆓 ${trialDays()}-day free trial started`; }
  save();
  await notifyOwner(`🆕 New sign-up\n${name}\n${email}\n${note}`);
  const link = tg && tg.id !== OWNER_ID ? null : createTelegramLink(user);
  return json({ ok: true, telegramLink: link }, 200, withSession(user));
}

// who is calling?  { owner, user, viaTg }
function identify(req) {
  const tg = telegramUser(req.headers.get('x-tg-init-data'));
  if (tg && tg.id === OWNER_ID) return { owner: true, user: null, viaTg: true };
  if (tg) {
    const user = db.users.find(u => u.tgId === tg.id) || null;
    return { owner: false, user, viaTg: true, tg };
  }
  return { owner: false, user: sessionUser(req), viaTg: false };
}

/* ---------------------------------------------------------
   PROMO / GIFT CODES  (made in the bot with /gift, redeemed on the sign-up page)
   One code = a number of days of free access.  Default 1 use; /gift 12 5 = 5 people can use it.
--------------------------------------------------------- */
const PROMO_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0 O 1 I
const promoKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtPromo = k => `TE-${k.slice(2, 6)}-${k.slice(6, 10)}`;
const promoLabel = p => (p.months ? `${p.months} month${p.months > 1 ? 's' : ''}` : `${p.days} days`);

function createPromo({ months = 0, days = 0, uses = 1, note = '' }) {
  const d = months ? (months === 12 ? 365 : months * 30) : days;
  let key;
  do { key = 'TE' + Array.from({ length: 8 }, () => PROMO_CHARS[crypto.randomInt(PROMO_CHARS.length)]).join(''); }
  while ((db.promos || []).some(p => p.key === key));
  const promo = { id: newId(), key, code: fmtPromo(key), days: d, months: months || 0, maxUses: uses, used: [], note: String(note || '').slice(0, 120), createdAt: new Date().toISOString(), revoked: false };
  db.promos = db.promos || []; db.promos.push(promo); save();
  return promo;
}

function findUsablePromo(text) {
  const key = promoKey(text);
  const promo = (db.promos || []).find(p => p.key === key);
  if (!key || !promo) return { error: 'Promo code not found. Check it and try again.' };
  if (promo.revoked) return { error: 'This promo code is no longer valid.' };
  if (promo.used.length >= promo.maxUses) return { error: 'This promo code was already used.' };
  return { promo };
}

// gives the access and writes it into the gift history (so it shows in the control panel)
function redeemPromo(user, promo) {
  extendUser(user, promo.days, 'Promo ' + promoLabel(promo));
  promo.used.push({ userId: user.id, email: user.email, at: new Date().toISOString() });
  db.gifts = Array.isArray(db.gifts) ? db.gifts : [];
  db.gifts.push({ id: newId(), userId: user.id, recipientName: user.name, recipientEmail: user.email, planName: 'Promo ' + promoLabel(promo),
    days: promo.days, note: 'Promo code ' + promo.code, promoId: promo.id, createdAt: new Date().toISOString() });
  save();
}

// a signed-in person who did not use a code at sign-up can still use one
async function redeem(req, user) {
  if (user.blocked) return gate(user, 'blocked');
  if (user.owner) return bad('The owner does not need a code.');
  const { body } = await readRequest(req);
  const chk = findUsablePromo(body.code);
  if (chk.error) return bad(chk.error);
  redeemPromo(user, chk.promo);
  await notifyOwner(`🎁 Promo code ${chk.promo.code} used by ${user.name} (${user.email}) – ${promoLabel(chk.promo)}`);
  return json({ ok: true });
}

/* ---------------------------------------------------------
   REQUEST BODY (JSON or multipart form with pictures)
--------------------------------------------------------- */
async function readRequest(req) {
  const type = req.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    const body = {};
    const files = [];
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') body[key] = value;
      else if (value && value.size > 0) {
        if (value.size > 8 * 1024 * 1024) throw new RequestError('Picture is too big (max 8 MB).', 400);
        files.push({ fieldname: key, mimetype: value.type, buffer: Buffer.from(await value.arrayBuffer()) });
      }
    }
    return { body, files };
  }
  if (type.includes('application/json')) {
    return { body: await req.json().catch(() => ({})), files: [] };
  }
  return { body: {}, files: [] };
}

const numOrNull = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const filesNamed = (files, name) => files.filter(f => f.fieldname === name);
const findRec = (coll, id) => db[coll].find(r => r.id === id);
const bad = msg => json({ error: msg }, 400);
const notFound = () => json({ error: 'not found' }, 404);

function saveUpload(file) {
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
  if (!ext) throw new RequestError('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.', 400);
  const name = randomName(ext);
  pendingWrites.push({ name, type: file.mimetype, data: toArrayBuffer(file.buffer) });
  return '/uploads/' + name;
}

/* ---------------------------------------------------------
   RECORD RULES  (what a valid account / model / trade is)
--------------------------------------------------------- */
function accountFields(b) {
  const name = String(b.name || '').trim();
  const startingBalance = Number(b.startingBalance);
  if (!name || !Number.isFinite(startingBalance)) return null;
  return { name, type: oneOf(b.type, ['funded', 'phase', 'live'], 'live'), startingBalance,
    description: String(b.description || '').trim().slice(0, 2000),
    active: b.active === false || b.active === 'false' ? false : true };
}

function modelFields(b) {
  const name = String(b.name || '').trim();
  if (!name) return null;
  return {
    name,
    market: oneOf(b.market, ['forex', 'metal', 'index'], 'forex'),
    symbols: String(b.symbols || '').trim(),
    timeframe: String(b.timeframe || '').trim(),
    session: oneOf(b.session, ['any', 'asia', 'london', 'newyork', 'london_newyork'], 'any'),
    riskPercent: numOrNull(b.riskPercent),
    description: String(b.description || '').trim(),
    active: b.active === true || b.active === 'true'
  };
}

function deriveTradeSession(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const parts = tz => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(date);
    const get = k => p.find(x => x.type === k)?.value || '';
    return { day: get('weekday'), mins: Number(get('hour')) * 60 + Number(get('minute')) };
  };
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const tokyo = parts('Asia/Tokyo'), london = parts('Europe/London'), ny = parts('America/New_York');
  const weekday = v => days[v.day] >= 1 && days[v.day] <= 5;
  if (weekday(london) && london.mins >= 8*60 && london.mins < 17*60 && weekday(ny) && ny.mins >= 8*60 && ny.mins < 17*60) return 'london_newyork';
  if (weekday(london) && london.mins >= 8*60 && london.mins < 17*60) return 'london';
  if (weekday(ny) && ny.mins >= 8*60 && ny.mins < 17*60) return 'newyork';
  if (weekday(tokyo) && tokyo.mins >= 9*60 && tokyo.mins < 18*60) return 'asia';
  return '';
}

function tradeFields(b) {
  const symbol = String(b.symbol || '').trim().toUpperCase();
  const account = findRec('accounts', String(b.accountId || ''));
  if (!symbol || !account) return null;

  const status = oneOf(b.status, ['win', 'loss', 'be', 'open'], 'open');
  const timeframe = String(b.timeframe || '').trim();
  if (!timeframe) return null;

  const created = Date.parse(b.createdAt);
  const pnl = numOrNull(b.pnl);
  const pnlEtb = numOrNull(b.pnlEtb);
  if ((status === 'win' || status === 'loss') && pnl === null) return null;
  if (status === 'win' && pnl < 0) return null;
  if (status === 'loss' && pnl > 0) return null;
  if (status === 'win' && pnlEtb !== null && pnlEtb < 0) return null;
  if (status === 'loss' && pnlEtb !== null && pnlEtb > 0) return null;

  const canonicalPnl = status === 'win' && pnl !== null ? Math.abs(pnl)
    : status === 'loss' && pnl !== null ? -Math.abs(pnl)
    : status === 'be' ? 0 : null;
  const canonicalEtb = pnlEtb === null ? null
    : status === 'win' ? Math.abs(pnlEtb)
    : status === 'loss' ? -Math.abs(pnlEtb)
    : status === 'be' ? 0 : null;
  const start = Number(account.startingBalance);
  const pct = canonicalPnl === null || !Number.isFinite(start) || start <= 0
    ? null : round(canonicalPnl / start * 100);

  const requestedSession = String(b.session || '').trim().toLowerCase();
  const model = b.modelId && b.modelId !== 'none' ? db.models.find(m => m.id === String(b.modelId)) : null;
  const explicitSession = ['asia', 'london', 'newyork', 'london_newyork'].includes(requestedSession) ? requestedSession : '';
  const session = explicitSession || (model && model.session && model.session !== 'any' ? model.session : deriveTradeSession(new Date(created).toISOString()));

  return {
    accountId: String(b.accountId),
    modelId: String(b.modelId || ''),
    strategy: model ? model.name : String(b.strategy || ''),
    symbol,
    side: oneOf(b.side, ['buy', 'sell'], 'buy'),
    timeframe,
    session,
    status,
    psychology: oneOf(b.psychology, ['good', 'normal', 'bad'], 'normal'),
    entry: numOrNull(b.entry),
    entryDecimals: Math.min(5, Math.max(0, Number(b.entryDecimals) || 0)),
    stopLoss: numOrNull(b.stopLoss), takeProfit: numOrNull(b.takeProfit), exit: numOrNull(b.exit),
    rr: numOrNull(b.rr), lotSize: numOrNull(b.lotSize),
    pnl: canonicalPnl, pnlPercent: pct, pnlEtb: canonicalEtb,
    followedPlan: b.followedPlan === true || b.followedPlan === 'true',
    notes: String(b.notes || ''),
    active: b.active === false || b.active === 'false' ? false : true,
    createdAt: Number.isNaN(created) ? new Date().toISOString() : new Date(created).toISOString()
  };
}
const pairNote = p => [p.fundamental && 'Fundamental: ' + p.fundamental, p.technical && 'Technical: ' + p.technical]
  .filter(Boolean).join(' · ');
const parseTrade = body => {
  try {
    if (body && typeof body.data === 'object' && body.data !== null) return body.data;
    if (body && typeof body.data === 'string') return JSON.parse(body.data);
    return body && typeof body === 'object' ? body : null;
  } catch (e) { return null; }
};
const sortTrades = () => db.trades.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/* ---------------------------------------------------------
   JOURNAL NOTES IN AMHARIC + ENGLISH
   You may write the notes in either language. When a trade is saved the server detects the language,
   translates the notes into the other one and keeps both (notesAm / notesEn). The website shows the
   version that matches the language switch.
--------------------------------------------------------- */
function notesLanguage(text) {
  const s = String(text || '');
  const letters = (s.match(/[A-Za-z\u1200-\u137F]/g) || []).length;
  if (!letters) return 'en';
  return (s.match(/[\u1200-\u137F]/g) || []).length / letters >= 0.3 ? 'am' : 'en';
}

function chunkForTranslate(text, max) {
  const pieces = [];
  for (const line of String(text).split('\n')) {
    if (line.length <= max) { pieces.push(line); continue; }
    let cur = '';
    for (const part of line.split(/(?<=[.!?።፧])\s+/)) {
      if ((cur + ' ' + part).length > max && cur) { pieces.push(cur); cur = ''; }
      let rest = part;
      while (rest.length > max) { pieces.push(rest.slice(0, max)); rest = rest.slice(max); }
      cur = cur ? cur + ' ' + rest : rest;
    }
    if (cur) pieces.push(cur);
  }
  const chunks = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && (cur + '\n' + p).length > max) { chunks.push(cur); cur = p; }
    else cur = cur ? cur + '\n' + p : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function postJsonTimeout(url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error('translate ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function translateChunk(text, from, to) {
  if (!text.trim()) return text;
  try {                                            // 1) Google Translate public endpoint
    const data = await postJsonTimeout(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'q=' + encodeURIComponent(text) }, 7000);
    const out = Array.isArray(data?.[0]) ? data[0].map(x => (Array.isArray(x) ? x[0] : '')).join('') : '';
    if (out.trim()) return out;
  } catch (e) { /* try the next service */ }
  try {                                            // 2) MyMemory (free, 500 characters per request)
    const parts = chunkForTranslate(text, 450);
    const done = [];
    for (const p of parts) {
      const data = await postJsonTimeout(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(p)}&langpair=${from}|${to}`, {}, 7000);
      const t = String(data?.responseData?.translatedText || '');
      if (!t.trim() || /MYMEMORY WARNING|INVALID/i.test(t)) throw new Error('no translation');
      done.push(t);
    }
    return done.join('\n');
  } catch (e) { return ''; }
}

async function translateText(text, from, to) {
  const out = [];
  for (const chunk of chunkForTranslate(text, 800)) {
    const r = await translateChunk(chunk, from, to);
    if (!r) return '';
    out.push(r);
  }
  return out.join('\n');
}

const needsTranslation = rec => {
  const n = String(rec.notes || '').trim();
  return !!n && !(rec.notesFor === n && rec.notesAm && rec.notesEn);
};

async function localizeNotes(rec) {
  const notes = String(rec.notes || '').trim();
  if (!notes) { delete rec.notesAm; delete rec.notesEn; delete rec.notesFor; return rec; }
  if (!needsTranslation(rec)) return rec;
  const src = notesLanguage(notes), dst = src === 'am' ? 'en' : 'am';
  let tr = '';
  try { tr = await translateText(notes, src, dst); } catch (e) { console.error('notes translation failed', e); }
  rec[src === 'am' ? 'notesAm' : 'notesEn'] = notes;
  rec[dst === 'am' ? 'notesAm' : 'notesEn'] = tr;
  if (tr) rec.notesFor = notes; else delete rec.notesFor;            // no translation yet -> retried later
  return rec;
}


/* ---------------------------------------------------------
   AUTOMATIC WEEKLY PAIR ANALYSIS
--------------------------------------------------------- */
const PAIR_ANALYSIS_TTL = 18 * 60 * 60 * 1000;
const ANALYSIS_CONCURRENCY = 4;
const CONTEXT_KEY = 'context-cache-v1';
const CONTEXT_TTL = 30 * 60 * 1000;
const COT_KEY = 'cot-cache-v1';
const COT_TTL = 12 * 60 * 60 * 1000;
const CONTEXT_TICKERS = { DXY: 'DX-Y.NYB', US10Y: '^TNX', SPX: '^GSPC', VIX: '^VIX' };

/* Yahoo Finance candles (daily / weekly) */
async function yahooCandles(ticker, range, interval) {
  const qs = `?range=${range}&interval=${interval}&includePrePost=false`;
  let lastError = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const data = await fetchJsonWithTimeout(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}${qs}`, 6000);
      const r = data?.chart?.result?.[0];
      const ts = r?.timestamp || [];
      const q = r?.indicators?.quote?.[0] || {};
      const out = { t: [], o: [], h: [], l: [], c: [] };
      for (let i = 0; i < ts.length; i++) {
        const c = Number(q.close?.[i]), h = Number(q.high?.[i]), l = Number(q.low?.[i]), o = Number(q.open?.[i]);
        if (![c, h, l].every(Number.isFinite)) continue;
        out.t.push(ts[i] * 1000); out.o.push(Number.isFinite(o) ? o : c); out.h.push(h); out.l.push(l); out.c.push(c);
      }
      if (out.c.length < 15) throw new Error('Not enough candles');
      return out;
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('candles unavailable');
}

async function technicalReport(symbol) {
  const ticker = yahooTicker(symbol);
  if (!ticker) return null;
  const [d, w] = await Promise.allSettled([yahooCandles(ticker, '1y', '1d'), yahooCandles(ticker, '2y', '1wk')]);
  if (d.status !== 'fulfilled') throw d.reason;
  return { ...techFromCandles(d.value, w.status === 'fulfilled' ? w.value : null), ticker };
}

/* DXY, US 10Y yield, S&P 500, VIX – shared by all pairs, cached 30 min */
async function marketContext() {
  const cached = await readCache(CONTEXT_KEY);
  if (cached?.ts && Date.now() - cached.ts < CONTEXT_TTL && cached.data) return cached.data;
  const entries = await Promise.allSettled(Object.entries(CONTEXT_TICKERS).map(async ([k, tk]) =>
    [k, contextFromCandles(await yahooCandles(tk, '6mo', '1d'))]));
  const data = {};
  entries.forEach(e => { if (e.status === 'fulfilled') data[e.value[0]] = e.value[1]; });
  if (!Object.keys(data).length) return cached?.data || null;
  await writeCache(CONTEXT_KEY, { ts: Date.now(), data });
  return data;
}

/* CFTC Commitments of Traders – large speculators (updated weekly, cached 12 h) */
async function cotData(info) {
  const need = cotCurrencies(info);
  if (!need.length) return null;
  const cached = await readCache(COT_KEY);
  const map = { ...(cached?.data || {}) };
  const fresh = c => map[c] && cached?.ts && Date.now() - (cached.stamps?.[c] || cached.ts) < COT_TTL;
  const missing = need.filter(c => !fresh(c));
  const stamps = { ...(cached?.stamps || {}) };
  if (missing.length) {
    await Promise.allSettled(missing.map(async c => {
      const where = encodeURIComponent(`market_and_exchange_names like '${COT_NAMES[c]}'`);
      const url = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json'
        + '?$select=report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all'
        + `&$where=${where}&$order=${encodeURIComponent('report_date_as_yyyy_mm_dd DESC')}&$limit=2`;
      const rows = await fetchJsonWithTimeout(url, 8000);
      if (!Array.isArray(rows) || !rows.length) throw new Error('no COT rows');
      const pick = r => ({ l: Number(r.noncomm_positions_long_all), s: Number(r.noncomm_positions_short_all) });
      const a = pick(rows[0]), b = rows[1] ? pick(rows[1]) : null;
      if (!Number.isFinite(a.l) || !Number.isFinite(a.s) || a.l + a.s <= 0) throw new Error('bad COT row');
      map[c] = { long: a.l, short: a.s, net: a.l - a.s, ratio: round((a.l - a.s) / (a.l + a.s), 3),
        change: b && Number.isFinite(b.l) ? (a.l - a.s) - (b.l - b.s) : null, date: String(rows[0].report_date_as_yyyy_mm_dd || '').slice(0, 10) };
      stamps[c] = Date.now();
    }));
    await writeCache(COT_KEY, { ts: cached?.ts || Date.now(), data: map, stamps });
  }
  return need.some(c => map[c]) ? map : null;
}

let newsInflight = null;
async function weeklyNewsItems() {
  if (newsInflight) return newsInflight;
  newsInflight = (async () => {
    const cached = await readCache(NEWS_CACHE_KEY);
    if (cached?.ts && Date.now() - cached.ts < NEWS_TTL && Array.isArray(cached.items)) return cached.items;
    try {
      const raw = await fetchJsonWithTimeout('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 8000);
      const items = Array.isArray(raw) ? raw.map(e => ({
        title: e.title || '', currency: e.country || e.currency || '', impact: e.impact || 'Low',
        datetime: e.date || e.datetime || '', forecast: e.forecast || '', previous: e.previous || '', actual: e.actual || '', source: 'Forex Factory'
      })).filter(e => e.title && e.datetime && Number.isFinite(new Date(e.datetime).getTime()))
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime)) : [];
      await writeCache(NEWS_CACHE_KEY, { ok: true, connected: items.length > 0, updatedAt: new Date().toISOString(), items, source: 'Forex Factory', ts: Date.now() });
      return items;
    } catch { return Array.isArray(cached?.items) ? cached.items : []; }
  })();
  try { return await newsInflight; }
  finally { newsInflight = null; }
}


async function enrichPairAnalysis(pair, force = false) {
  if (!pair) return null;
  const age = pair.autoAnalyzedAt ? Date.now() - Date.parse(pair.autoAnalyzedAt) : Infinity;
  if (!force && Number.isFinite(age) && age >= 0 && age < PAIR_ANALYSIS_TTL && pair.autoReport?.v === 2) return pair;

  const info = pairInfo(pair.symbol);
  const [tech, news, heads, ctx, cot] = await Promise.allSettled([
    technicalReport(pair.symbol), weeklyNewsItems(), loadHeadlines(), marketContext(), cotData(info)
  ]);
  const val = r => (r.status === 'fulfilled' ? r.value : null);

  let t = val(tech);
  if (!t && pair.autoReport?.tech) t = { ...pair.autoReport.tech, stale: true };      // keep the last good technicals
  const newsItems = val(news) || [];
  const headsData = val(heads);
  const calendar = newsItems.length ? calendarReport(info, newsItems) : (pair.autoReport?.calendar || null);
  const headlines = headsData?.items?.length ? headlineReport(info, headsData.items) : (pair.autoReport?.headlines || null);
  const cotRep = cotReport(info, val(cot));
  const inter = interReport(info, val(ctx));
  const retail = retailReport(pair.buyPercent, pair.sellPercent);

  const sources = [
    t && !t.stale ? 'Yahoo Finance (daily + weekly candles)' : '',
    val(ctx) ? 'Yahoo Finance (DXY, US10Y, S&P 500, VIX)' : '',
    newsItems.length ? 'Forex Factory calendar' : '',
    ...(headsData?.feeds || (headsData?.items?.length ? ['news feeds'] : [])),
    cotRep ? 'CFTC COT' : '',
    retail ? 'Your buyer/seller %' : ''
  ].filter(Boolean);

  const report = buildReport({ symbol: pair.symbol, info, tech: t, calendar, headlines, cot: cotRep, inter, retail, sources });
  if (!report) return pair;                                   // every feed failed: keep whatever was there before

  pair.autoReport = report;
  pair.autoBias = cap1(report.bias);
  pair.autoTechnical = report.text.technical;
  pair.autoFundamental = report.text.fundamental;
  pair.autoSummary = report.text.summary;
  pair.autoSources = sources;
  pair.autoAnalyzedAt = report.generatedAt;
  return pair;
}
const cap1 = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

async function refreshPairAnalyses(force = false) {
  const pairs = db.pairs.slice();
  const queue = pairs.filter(p => force || !p.autoAnalyzedAt || p.autoReport?.v !== 2 || Date.now() - Date.parse(p.autoAnalyzedAt) >= PAIR_ANALYSIS_TTL);
  let index = 0;
  async function worker() {
    while (index < queue.length) {
      const p = queue[index++];
      try { await enrichPairAnalysis(p, force); save(); } catch (e) { console.error('pair analysis failed', p.symbol, e); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ANALYSIS_CONCURRENCY, queue.length) }, () => worker()));
}

/* ---------------------------------------------------------
   MARKET + NEWS FEEDS
--------------------------------------------------------- */
const MARKET_CACHE_KEY = 'market-cache-v1';
const NEWS_CACHE_KEY = 'news-cache-v1';
const MARKET_TTL = 5 * 60 * 1000;
const NEWS_TTL = 60 * 60 * 1000;

async function fetchJsonWithTimeout(url, ms = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Upstream request failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readCache(key) {
  try { return await store.get(key, { type: 'json', consistency: 'strong' }); }
  catch { return null; }
}

async function writeCache(key, value) {
  try { await store.setJSON(key, value); } catch (e) { console.error('cache save failed', e); }
}

const conditionOf = pct => pct == null ? null : pct > 0.15 ? 'bullish' : pct < -0.15 ? 'bearish' : 'neutral';
const makeMarketItem = (symbol, name, decimals, price, previous) => {
  const change = Number.isFinite(previous) && previous !== 0 ? price - previous : null;
  const changePercent = change === null ? null : (price / previous - 1) * 100;
  return { symbol, name, decimals, price, change, changePercent, condition: conditionOf(changePercent) };
};

async function marketEndpoint() {
  const cached = await readCache(MARKET_CACHE_KEY);
  if (cached?.ts && Date.now() - cached.ts < MARKET_TTL && Array.isArray(cached.items)) return json(cached);

  const items = [];
  const sources = [];
  const fx = [
    ['EUR/USD','Euro / US Dollar','EUR',true,5],
    ['GBP/USD','British Pound / US Dollar','GBP',true,5],
    ['USD/JPY','US Dollar / Japanese Yen','JPY',false,3],
    ['USD/CHF','US Dollar / Swiss Franc','CHF',false,5],
    ['AUD/USD','Australian Dollar / US Dollar','AUD',true,5]
  ];
  const fxTask = (async () => {
    const latest = await fetchJsonWithTimeout('https://api.fxratesapi.com/latest?base=USD&currencies=EUR,GBP,JPY,CHF,AUD&resolution=1m&places=6&format=json');
    const latestDate = String(latest.date || new Date().toISOString()).slice(0, 10);
    const before = new Date(`${latestDate}T00:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 1);
    const earlier = await fetchJsonWithTimeout(`https://api.fxratesapi.com/historical?date=${before.toISOString().slice(0,10)}&base=USD&currencies=EUR,GBP,JPY,CHF,AUD&places=6&format=json`);
    for (const [symbol,name,code,invert,decimals] of fx) {
      const now = Number(latest.rates?.[code]);
      const prev = Number(earlier.rates?.[code]);
      if (!Number.isFinite(now)) continue;
      const price = invert ? 1 / now : now;
      const previous = Number.isFinite(prev) ? (invert ? 1 / prev : prev) : NaN;
      items.push(makeMarketItem(symbol,name,decimals,price,previous));
    }
  })();
  let cachedGold = { date: '', base: NaN };
  const goldTask = (async () => {
    const data = await fetchJsonWithTimeout('https://goldmarketdaily.com/wp-json/gmd/v1/metals');
    const price = Number(data.metals?.gold);
    const previous = Number(data.prev_close?.gold);
    if (!Number.isFinite(price)) return;
    items.unshift(makeMarketItem('XAU/USD','Gold',2,price,Number.isFinite(previous) ? previous : NaN));
    cachedGold = { date: new Date().toISOString().slice(0,10), base: Number.isFinite(previous) ? previous : NaN };
  })();
  await Promise.allSettled([fxTask, goldTask]);
  if (!items.length && Array.isArray(cached?.items) && cached.items.length) return json({ ...cached, stale: true });
  const out = {
    connected: items.length > 0,
    source: [...new Set([...sources, items.some(x => x.symbol === 'XAU/USD') ? 'Gold Market Daily' : '', items.some(x => x.symbol !== 'XAU/USD') ? 'FXRatesAPI' : ''].filter(Boolean))].join(' · '),
    updatedAt: new Date().toISOString(),
    items,
    goldBaseDate: cachedGold.date,
    goldBasePrice: cachedGold.base
  };
  await writeCache(MARKET_CACHE_KEY, { ...out, ts: Date.now() });
  return json(out);
}

async function newsEndpoint() {
  const cached = await readCache(NEWS_CACHE_KEY);
  if (cached?.ts && Date.now() - cached.ts < NEWS_TTL && Array.isArray(cached.items)) return json(cached);
  try {
    const raw = await fetchJsonWithTimeout('https://nfs.faireconomy.media/ff_calendar_thisweek.json', 12_000);
    const items = Array.isArray(raw) ? raw.map(e => ({
      title: e.title || '',
      currency: e.country || e.currency || '',
      impact: e.impact || 'Low',
      datetime: e.date || e.datetime || '',
      forecast: e.forecast || '',
      previous: e.previous || '',
      actual: e.actual || '',
      source: 'Forex Factory'
    })).filter(e => e.title && e.datetime && Number.isFinite(new Date(e.datetime).getTime()))
      .sort((a,b) => new Date(a.datetime) - new Date(b.datetime)) : [];
    const out = { ok: true, connected: items.length > 0, updatedAt: new Date().toISOString(), items, source: 'Forex Factory' };
    await writeCache(NEWS_CACHE_KEY, { ...out, ts: Date.now() });
    return json(out);
  } catch (e) {
    if (Array.isArray(cached?.items) && cached.items.length) return json({ ...cached, stale: true });
    return json({ ok: false, connected: false, updatedAt: new Date().toISOString(), items: [], source: 'Forex Factory', error: 'News feed temporarily unavailable.' }, 502);
  }
}

/* ---- latest market headlines (RSS from public finance news sites, read on the server) ---- */
const HEADLINES_KEY = 'headlines-cache-v1';
const HEADLINES_TTL = 10 * 60 * 1000;
const HEADLINE_FEEDS = [
  { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news' },
  { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { name: 'FXStreet Analysis', url: 'https://www.fxstreet.com/rss/analysis' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'FXEmpire', url: 'https://www.fxempire.com/api/v1/en/articles/rss/news' }
];
const decodeXml = v => String(v || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
  .replace(/\s+/g, ' ').trim();
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(feed.url, { headers: { accept: 'application/rss+xml, application/xml, text/xml', 'user-agent': 'Mozilla/5.0 TradeEdge' }, signal: controller.signal });
    if (!res.ok) throw new Error('feed ' + res.status);
    const xml = await res.text();
    const items = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
      const block = m[0];
      const pick = tag => (block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i')) || [])[1];
      const title = decodeXml(pick('title'));
      const link = decodeXml(pick('link'));
      const when = new Date(decodeXml(pick('pubDate')) || '').getTime();
      if (!title) continue;
      items.push({ title, link: /^https?:\/\//.test(link) ? link : '', datetime: Number.isFinite(when) ? new Date(when).toISOString() : '', source: feed.name });
    }
    return items;
  } finally { clearTimeout(timer); }
}
async function loadHeadlines() {
  const cached = await readCache(HEADLINES_KEY);
  if (cached?.ts && Date.now() - cached.ts < HEADLINES_TTL && Array.isArray(cached.items) && cached.items.length > 12) return cached;
  const results = await Promise.allSettled(HEADLINE_FEEDS.map(fetchFeed));
  const seen = new Set();
  const all = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .filter(x => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  const items = all.slice(0, 80);
  if (!items.length) {
    if (Array.isArray(cached?.items) && cached.items.length) return { ...cached, stale: true };
    return null;
  }
  const feeds = [...new Set(items.map(x => x.source))];
  const out = { ok: true, updatedAt: new Date().toISOString(), items, feeds };
  await writeCache(HEADLINES_KEY, { ...out, ts: Date.now() });
  return out;
}
async function headlinesEndpoint() {
  const d = await loadHeadlines();
  if (!d) return json({ ok: false, items: [], error: 'Headlines feed temporarily unavailable.' }, 502);
  return json({ ok: true, updatedAt: d.updatedAt, stale: d.stale || undefined, items: d.items.slice(0, 12) });
}

/* ---------------------------------------------------------
   WEBSITE API  (only the owner, checked through Telegram)
--------------------------------------------------------- */

function publicAdminUser(u) {
  return {
    id: u.id, name: u.name || '', email: u.email || '', contact: u.contact || '',
    plan: u.plan || '', expiresAt: u.expiresAt || 0, blocked: !!u.blocked,
    owner: !!u.owner, state: accessState(u), createdAt: u.createdAt || ''
  };
}

function adminSnapshot() {
  const users = db.users.filter(u => !u.owner).map(publicAdminUser)
    .sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const ownerWeb = db.users.find(u => u.owner) ? publicAdminUser(db.users.find(u => u.owner)) : null;
  const payments = db.payments.slice().sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(p => {
    const u = db.users.find(x => x.id === p.userId);
    const plan = db.plans.find(x => x.id === p.planId);
    return { id:p.id, userId:p.userId, userName:u?.name||'', userEmail:u?.email||'', planId:p.planId,
      planName:plan?.name||'', days:plan?.days||0, price:plan?.price||'', methodName:p.methodName||p.methodId||'', network:p.network||'', reference:p.reference||'', createdAt:p.createdAt, status:p.status||'pending' };
  });
  const accounts = db.accounts.map(a => ({...a, pnl: accountPnl(a.id), balance: Number(a.startingBalance||0) + accountPnl(a.id)}));
  const models = db.models.map(m => ({...m}));
  const trades = db.trades.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(t => ({...t}));
  const pairs = db.pairs.map(p => ({...p, note: pairNote(p)}));
  return {
    ok:true,
    siteUrl: siteUrl(),
    stats:{users:users.length, pendingPayments:payments.filter(p=>p.status==='pending').length,
      accounts:accounts.length, models:models.length, trades:trades.length, pairs:pairs.length, gifts:(db.gifts||[]).length, promos:(db.promos||[]).length},
    users, ownerWeb, payments, plans: db.plans.map(p=>({...p})), payInfo: db.payInfo || '', paymentMethods: (db.paymentMethods || []).map(x=>({...x})),
    gifts: (db.gifts||[]).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(g=>({...g})),
    promos: (db.promos||[]).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(p=>({id:p.id,code:p.code,days:p.days,months:p.months||0,label:promoLabel(p),maxUses:p.maxUses,used:p.used.length,usedBy:p.used.map(x=>x.email),note:p.note||'',revoked:!!p.revoked,createdAt:p.createdAt})),
    reminder: {...db.reminder}, hideFromViewers: !!db.hideFromViewers, pairs, accounts, models, trades
  };
}

const MEMBER_ADMIN_ACTIONS = ['pair.save', 'pair.delete', 'pair.toggle', 'pair.refresh', 'pairs.refreshAll'];

/* What a member sees in the control panel: ONLY their own overview, per-model analysis and trades. */
function memberSnapshot() {
  const live = db.trades.filter(t => t.active !== false);
  const sum = list => list.reduce((s, t) => s + (typeof t.pnl === 'number' ? t.pnl : 0), 0);
  const calc = list => {
    const wins = list.filter(t => t.status === 'win').length;
    const losses = list.filter(t => t.status === 'loss').length;
    const be = list.filter(t => t.status === 'be').length;
    const closed = wins + losses + be;
    return { trades: list.length, wins, losses, be, open: list.length - closed,
      winRate: (wins + losses) ? Math.round((wins / (wins + losses)) * 1000) / 10 : null, net: Math.round(sum(list) * 100) / 100 };
  };
  const models = db.models.map(m => ({ ...m, image: m.image || '', market: m.market || '',
    active: m.active !== false, ...calc(live.filter(t => t.modelId === m.id)) }));
  const noModel = live.filter(t => !db.models.some(m => m.id === t.modelId));
  if (noModel.length) models.push({ id: '', name: 'No model', image: '', market: '', active: true, ...calc(noModel) });
  const trades = db.trades.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(t => ({ ...t }));
  const accounts = db.accounts.map(a => ({ ...a, pnl: accountPnl(a.id), balance: Number(a.startingBalance || 0) + accountPnl(a.id) }));
  const pairs = db.pairs.map(p => ({ ...p, note: pairNote(p) }));
  const member = db.users.find(u => u.id === scope?.uid) || {};
  return { ok: true, member: true, overview: calc(live), models, trades, accounts, pairs, siteUrl: siteUrl(), currentPlan: member.plan || '', plans: planList(), payInfo: db.payInfo || '', paymentMethods: db.paymentMethods || [], pending: pendingPayment(member) };
}

async function adminAction(req, body) {
  const action = String(body.action || '').trim();
  if (!action) return bad('action is required');
  switch (action) {
    case 'payment.approve': {
      const p = db.payments.find(x => x.id === String(body.id));
      if (!p || p.status !== 'pending') return bad('Payment request not found or already handled');
      const u = db.users.find(x => x.id === p.userId);
      const plan = db.plans.find(x => x.id === p.planId);
      if (!u || !plan) return bad('Subscriber or plan no longer exists');
      extendUser(u, plan.days, plan.name); p.status='approved'; p.handledAt=new Date().toISOString(); save();
      return json({ok:true, message:`Approved ${u.name}`});
    }
    case 'payment.reject': {
      const p = db.payments.find(x => x.id === String(body.id));
      if (!p || p.status !== 'pending') return bad('Payment request not found or already handled');
      p.status='rejected'; p.handledAt=new Date().toISOString(); save(); return json({ok:true});
    }
    case 'user.extend': {
      const u = db.users.find(x => x.id === String(body.id));
      const days = Math.round(Number(body.days));
      if (!u || !(days >= 1 && days <= 3650)) return bad('Invalid subscriber or days');
      extendUser(u, days, String(body.plan || u.plan || 'Manual').slice(0,40));
      return json({ok:true});
    }
    case 'user.toggleBlock': {
      const u = db.users.find(x => x.id === String(body.id));
      if (!u) return bad('Subscriber not found');
      u.blocked = !u.blocked; save(); return json({ok:true, blocked:u.blocked});
    }
    case 'user.save': {
      const id=String(body.id||'').trim();
      const name=String(body.name||'').trim().slice(0,80);
      const email=String(body.email||'').trim().toLowerCase().slice(0,120);
      const contact=String(body.contact||'').trim().slice(0,80);
      const password=String(body.password||'');
      const blocked=!!body.blocked;
      if(!name) return bad('Name is required');
      if(!EMAIL_RE.test(email)) return bad('Enter a valid email');
      const clash=db.users.find(u=>u.email===email && u.id!==id);
      if(clash) return bad('That email is already in use');
      let u=id?db.users.find(x=>x.id===id):null;
      if(id && !u) return notFound();
      if(u?.owner) return bad('Use owner credentials to edit the owner website login');
      if(!u){
        if(password.length<8) return bad('Password must be at least 8 characters');
        u={id:newId(),name,email,contact,pass:hashPassword(password),createdAt:new Date().toISOString(),expiresAt:0,plan:'',blocked:false,owner:false};
        db.users.push(u);
      }else{
        u.name=name; u.email=email; u.contact=contact; u.blocked=blocked;
        if(password){if(password.length<8) return bad('Password must be at least 8 characters');u.pass=hashPassword(password);}
      }
      save(); return json({ok:true,item:publicAdminUser(u)});
    }
    case 'owner.credentials': {
      const name=String(body.name||'Owner').trim().slice(0,80)||'Owner';
      const email=String(body.email||'').trim().toLowerCase().slice(0,120);
      const password=String(body.password||'');
      if(!EMAIL_RE.test(email)) return bad('Enter a valid email');
      if(password.length<8) return bad('Password must be at least 8 characters');
      let owner=db.users.find(x=>x.owner);
      const clash=db.users.find(u=>u.email===email && (!owner || u.id!==owner.id));
      if(clash) return bad('That email is already used by another account');
      if(!owner){owner={id:newId(),name,email,contact:'',createdAt:new Date().toISOString(),expiresAt:0,plan:'',blocked:false,owner:true};db.users.push(owner);}
      Object.assign(owner,{name,email,owner:true,blocked:false,pass:hashPassword(password)});
      save(); return json({ok:true,item:publicAdminUser(owner)});
    }
    case 'gift.create': {
      const recipientId=String(body.recipientId||'').trim();
      let u=recipientId?db.users.find(x=>x.id===recipientId && !x.owner):null;
      if(!u){
        const name=String(body.name||'').trim().slice(0,80);
        const email=String(body.email||'').trim().toLowerCase().slice(0,120);
        const password=String(body.password||'');
        if(!name) return bad('Recipient name is required for a new recipient');
        if(!EMAIL_RE.test(email)) return bad('Enter a valid recipient email');
        if(password.length<8) return bad('Password must be at least 8 characters for a new recipient');
        if(db.users.some(x=>x.email===email)) return bad('That email is already registered. Select that subscriber instead.');
        u={id:newId(),name,email,contact:String(body.contact||'').trim().slice(0,80),pass:hashPassword(password),createdAt:new Date().toISOString(),expiresAt:0,plan:'',blocked:false,owner:false};
        db.users.push(u);
      }
      if(u.blocked) return bad('Unblock this recipient before gifting access');
      const days=Math.round(Number(body.days));
      if(!(days>=1&&days<=3650)) return bad('Gift days must be between 1 and 3650');
      const plan=body.planId?db.plans.find(p=>p.id===String(body.planId)):null;
      const planName=plan?.name || String(body.planName||'Gift').trim().slice(0,40) || 'Gift';
      extendUser(u,days,planName);
      const gift={id:newId(),userId:u.id,recipientName:u.name,recipientEmail:u.email,planName,days,note:String(body.note||'').trim().slice(0,500),createdAt:new Date().toISOString()};
      db.gifts=Array.isArray(db.gifts)?db.gifts:[]; db.gifts.push(gift); save();
      return json({ok:true,gift,item:publicAdminUser(u)});
    }
    case 'gift.revoke': {
      const id=String(body.id||'').trim(); const g=(db.gifts||[]).find(x=>x.id===id);
      if(!g) return bad('Gift not found');
      if(g.revokedAt) return bad('Gift already revoked');
      const u=db.users.find(x=>x.id===g.userId);
      if(u){ const remaining=Math.max(0,Number(u.expiresAt||0)-Date.now()); const giftMs=Math.min(remaining,Number(g.days||0)*DAY); u.expiresAt=Math.max(Date.now(),Number(u.expiresAt||0)-giftMs); if(u.expiresAt<=Date.now()) u.plan=''; }
      g.revokedAt=new Date().toISOString(); save(); return json({ok:true});
    }
    case 'promo.create': {
      const months=Math.round(Number(body.months||0)), days=Math.round(Number(body.days||0)), uses=Math.round(Number(body.uses||1));
      if(!(months>=1&&months<=60) && !(days>=1&&days<=3650)) return bad('Choose months or days');
      if(!(uses>=1&&uses<=1000)) return bad('Number of uses must be 1 to 1000');
      const promo=createPromo({months:months||0,days:months?0:days,uses,note:body.note});
      return json({ok:true,code:promo.code});
    }
    case 'promo.revoke': {
      const p=(db.promos||[]).find(x=>x.id===String(body.id)); if(!p) return bad('Promo code not found');
      p.revoked=!p.revoked; save(); return json({ok:true,revoked:p.revoked});
    }
    case 'promo.delete': {
      const before=(db.promos||[]).length; db.promos=(db.promos||[]).filter(x=>x.id!==String(body.id));
      if(db.promos.length===before) return bad('Promo code not found'); save(); return json({ok:true});
    }
    case 'plan.add': {
      const name=String(body.name||'').trim().slice(0,40), days=Math.round(Number(body.days)), price=String(body.price||'').trim().slice(0,40);
      if (!name || !(days>=1 && days<=3650)) return bad('Plan name and days are required');
      db.plans.push({id:newId(),name,days,price}); save(); return json({ok:true});
    }
    case 'plan.delete': {
      const id=String(body.id||''); if(db.plans.length<=1) return bad('Keep at least one plan');
      if(!db.plans.some(p=>p.id===id)) return bad('Plan not found'); db.plans=db.plans.filter(p=>p.id!==id); save(); return json({ok:true});
    }
    case 'privacy.set': {
      db.hideFromViewers = !!body.hide; save(); return json({ok:true, hide:db.hideFromViewers});
    }
    case 'payinfo.set': {
      db.payInfo=String(body.text||'').trim().slice(0,2000); save(); return json({ok:true});
    }
    case 'payment-methods.set': {
      const methods = Array.isArray(body.methods) ? body.methods : [];
      if (!methods.length || methods.length > 10) return bad('Add at least one payment method');
      db.paymentMethods = methods.map((m, i) => ({
        id: String(m.id || ('method-' + i)).trim().slice(0,40),
        region: m.region === 'intl' ? 'intl' : 'et',
        name: String(m.name || '').trim().slice(0,80),
        instructions: String(m.instructions || '').trim().slice(0,1000)
      })).filter(m => m.name && m.instructions);
      if (!db.paymentMethods.length) return bad('Payment method name and instructions are required');
      save(); return json({ok:true, paymentMethods:db.paymentMethods});
    }
    case 'reminder.set': {
      const hour=Math.round(Number(body.hour)), offset=Number(body.utcOffset);
      if(!(hour>=0&&hour<=23) || !(offset>=-12&&offset<=14)) return bad('Invalid reminder time or timezone');
      db.reminder.enabled=!!body.enabled; db.reminder.hour=hour; db.reminder.utcOffset=offset; db.reminder.custom=true; save(); return json({ok:true});
    }
    case 'reminder.test': {
      await refreshPairAnalyses(false); await sendPlan(); return json({ok:true});
    }
    case 'pair.save': {
      const symbol=normSymbol(body.symbol); const buy=Number(body.buyPercent);
      if(!symbol || !(buy>=0&&buy<=100)) return bad('Pair and buy % are required');
      const fields={buyPercent:round(buy), sellPercent:round(100-buy), fundamental:String(body.fundamental||'').trim().slice(0,1500), technical:String(body.technical||'').trim().slice(0,1500), trading:!!body.trading};
      let p=db.pairs.find(x=>x.id===String(body.id||''));
      if(!p) { p=db.pairs.find(x=>x.symbol===symbol); }
      if(p) Object.assign(p,{symbol,...fields}); else { p={id:newId(),symbol,...fields}; db.pairs.push(p); }
      db.pairsUpdatedAt=new Date().toISOString(); save();
      try { await enrichPairAnalysis(p, true); save(); } catch(e) { console.error('admin pair analysis failed',e); }
      return json({ok:true,item:{...p,note:pairNote(p)}});
    }
    case 'pair.delete': return json({ok:removeRecord('pairs',String(body.id))});
    case 'pair.toggle': {
      const p=db.pairs.find(x=>x.id===String(body.id)); if(!p) return bad('Pair not found'); p.trading=!p.trading; save(); return json({ok:true});
    }
    case 'pair.refresh': {
      const p=db.pairs.find(x=>x.id===String(body.id)); if(!p) return bad('Pair not found');
      await enrichPairAnalysis(p, true); save(); return json({ok:true,item:{...p,note:pairNote(p)}});
    }
    case 'pairs.refreshAll': {
      await refreshPairAnalyses(true); return json({ok:true});
    }
    default: return bad('Unknown admin action');
  }
}

async function adminApi(req, url) {
  if (req.method === 'GET') return json(adminSnapshot());
  if (req.method === 'POST') {
    const { body } = await readRequest(req);
    return adminAction(req, body);
  }
  return text('method not allowed', 405);
}

async function api(req, url) {
  const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const resource = parts[0] || '';
  const sub = parts[1] || '';
  const action = parts[2] || '';
  const method = req.method;
  const read = method === 'GET' || method === 'HEAD';
  const writeMethod = method === 'POST' || method === 'PUT' || method === 'PATCH';

  // open to everybody
  if (resource === 'plans' && read) return json({ plans: planList(), payInfo: db.payInfo || '', paymentMethods: db.paymentMethods || [], botUsername: db.botUsername || '', ...siteCfg() });
  if (resource === 'signup' && method === 'POST') return signup(req);
  if (resource === 'login' && method === 'POST') return login(req);
  if (resource === 'logout') return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });

  // who is it?  Telegram owner = full access.  Website account = look only, and only while subscribed.
  const who = identify(req);
  const owner = who.owner;
  let user = who.user;
  // opened the Mini App without pressing /start first: make the account now (free trial)
  if (!owner && who.viaTg && !user && who.tg) user = (await memberFromTelegram(who.tg, '')).user;
  const viaTg = who.viaTg;

  if (resource === 'session') {
    if (owner) return json({ mode: 'owner' });
    if (!user) return json({ error: 'login required' }, 401);
    const state = accessState(user);
    // in Telegram = full use of their OWN data;  in Chrome = look only
    return state === 'active' ? json({ mode: viaTg && !user.owner ? 'member' : 'viewer', user: publicUser(user) }) : gate(user, state);
  }
  if (resource === 'admin') {
    if (owner) return adminApi(req, url);
    // A member / subscriber may open the control panel too, but only to LOOK at their OWN
    // overview, per-model analysis and trades. No editing, no owner tools.
    if (!user) return json({ error: 'login required' }, 401);
    const mstate = accessState(user);
    if (mstate !== 'active') return gate(user, mstate);
    if (user.owner) return json({ error: 'owner access required' }, 403);
    if (method === 'GET') { enterScope(user.id); return json(memberSnapshot()); }
    // In Telegram a member can add / edit THEIR OWN pairs here (accounts, models and trades use their own endpoints).
    // Only pair actions are allowed; everything else in adminAction stays owner-only.
    if (method === 'POST' && viaTg) {
      const { body: abody } = await readRequest(req);
      const act = String(abody.action || '');
      if (!MEMBER_ADMIN_ACTIONS.includes(act)) return json({ error: 'This action is for the owner only.' }, 403);
      enterScope(user.id);
      return adminAction(req, abody);
    }
    return json({ error: 'The website in Chrome is look-only. Open the control panel in Telegram to add or change data.' }, 403);
  }

  if (resource === 'subscribe' && method === 'POST') {
    return user ? subscribe(req, user) : json({ error: 'login required' }, 401);
  }
  if (resource === 'redeem' && method === 'POST') {
    return user ? redeem(req, user) : json({ error: 'login required' }, 401);
  }
  if (!owner) {
    if (!user) return json({ error: 'login required' }, read ? 401 : 403);
    const state = accessState(user);
    if (state !== 'active') return gate(user, state);
    if (!read && !(viaTg && !user.owner)) return json({ error: 'The website is read-only. Use the Telegram bot to change data.' }, 403);
    if (!user.owner) enterScope(user.id);        // a member only ever sees their OWN accounts, models, trades and pairs
  }

  // Safety net: if for any reason a member's own lists are not swapped in, stop here instead of
  // answering from the OWNER's accounts / models / trades / pairs.
  if (!owner && !(user && user.owner) && !scope) return json({ error: 'Could not open your own data. Please try again.' }, 500);

  const { body, files } = writeMethod ? await readRequest(req) : { body: {}, files: [] };

  // Paid subscribers and the owner's own website login can LOOK at the journal data.
  // The owner can hide ETB amounts, notes and screenshots from subscribers (not from the owner login)
  // with the "Subscriber privacy" switch in the control panel.
  const ownerWeb = !owner && !!user && !!user.owner;
  const hide = false;      // members only see their own data, so nothing needs hiding
  const shown = t => (hide ? { ...t, pnlEtb: null, notes: '', notesAm: '', notesEn: '', images: [] } : t);

  /* ---- accounts ---- */
  if (resource === 'accounts') {
    if (method === 'GET' && !sub) return json({ items: db.accounts });
    if (method === 'POST' && !sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const f = accountFields(body);
      if (!f) return bad('name and startingBalance are required');
      const img = filesNamed(files, 'image')[0];
      const rec = { id: newId(), ...f, image: img ? saveUpload(img) : '', createdAt: new Date().toISOString() };
      db.accounts.push(rec); save();
      return json(rec);
    }
    if ((method === 'PUT' || method === 'PATCH') && sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const rec = findRec('accounts', sub);
      if (!rec) return notFound();
      const f = accountFields({ ...rec, ...body });
      if (!f) return bad('invalid account');
      Object.assign(rec, f);
      const img = filesNamed(files, 'image')[0];
      if (img) { if (rec.image) removeFile(rec.image); rec.image = saveUpload(img); }
      else if (body.removeImage === 'true' || body.removeImage === true) { if (rec.image) removeFile(rec.image); rec.image = ''; }
      save();
      return json(rec);
    }
    if (method === 'DELETE' && sub) return removeRecord('accounts', sub) ? json({ ok: true }) : notFound();
  }

  /* ---- models ---- */
  if (resource === 'models') {
    if (method === 'GET' && !sub) return json({ items: db.models });
    if (method === 'POST' && !sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const f = modelFields(body);
      if (!f) return bad('name is required');
      const img = filesNamed(files, 'image')[0];
      const rec = { id: newId(), ...f, image: img ? saveUpload(img) : '', createdAt: new Date().toISOString() };
      db.models.push(rec); save();
      return json(rec);
    }
    if ((method === 'PUT' || method === 'PATCH') && sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const rec = findRec('models', sub);
      if (!rec) return notFound();
      const f = modelFields({ ...rec, ...body });
      if (!f) return bad('invalid model');
      Object.assign(rec, f);
      const img = filesNamed(files, 'image')[0];
      if (img) { removeFile(rec.image); rec.image = saveUpload(img); }
      save();
      return json(rec);
    }
    if (method === 'DELETE' && sub) return removeRecord('models', sub) ? json({ ok: true }) : notFound();
  }

  /* ---- journal (trades) ---- */
  if (resource === 'journal') {
    if (sub && action === 'images' && method === 'POST') {
      const rec = findRec('trades', sub);
      if (!rec) return notFound();
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const pics = filesNamed(files, 'images');
      const hasCover = body.cover !== undefined && body.cover !== '';
      if (!pics.length && !hasCover) return bad('Choose at least one picture.');
      const added = pics.map(saveUpload);
      rec.images = (rec.images || []).concat(added);
      if (hasCover) rec.images = moveCoverFirst(rec.images, body.cover);      // the picture chosen as "front" goes first
      save();
      return json({ ok: true, id: rec.id, images: rec.images, added });
    }
    if (method === 'POST' && sub === 'translate') {              // translate the notes of older trades (a few per call)
      const batch = db.trades.filter(needsTranslation).slice(0, 6);
      await Promise.all(batch.map(localizeNotes));
      if (batch.length) save();
      return json({ ok: true, remaining: db.trades.filter(needsTranslation).length });
    }
    if (method === 'GET' && sub === 'all') return json({ items: db.trades.map(shown) });
    if (method === 'GET' && sub === 'recent') return json({ items: db.trades.slice(0, 10).map(shown) });
    if (method === 'POST' && !sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const data = parseTrade(body);
      const f = data && tradeFields(data);
      if (!f) return bad('account and pair are required');
      const rec = { id: newId(), ...f, images: filesNamed(files, 'images').map(saveUpload) };
      await localizeNotes(rec);
      db.trades.push(rec); sortTrades(); save();
      return json(rec);
    }
    if ((method === 'PUT' || method === 'PATCH') && sub) {
      if (files.some(f => !['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))) return bad('Unsupported picture type. Use JPG, PNG, WEBP, or GIF.');
      const rec = findRec('trades', sub);
      if (!rec) return notFound();
      // the Enable/Disable button sends plain JSON {active}; the edit form sends a "data" field
      const data = body.data === undefined ? body : parseTrade(body);
      const f = data && tradeFields({ ...rec, ...data });
      if (!f) return bad('invalid trade');
      Object.assign(rec, f);
      await localizeNotes(rec);
      const pics = filesNamed(files, 'images');
      if (pics.length) { (rec.images || []).forEach(removeFile); rec.images = pics.map(saveUpload); }
      sortTrades(); save();
      return json(rec);
    }
    if (method === 'DELETE' && sub) return removeRecord('trades', sub) ? json({ ok: true }) : notFound();
  }

  /* ---- live market feed ---- */
  if (resource === 'market' && method === 'GET' && !sub) return marketEndpoint();
  if (resource === 'news' && method === 'GET' && !sub) return newsEndpoint();
  if (resource === 'headlines' && method === 'GET' && !sub) return headlinesEndpoint();

  /* ---- market analysis pairs ---- */
  if (resource === 'analysis' && sub === 'pairs' && method === 'GET') {
    return json({
      source: 'Telegram bot',
      updatedAt: db.pairsUpdatedAt,
      items: db.pairs.map(p => ({
        symbol: p.symbol, buyPercent: p.buyPercent, sellPercent: p.sellPercent,
        fundamental: p.fundamental || '', technical: p.technical || '',
        autoFundamental: p.autoFundamental || '', autoTechnical: p.autoTechnical || '',
        autoBias: p.autoBias || '', autoSources: p.autoSources || [], autoAnalyzedAt: p.autoAnalyzedAt || '',
        autoSummary: p.autoSummary || '', autoReport: p.autoReport || null,
        trading: !!p.trading, note: pairNote(p)
      }))
    });
  }

  return notFound();
}

async function serveImage(pathname, req) {
  const who = identify(req);
  if (!who.owner) {
    const user = who.user;
    if (!user || accessState(user) !== 'active') return text('forbidden', 403);
    if (!user.owner) {                                   // a member may only open pictures from their own records
      const url = pathname;
      const ud = (db.userData || {})[user.id];
      const mine = !!ud && (ud.accounts.some(a => a.image === url) || ud.models.some(m => m.image === url) || ud.trades.some(t => (t.images || []).includes(url)));
      if (!mine) return text('forbidden', 403);
    }
  }

  const name = pathname.slice('/uploads/'.length);
  if (!/^[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(name)) return text('not found', 404);
  const found = await store.getWithMetadata('img/' + name, { type: 'arrayBuffer' });
  if (!found) return text('not found', 404);
  return new Response(found.data, {
    headers: {
      'content-type': (found.metadata && found.metadata.contentType) || 'image/jpeg',
      'cache-control': 'private, max-age=86400'
    }
  });
}

/* =========================================================
   TELEGRAM BOT
========================================================= */
let bot;
let botReady;

const money = n => (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const accountPnl = id => db.trades.filter(t => t.accountId === id && t.active !== false && typeof t.pnl === 'number')
  .reduce((s, t) => s + t.pnl, 0);

function normSymbol(value) {
  const s = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{6}$/.test(s) ? s.slice(0, 3) + '/' + s.slice(3) : value.toUpperCase().trim();
}


function controlPanelUrl() {
  const base = siteUrl();
  return isHttps(base) ? base.replace(/\/$/, '') + '/admin/' : '';
}

function menuKb() {
  const kb = new InlineKeyboard();
  const base = siteUrl();
  if (scope) {                                                  // a member: only their own journal
    if (isHttps(base)) kb.webApp('📱 Open app', base.replace(/\/$/, '') + '/').webApp('⚙️ Control Panel', base.replace(/\/$/, '') + '/admin/').row();
    return kb
      .text('➕ Trade', 'new:trade').text('📒 Trades', 'list:trades').row()
      .text('➕ Account', 'new:account').text('🏦 Accounts', 'list:accounts').row()
      .text('➕ Model', 'new:model').text('🧠 Models', 'list:models').row()
      .text('➕ Analysis (Pair)', 'new:pair').text('📊 Analysis', 'list:pairs').row()
      .text('⏳ My plan', 'myplan');
  }
  const panel = controlPanelUrl();
  if (panel) kb.webApp('⚙️ Control Panel', panel).row();
  return kb
    .text('➕ Trade', 'new:trade').text('📒 Trades', 'list:trades').row()
    .text('➕ Account', 'new:account').text('🏦 Accounts', 'list:accounts').row()
    .text('➕ Model', 'new:model').text('🧠 Models', 'list:models').row()
    .text('➕ Pair', 'new:pair').text('📊 Pairs', 'list:pairs').row()
    .text('👥 Subscribers', 'list:users').text('💳 Payments', 'list:pay').row()
    .text('🎁 Gift / Promo code', 'promo:new').text('🎟 Promo codes', 'promo:list').row()
    .text('💳 Plans & prices', 'pl:home').text('🌐 Website link', 'site');
}
const showMenu = (ctx, message = 'Trade Edge – what do you want to do?') => {
  if (!scope && db.edit) { db.edit = null; save(); }          // leaving the plans editor
  return ctx.reply(message, { reply_markup: menuKb() });
};

/* ---------- step-by-step forms ("flows") ----------
   The bot may be asleep between two messages, so the form's
   progress ({ name, i, data }) is saved after every answer.   */
const FLOWS = {
  account: {
    steps: [
      { key: 'name', ask: '🏦 Account name?', type: 'text' },
      { key: 'type', ask: 'Account type?', type: 'choice',
        options: () => [['Funded', 'funded'], ['Phase', 'phase'], ['Live', 'live']] },
      { key: 'startingBalance', ask: 'Starting balance? (number)', type: 'number', min: 0 },
      { key: 'description', ask: '📝 Short description of this account? (optional)', type: 'text', optional: true },
      { key: 'images', ask: '📷 Send a picture of the account (optional).', type: 'photos', max: 1, optional: true }
    ],
    done: async (ctx, d) => {
      db.accounts.push({ id: newId(), name: d.name, type: d.type, startingBalance: d.startingBalance,
        description: String(d.description || '').trim(), image: (d.images && d.images[0]) || '',
        createdAt: new Date().toISOString() });
      save();
      await showMenu(ctx, `✅ Account "${d.name}" added.`);
    }
  },

  model: {
    steps: [
      { key: 'name', ask: '🧠 Model name?', type: 'text' },
      { key: 'market', ask: 'Market?', type: 'choice',
        options: () => [['Forex', 'forex'], ['Metal', 'metal'], ['Index', 'index']] },
      { key: 'symbols', ask: 'Pairs traded? (e.g. EUR/USD, XAU/USD)', type: 'text' },
      { key: 'timeframe', ask: 'Timeframe? (e.g. M15)', type: 'text' },
      { key: 'session', ask: 'Session?', type: 'choice',
        options: () => [['Any', 'any'], ['Asia', 'asia'], ['London', 'london'], ['New York', 'newyork'], ['London / New York', 'london_newyork']] },
      { key: 'riskPercent', ask: 'Risk % per trade? (e.g. 1)', type: 'number', min: 0, max: 100 },
      { key: 'description', ask: 'Short description?', type: 'text', optional: true },
      { key: 'images', ask: '📷 Send a picture of the model (optional).', type: 'photos', max: 1, optional: true }
    ],
    done: async (ctx, d) => {
      db.models.push({
        id: newId(), name: d.name, market: d.market, symbols: d.symbols, timeframe: d.timeframe,
        session: d.session, riskPercent: d.riskPercent, description: d.description || '',
        image: (d.images && d.images[0]) || '', active: true, createdAt: new Date().toISOString()
      });
      save();
      await showMenu(ctx, `✅ Model "${d.name}" added.`);
    }
  },

  pair: {
    steps: [
      { key: 'symbol', ask: '📊 Pair? (e.g. EURUSD or XAUUSD)', type: 'text', transform: normSymbol },
      { key: 'buyPercent', ask: 'What % of traders are BUYING? (0-100, sellers = the rest)',
        type: 'number', min: 0, max: 100 },
      { key: 'fundamental', ask: '📰 Fundamental view? (news / economic reason)', type: 'text', optional: true },
      { key: 'technical', ask: '📈 Technical view? (levels / structure)', type: 'text', optional: true },
      { key: 'trading', ask: '🎯 Will you trade this pair this week?', type: 'choice',
        options: () => [['Yes ✅', 'yes'], ['No', 'no']] }
    ],
    done: async (ctx, d) => {
      const fields = { buyPercent: d.buyPercent, sellPercent: round(100 - d.buyPercent),
        fundamental: d.fundamental || '', technical: d.technical || '', trading: d.trading === 'yes' };
      let rec = db.pairs.find(p => p.symbol === d.symbol);
      if (rec) Object.assign(rec, fields);
      else {
        rec = { id: newId(), symbol: d.symbol, ...fields };
        db.pairs.push(rec);
      }
      db.pairsUpdatedAt = new Date().toISOString();
      save();
      let auto = false;
      try { await enrichPairAnalysis(rec, true); save(); auto = !!(rec.autoFundamental || rec.autoTechnical); } catch (e) { console.error('pair auto-analysis failed', e); }
      await showMenu(ctx, `✅ ${d.symbol}: buy ${d.buyPercent}% / sell ${round(100 - d.buyPercent)}%`
        + (d.trading === 'yes' ? ' – on your trade list this week 🎯' : '')
        + (auto ? '\n🔎 Web analysis updated automatically.' : '\n⚠️ Web analysis is temporarily unavailable; it will retry on the weekly plan.'));
    }
  },

  trade: {
    check: () => (db.accounts.length ? null : '⚠️ Add an account first.'),
    steps: [
      { key: 'accountIds', ask: '🏦 Which account(s)? Tap to select one or more (the same trade is saved on each), then press Done.', type: 'multichoice',
        when: () => db.accounts.length > 1, options: () => db.accounts.map(a => [a.name, a.id]) },
      { key: 'modelId', ask: 'Which model?', type: 'choice',
        options: () => db.models.map(m => [m.name, m.id]).concat([['No model', 'none']]) },
      { key: 'symbol', ask: 'Pair? (e.g. EURUSD)', type: 'text', transform: normSymbol },
      { key: 'side', ask: 'Direction?', type: 'choice', options: () => [['Buy', 'buy'], ['Sell', 'sell']] },
      { key: 'status', ask: 'Result?', type: 'choice',
        options: () => [['Win ✅', 'win'], ['Loss ❌', 'loss'], ['Breakeven', 'be'], ['Open', 'open']] },
      { key: 'timeframe', ask: '⏱ Timeframe? (e.g. M15, H1)', type: 'text' },
      { key: 'tradeDate', ask: '📅 Trade date/time? (YYYY-MM-DD HH:MM, UTC+3)', type: 'date' },
      { key: 'entry', ask: 'Entry price?', type: 'number' },
      { key: 'stopLoss', ask: 'Stop loss price?', type: 'number', optional: true },
      { key: 'takeProfit', ask: 'Take profit price?', type: 'number', optional: true },
      { key: 'exit', ask: 'Exit price?', type: 'number', optional: true, when: d => d.status !== 'open' },
      { key: 'pnl', ask: 'How much did you win/lose in USD? (positive amount only)', type: 'number', min: 0,
        when: d => d.status === 'win' || d.status === 'loss' },
      { key: 'pnlEtb', ask: '💰 How much did you win/lose in ETB? (positive amount only)', type: 'number', min: 0,
        when: d => d.status === 'win' || d.status === 'loss' },
      { key: 'rr', ask: 'Risk/Reward in R? (e.g. 2)', type: 'number', optional: true },
      { key: 'lotSize', ask: 'Lot size?', type: 'number', optional: true },
      { key: 'psychology', ask: 'Psychology?', type: 'choice',
        options: () => [['Good', 'good'], ['Normal', 'normal'], ['Bad', 'bad']] },
      { key: 'followedPlan', ask: 'Did you follow your plan?', type: 'choice',
        options: () => [['Yes', 'yes'], ['No', 'no']] },
      { key: 'notes', ask: '📝 Notes?', type: 'text', optional: true },
      { key: 'images', ask: '📷 Send as many screenshots as you need, one by one. Press Done when finished.', type: 'photos', optional: true },
      { key: 'cover', ask: '⭐ Which picture should be shown first (in front)? Pictures are numbered in the order you sent them.', type: 'choice', perRow: 4,
        when: d => (d.images || []).length > 1, options: d => coverOptions((d.images || []).length) }
    ],
    done: async (ctx, d) => {
      const model = db.models.find(m => m.id === d.modelId);
      const ids = (d.accountIds && d.accountIds.length) ? d.accountIds : (db.accounts.length === 1 ? [db.accounts[0].id] : []);
      const base = {
        ...d,
        modelId: model ? model.id : '',
        strategy: model ? model.name : '',
        createdAt: d.tradeDate,
        followedPlan: d.followedPlan === 'yes',
        active: true,
        entryDecimals: Math.min(5, ((d.entryRaw || '').split('.')[1] || '').length)
      };
      const all = ids.map(id => tradeFields({ ...base, accountId: id }));
      if (!all.length || all.some(f => !f)) return showMenu(ctx, '⚠️ Invalid trade data. Nothing was saved.');
      const pictures = moveCoverFirst(d.images || [], d.cover);
      const made = [];
      for (let k = 0; k < all.length; k++) {
        const rec = { id: newId(), ...all[k], images: k === 0 ? pictures : await copyImages(pictures) };
        if (k === 0) await localizeNotes(rec);
        else for (const key of ['notesAm', 'notesEn', 'notesFor']) if (made[0][key] !== undefined) rec[key] = made[0][key];
        db.trades.push(rec);
        made.push(rec);
      }
      sortTrades();
      save();
      const rec = made[0];
      const names = made.map(r => (db.accounts.find(a => a.id === r.accountId) || {}).name).filter(Boolean);
      await showMenu(ctx, `✅ Trade saved: ${rec.symbol} ${rec.side.toUpperCase()}`
        + (rec.pnl === null ? '' : ` ${rec.pnl >= 0 ? '+' : ''}${money(rec.pnl)}`)
        + (made.length > 1 ? `\n🏦 On ${made.length} accounts: ${names.join(', ')}` : ''));
    }
  },

  editAccount: {
    steps: [
      { key: 'name', ask: '🏦 New account name? (Skip = keep current)', type: 'text', optional: true },
      { key: 'type', ask: 'Account type? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Funded', 'funded'], ['Phase', 'phase'], ['Live', 'live']] },
      { key: 'startingBalance', ask: 'Starting balance? (Skip = keep current)', type: 'number', min: 0, optional: true },
      { key: 'description', ask: '📝 Short description? (Skip = keep current)', type: 'text', optional: true },
      { key: 'images', ask: '📷 Send a new account picture, then press Done. (Skip = keep current)', type: 'photos', max: 1, optional: true }
    ],
    done: async (ctx, d) => {
      const rec = db.accounts.find(a => a.id === d.id);
      if (!rec) return showMenu(ctx, '⚠️ Account no longer exists.');
      if (d.name !== undefined) rec.name = String(d.name).trim();
      if (d.type !== undefined) rec.type = d.type;
      if (d.startingBalance !== undefined) rec.startingBalance = d.startingBalance;
      if (d.description !== undefined) rec.description = String(d.description).trim();
      if (d.images !== undefined && d.images.length) { if (rec.image) removeFile(rec.image); rec.image = d.images[0]; }
      save();
      await showMenu(ctx, `✅ Account "${rec.name}" updated.`);
    }
  },

  editModel: {
    steps: [
      { key: 'name', ask: '🧠 New model name? (Skip = keep current)', type: 'text', optional: true },
      { key: 'market', ask: 'Market? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Forex', 'forex'], ['Metal', 'metal'], ['Index', 'index']] },
      { key: 'symbols', ask: 'Pairs traded? (Skip = keep current)', type: 'text', optional: true },
      { key: 'timeframe', ask: 'Timeframe? (Skip = keep current)', type: 'text', optional: true },
      { key: 'session', ask: 'Session? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Any', 'any'], ['Asia', 'asia'], ['London', 'london'], ['New York', 'newyork'], ['London / New York', 'london_newyork']] },
      { key: 'riskPercent', ask: 'Risk % per trade? (Skip = keep current)', type: 'number', min: 0, max: 100, optional: true },
      { key: 'description', ask: 'Short description? (Skip = keep current)', type: 'text', optional: true },
      { key: 'images', ask: '📷 Send a new model picture, then press Done. (Skip = keep current)', type: 'photos', max: 1, optional: true }
    ],
    done: async (ctx, d) => {
      const rec = db.models.find(m => m.id === d.id);
      if (!rec) return showMenu(ctx, '⚠️ Model no longer exists.');
      if (d.name !== undefined) rec.name = String(d.name).trim();
      if (d.market !== undefined) rec.market = d.market;
      if (d.symbols !== undefined) rec.symbols = String(d.symbols).trim();
      if (d.timeframe !== undefined) rec.timeframe = String(d.timeframe).trim();
      if (d.session !== undefined) rec.session = d.session;
      if (d.riskPercent !== undefined) rec.riskPercent = d.riskPercent;
      if (d.description !== undefined) rec.description = String(d.description).trim();
      if (d.images !== undefined && d.images.length) { if (rec.image) removeFile(rec.image); rec.image = d.images[0]; }
      save();
      await showMenu(ctx, `✅ Model "${rec.name}" updated.`);
    }
  },

  editTrade: {
    check: () => (db.trades.length ? null : '⚠️ No trades yet.'),
    steps: [
      { key: 'accountId', ask: 'Which account?', type: 'choice', options: () => db.accounts.map(a => [a.name, a.id]) },
      { key: 'modelId', ask: 'Which model?', type: 'choice', options: () => db.models.map(m => [m.name, m.id]).concat([['No model', 'none']]) },
      { key: 'symbol', ask: 'Pair? (Skip = keep current)', type: 'text', transform: normSymbol, optional: true },
      { key: 'side', ask: 'Direction? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Buy', 'buy'], ['Sell', 'sell']] },
      { key: 'status', ask: 'Result? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Win ✅', 'win'], ['Loss ❌', 'loss'], ['Breakeven', 'be'], ['Open', 'open']] },
      { key: 'timeframe', ask: '⏱ Timeframe? (Skip = keep current)', type: 'text', optional: true },
      { key: 'tradeDate', ask: '📅 Trade date/time? (YYYY-MM-DD HH:MM, UTC+3; Skip = keep current)', type: 'date', optional: true },
      { key: 'entry', ask: 'Entry price? (Skip = keep current)', type: 'number', optional: true },
      { key: 'stopLoss', ask: 'Stop loss price? (Skip = keep current)', type: 'number', optional: true },
      { key: 'takeProfit', ask: 'Take profit price? (Skip = keep current)', type: 'number', optional: true },
      { key: 'exit', ask: 'Exit price? (Skip = keep current)', type: 'number', optional: true },
      { key: 'pnl', ask: 'USD P/L amount, positive only? (Skip = keep current)', type: 'number', min: 0, optional: true, when: d => d.status === 'win' || d.status === 'loss' },
      { key: 'pnlEtb', ask: 'ETB P/L amount, positive only? (Skip = keep current)', type: 'number', min: 0, optional: true, when: d => d.status === 'win' || d.status === 'loss' },
      { key: 'rr', ask: 'Risk/Reward in R? (Skip = keep current)', type: 'number', optional: true },
      { key: 'lotSize', ask: 'Lot size? (Skip = keep current)', type: 'number', optional: true },
      { key: 'psychology', ask: 'Psychology? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Good', 'good'], ['Normal', 'normal'], ['Bad', 'bad']] },
      { key: 'followedPlan', ask: 'Did you follow your plan? (Skip = keep current)', type: 'choice', optional: true, options: () => [['Yes', 'yes'], ['No', 'no']] },
      { key: 'notes', ask: '📝 Notes? (Skip = keep current)', type: 'text', optional: true },
      { key: 'images', ask: '📷 Add as many new screenshots as you need, one by one. Press Done when finished. (Skip = keep current)', type: 'photos', optional: true },
      { key: 'cover', ask: '⭐ Which picture should be shown first (in front)? Numbered in order: the old pictures first, then the new ones.', type: 'choice', perRow: 4,
        when: d => allTradeImages(d).length > 1, options: d => coverOptions(allTradeImages(d).length) }
    ],
    done: async (ctx, d) => {
      const rec = db.trades.find(t => t.id === d.id);
      if (!rec) return showMenu(ctx, '⚠️ Trade no longer exists.');
      const merged = { ...rec, ...d, modelId: d.modelId === 'none' ? '' : (d.modelId ?? rec.modelId), accountId: d.accountId ?? rec.accountId, createdAt: d.tradeDate ?? rec.createdAt };
      delete merged.images;
      const f = tradeFields(merged);
      if (!f) return showMenu(ctx, '⚠️ Invalid trade data. Nothing was changed.');
      Object.assign(rec, f);
      await localizeNotes(rec);
      if (d.images !== undefined && d.images.length) { rec.images = (rec.images || []).concat(d.images); }
      rec.images = moveCoverFirst(rec.images || [], d.cover);
      sortTrades();
      save();
      await showMenu(ctx, `✅ Trade updated: ${rec.symbol} ${String(rec.side).toUpperCase()}`);
    }
  }
};

function parseBotDate(value) {
  const v = String(value || '').trim();
  const pad = n => String(n).padStart(2, '0');
  const eat = ms => {                       // Ethiopia clock (UTC+3) as text
    const d = new Date(ms + 3 * 3600e3);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+03:00`;
  };
  let iso = '';
  if (/^today$/i.test(v)) iso = eat(Date.now());
  else if (/^yesterday$/i.test(v)) iso = eat(Date.now() - 86400000);
  else {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::(\d{2}))?)?$/.exec(v);
    if (m) {
      const hh = String(Number(m[4] || 0)).padStart(2,'0');
      const mm = String(Number(m[5] || 0)).padStart(2,'0');
      iso = `${m[1]}-${m[2]}-${m[3]}T${hh}:${mm}:00+03:00`;
    }
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

const currentSteps = () => FLOWS[flow.name].steps;
// edit-trade form: the trade's saved pictures followed by the ones just sent
const allTradeImages = d => ((db.trades.find(t => t.id === d.id) || {}).images || []).concat(d.images || []);

// several answers at once (tap to select / unselect, then Done) - used to log one trade on many accounts
function multiKeyboard(step, kb) {
  const picked = flow.data[step.key] || [];
  step.options(flow.data).forEach(([label, value]) => {
    kb.text((picked.includes(value) ? '✅ ' : '⬜ ') + label, 'f:' + value).row();
  });
  kb.text('☑️ All', 'f:__all').text(`✅ Done (${picked.length})`, 'f:__done').row();
}

// puts the picture the person chose first (the first picture is the one shown in front)
function moveCoverFirst(list, cover) {
  const i = Number(cover);
  if (cover === undefined || cover === 'keep' || !Number.isInteger(i) || i <= 0 || i >= list.length) return list;
  const out = list.slice();
  out.unshift(out.splice(i, 1)[0]);
  return out;
}
const coverOptions = total => Array.from({ length: total }, (_, i) => [String(i + 1), String(i)]).concat([['Keep order', 'keep']]);

// copies picture files so every trade owns its own files (deleting one trade must not delete the others' pictures)
async function copyImages(urls) {
  const out = [];
  for (const u of urls || []) {
    const name = String(u).replace('/uploads/', '');
    const found = await store.getWithMetadata('img/' + name, { type: 'arrayBuffer' });
    if (!found) continue;
    const ext = (name.match(/\.(jpg|png|webp|gif)$/) || ['.jpg'])[0];
    const copy = randomName(ext);
    pendingWrites.push({ name: copy, type: (found.metadata && found.metadata.contentType) || 'image/jpeg', data: found.data });
    out.push('/uploads/' + copy);
  }
  return out;
}

async function askStep(ctx) {
  const step = currentSteps()[flow.i];
  const kb = new InlineKeyboard();
  if (step.type === 'choice') {
    const per = step.perRow || 2;
    step.options(flow.data).forEach(([label, value], n) => {
      kb.text(label, 'f:' + value);
      if (n % per === per - 1) kb.row();
    });
    kb.row();
  }
  if (step.type === 'multichoice') multiKeyboard(step, kb);
  if (step.type === 'photos') kb.text('✅ Done', 'f:__done');
  else if (step.optional) kb.text('⏭ Skip', 'f:__skip');
  kb.text('✖ Cancel', 'cancel');
  await ctx.reply(step.ask, { reply_markup: kb });
}

async function advance(ctx) {
  flow.i++;
  const steps = currentSteps();
  while (flow.i < steps.length && steps[flow.i].when && !steps[flow.i].when(flow.data)) flow.i++;
  if (flow.i >= steps.length) {
    const finished = flow;
    flow = null;
    try { await FLOWS[finished.name].done(ctx, finished.data); }
    catch (e) { console.error(e); await ctx.reply('⚠️ Error: ' + e.message); }
    return;
  }
  await askStep(ctx);
}

async function startFlow(ctx, name) {
  const def = FLOWS[name];
  const problem = def.check && def.check();
  if (problem) return showMenu(ctx, problem);
  cancelFlow();
  flow = { name, i: -1, data: {} };
  await advance(ctx);
}

function cancelFlow() {
  if (flow) {
    Object.values(flow.data).forEach(v => { if (Array.isArray(v)) v.forEach(removeFile); });
    flow = null;
  }
}

async function savePhoto(ctx) {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const file = await ctx.api.getFile(photo.file_id);
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error('Could not download the picture from Telegram');
  const name = randomName('.jpg');
  pendingWrites.push({ name, type: 'image/jpeg', data: await res.arrayBuffer() });
  return '/uploads/' + name;
}

/* ---------- lists ---------- */
async function listAccounts(ctx) {
  if (!db.accounts.length) return showMenu(ctx, 'No accounts yet.');
  const kb = new InlineKeyboard();
  const lines = db.accounts.map(a => {
    kb.text('✏️ Edit ' + a.name, `edit:accounts:${a.id}`).text('🗑', `del:accounts:${a.id}`).row();
    return `🏦 ${a.name} (${a.type})\n   ${money(a.startingBalance)} → ${money(a.startingBalance + accountPnl(a.id))}`;
  });
  kb.text('⬅ Menu', 'menu');
  await ctx.reply(lines.join('\n\n'), { reply_markup: kb });
}

async function listModels(ctx) {
  if (!db.models.length) return showMenu(ctx, 'No models yet.');
  const kb = new InlineKeyboard();
  const lines = db.models.map(m => {
    kb.text((m.active === false ? '▶ Enable ' : '⏸ Disable ') + m.name, `tog:models:${m.id}`)
      .text('✏️ Edit', `edit:models:${m.id}`).text('🗑', `del:models:${m.id}`).row();
    return `🧠 ${m.name} – ${m.symbols} ${m.timeframe} ${m.active === false ? '(disabled)' : ''}`;
  });
  kb.text('⬅ Menu', 'menu');
  await ctx.reply(lines.join('\n'), { reply_markup: kb });
}

async function listPairs(ctx) {
  if (!db.pairs.length) return showMenu(ctx, 'No pairs yet.');
  const kb = new InlineKeyboard();
  const lines = db.pairs.map(p => {
    kb.text((p.trading ? '✅ ' : '⬜ ') + p.symbol, `trd:${p.id}`).text('🗑', `del:pairs:${p.id}`).row();
    return `${p.trading ? '🎯' : '▫️'} ${p.symbol}: buy ${p.buyPercent}% / sell ${p.sellPercent}%`
      + (p.fundamental ? `\n   📰 ${p.fundamental}` : '') + (p.technical ? `\n   📈 ${p.technical}` : '');
  });
  kb.text('🧹 Clear all pairs', 'clearpairs').text('⬅ Menu', 'menu');
  await ctx.reply('🎯 = you will trade it this week (tap the pair to change)\n\n' + lines.join('\n'),
    { reply_markup: kb });
}

async function listTrades(ctx) {
  if (!db.trades.length) return showMenu(ctx, 'No trades yet.');
  const icon = { win: '✅', loss: '❌', be: '➖', open: '⏳' };
  const all = db.trades.slice().sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const blocks = [];
  let textBlock = '';
  let kb = new InlineKeyboard();
  all.forEach((t, i) => {
    const acc = db.accounts.find(a => a.id === t.accountId);
    const line = `${i + 1}. ${t.symbol} ${String(t.side || '').toUpperCase()} ${icon[t.status] || ''} `
      + `${typeof t.pnl === 'number' ? money(t.pnl) : ''} · ${acc ? acc.name : '?'} · ${String(t.createdAt || '').slice(0, 10)}`;
    if ((textBlock + line + '\n').length > 3400) {
      blocks.push({ text: textBlock.trim(), kb });
      textBlock = '';
      kb = new InlineKeyboard();
    }
    textBlock += line + '\n';
    kb.text('✏️ ' + (i + 1), `edit:trades:${t.id}`).text('🗑', `del:trades:${t.id}`).row();
  });
  if (textBlock.trim()) blocks.push({ text: textBlock.trim(), kb });
  for (let i = 0; i < blocks.length; i++) {
    blocks[i].kb.text('⬅ Menu', 'menu');
    await ctx.reply(`All trades (${all.length}) · ${i + 1}/${blocks.length}\n\n` + blocks[i].text, { reply_markup: blocks[i].kb });
  }
}

/* ---------- subscribers & payments ---------- */
const STATE_ICON = { active: '✅', expired: '⌛', pending: '⏳', blocked: '⛔' };
const userLine = u => {
  const st = accessState(u);
  return `${STATE_ICON[st]} ${u.name} · ${u.email} · ${st === 'active' ? 'until ' + dateOf(u.expiresAt) : st}`;
};

async function listUsers(ctx) {
  const users = db.users.filter(u => !u.owner);
  if (!users.length) return showMenu(ctx, 'No subscribers yet. People can sign up on your website.');
  const kb = new InlineKeyboard();
  const shown = users.slice(-20).reverse();
  const lines = shown.map((u, i) => {
    kb.text(('⚙ ' + u.name).slice(0, 28), `usr:open:${u.id}`);
    if (i % 2 === 1) kb.row();
    return userLine(u);
  });
  kb.row().text('⬅ Menu', 'menu');
  await ctx.reply(`👥 Subscribers (${users.length})\n\n` + lines.join('\n'), { reply_markup: kb });
}

async function showUser(ctx, id) {
  const u = db.users.find(x => x.id === id);
  if (!u) return showMenu(ctx, 'Subscriber not found.');
  const kb = new InlineKeyboard()
    .text('➕ 30 days', `usr:ext:${u.id}:30`).text('➕ 90 days', `usr:ext:${u.id}:90`)
    .text('➕ 365 days', `usr:ext:${u.id}:365`).row()
    .text(u.blocked ? '✅ Unblock' : '⛔ Block', `usr:blk:${u.id}`).text('🗑 Delete', `del:users:${u.id}`).row()
    .text('⬅ Subscribers', 'list:users');
  await ctx.reply(`${userLine(u)}\n${u.contact ? 'Contact: ' + u.contact + '\n' : ''}`
    + `Plan: ${u.plan || '-'}\nJoined: ${u.createdAt.slice(0, 10)}`, { reply_markup: kb });
}

async function listPayments(ctx) {
  const pending = db.payments.filter(p => p.status === 'pending');
  if (!pending.length) return showMenu(ctx, 'No pending payment requests.');
  for (const p of pending.slice(0, 10)) {
    const u = db.users.find(x => x.id === p.userId);
    const plan = db.plans.find(x => x.id === p.planId);
    await ctx.reply(`💳 ${u ? u.name + ' (' + u.email + ')' : '?'}\nPlan: ${plan ? plan.name + ' – ' + plan.days + ' days ' + (plan.price || '') : '?'}\nReference: ${p.reference}`,
      { reply_markup: new InlineKeyboard().text('✅ Approve', 'pay:ok:' + p.id).text('❌ Reject', 'pay:no:' + p.id) });
  }
}

const planStatus = u => {
  const st = accessState(u);
  return st === 'active' ? `${u.trial ? '🆓 Free trial' : '✅ ' + (u.plan || 'Active')} – until ${dateOf(u.expiresAt)}` : st === 'blocked' ? '⛔ Blocked' : '⏳ No active plan';
};
const plansText = (forMember = false) => '💳 Plans:\n'
  + (db.plans.map((p, i) => `${i + 1}. ${p.name} – ${p.days} days${p.price ? ' – ' + p.price : ''}`).join('\n') || '(none)')
  + '\n\nHow to pay:\n' + (db.payInfo || '(not set)')
  + (forMember ? '' : '\n\n✏️ /editplans – change prices, names, services text and free-trial days with buttons\n/setprice 2 4000 – quick price change for plan 2\n/addplan Monthly | 30 | 500 ETB\n/delplan 1\n/payinfo your payment instructions\n/grant email@x.com 30\n/gift 12 – make a 12-month promo code (see /gift)');

/* ---------- PLANS & PRICES EDITOR (owner, in the bot) ----------
   Everything the website shows on the Plans page can be changed here: plan names, prices, days,
   a short note per plan, the "included services" list, the free-trial length, the highlighted plan
   and the payment text. The website reads it live (/api/plans), so no deploy is needed.        */
const planNo = id => db.plans.findIndex(p => p.id === id) + 1;
function setPlanPrice(p, amount) {
  p.amount = amount; p.price = money0(amount) + ' ETB';
  if (!p.months) p.months = Math.max(1, Math.round(p.days / 30));
}
const recLabel = () => {
  if (db.recommended === 'none') return 'none';
  const p = db.plans.find(x => x.id === db.recommended) || db.plans[2];
  return p ? p.name : 'none';
};
const editorHomeText = () => '💳 Plans & prices (what your website shows)\n\n'
  + (db.plans.map((p, i) => `${i + 1}. ${p.name} – ${p.days} days – ${p.price || '(no price)'}${p.note ? '  “' + p.note + '”' : ''}`).join('\n') || '(no plans)')
  + `\n\n⭐ Highlighted: ${recLabel()}\n🆓 Free trial: ${trialDays()} days\n✨ Services listed: ${featureList().length}\n💬 How to pay: ${db.payInfo ? 'set' : '(not set)'}\n\nTap a plan to change its price, name, days or note.`;
function editorHomeKb() {
  const kb = new InlineKeyboard();
  db.plans.forEach((p, i) => kb.text(`✏️ ${i + 1}. ${p.name}`, 'pl:p:' + p.id).row());
  return kb.text('➕ New plan', 'pl:new').text('✨ Services text', 'pl:svc').row()
    .text('🆓 Free trial days', 'pl:trial').text('💬 How to pay', 'pl:pay').row()
    .text('⬅ Menu', 'menu');
}
const planDetailText = p => `✏️ ${p.name}\n\n💰 Price: ${p.price || '(none)'}${p.amount && p.months > 1 ? `  (${money0(Math.round(p.amount / p.months))} ETB / month)` : ''}\n📅 Days of access: ${p.days}\n📝 Note under the name: ${p.note || '(none)'}\n⭐ ${db.recommended === p.id || (!db.recommended && db.plans[2] && db.plans[2].id === p.id) ? 'This plan is highlighted' : 'Not highlighted'}`;
function planDetailKb(p) {
  const hot = db.recommended === p.id || (!db.recommended && db.plans[2] && db.plans[2].id === p.id);
  return new InlineKeyboard()
    .text('💰 Price', `pl:ed:${p.id}:price`).text('🏷 Name', `pl:ed:${p.id}:name`).row()
    .text('📅 Days', `pl:ed:${p.id}:days`).text('📝 Note', `pl:ed:${p.id}:note`).row()
    .text(hot ? '⭐ Remove highlight' : '⭐ Highlight this plan', 'pl:rec:' + p.id).row()
    .text('🗑 Delete plan', 'pl:del:' + p.id).text('⬅ Back', 'pl:home');
}
const svcText = () => '✨ Services shown on every plan (website Plans page)\n\n'
  + (featureList().map((f, i) => `${i + 1}. ${f}`).join('\n') || '(none)')
  + '\n\nTip: you can write English and Amharic in one line, e.g.  Private journal · የግል ጆርናል';
function svcKb() {
  const kb = new InlineKeyboard();
  featureList().slice(0, 16).forEach((_, i) => { kb.text(`✏️ ${i + 1}`, 'pl:s:' + (i + 1)); if ((i + 1) % 4 === 0) kb.row(); });
  kb.row().text('➕ Add one', 'pl:sadd').text('📝 Replace all', 'pl:sall').row().text('↩ Back to default list', 'pl:sdef').row().text('⬅ Back', 'pl:home');
  return kb;
}
const cancelKb = () => new InlineKeyboard().text('✖ Cancel', 'pl:cancel');
const editPrompts = {
  price: p => `💰 New price for “${p.name}”, in ETB for the whole plan.\nExample: 4000`,
  name: p => `🏷 New name for this plan (now “${p.name}”).\nExample: 3 Months`,
  days: p => `📅 How many days of access does “${p.name}” give? (now ${p.days})\nExample: 90`,
  note: p => `📝 A short note shown under the plan name (now: ${p.note || 'none'}).\nExample: Best value\nSend - to remove the note.`,
};

async function plShow(ctx, text, kb) {
  if (ctx.callbackQuery) { try { return await ctx.editMessageText(text, { reply_markup: kb }); } catch (e) { /* same text or too old: send a new message */ } }
  return ctx.reply(text, { reply_markup: kb });
}
const plAsk = async (ctx, edit, prompt) => { db.edit = edit; save(); await ctx.reply(prompt, { reply_markup: cancelKb() }); };

async function plansCallback(ctx, action, id, extra) {
  const plan = () => db.plans.find(p => p.id === id);
  switch (action) {
    case 'home': db.edit = null; save(); return plShow(ctx, editorHomeText(), editorHomeKb());
    case 'cancel': db.edit = null; save(); return plShow(ctx, editorHomeText(), editorHomeKb());
    case 'p': { const p = plan(); if (!p) return plShow(ctx, editorHomeText(), editorHomeKb()); return plShow(ctx, planDetailText(p), planDetailKb(p)); }
    case 'ed': { const p = plan(); if (!p || !editPrompts[extra]) return; return plAsk(ctx, { k: extra, id }, editPrompts[extra](p)); }
    case 'rec': {
      const p = plan(); if (!p) return;
      const hot = db.recommended === p.id || (!db.recommended && db.plans[2] && db.plans[2].id === p.id);
      db.recommended = hot ? 'none' : p.id; save();
      return plShow(ctx, planDetailText(p), planDetailKb(p));
    }
    case 'del': {
      const p = plan(); if (!p) return;
      if (db.plans.length <= 1) return ctx.reply('Keep at least one plan.');
      return plShow(ctx, `🗑 Delete “${p.name}”? People who already paid keep their access.`, new InlineKeyboard().text('✅ Yes, delete', 'pl:delok:' + p.id).text('✖ No', 'pl:p:' + p.id));
    }
    case 'delok': {
      if (db.plans.length <= 1) return ctx.reply('Keep at least one plan.');
      db.plans = db.plans.filter(p => p.id !== id); if (db.recommended === id) db.recommended = ''; save();
      return plShow(ctx, '🗑 Plan removed.\n\n' + editorHomeText(), editorHomeKb());
    }
    case 'new': return plAsk(ctx, { k: 'newplan' }, '➕ Send the new plan like this:\nname | days | price in ETB\n\nExample:\n2 Months | 60 | 3000');
    case 'trial': return plAsk(ctx, { k: 'trial' }, `🆓 How many free-trial days should every new sign-up get? (now ${trialDays()})\nSend a number from 1 to 90.`);
    case 'pay': return plAsk(ctx, { k: 'pay' }, '💬 Current “how to pay” text:\n' + (db.payInfo || '(not set)') + '\n\nSend the new text (for example: Telebirr 09xxxxxxxx (Name). Send the reference number after paying.)');
    case 'svc': db.edit = null; return plShow(ctx, svcText(), svcKb());
    case 'sadd': return plAsk(ctx, { k: 'svcadd' }, '➕ Send the new service line.\nExample: Priority support · ቅድሚያ ድጋፍ');
    case 'sall': return plAsk(ctx, { k: 'svcall' }, '📝 Send ALL services, one per line (max 12). This replaces the whole list.\n\nCurrent list:\n' + featureList().join('\n'));
    case 'sdef': db.features = null; db.edit = null; save(); return plShow(ctx, '↩ Back to the default list.\n\n' + svcText(), svcKb());
    case 's': {
      const n = Number(id), f = featureList()[n - 1]; if (!f) return plShow(ctx, svcText(), svcKb());
      return plShow(ctx, `✨ Service ${n}:\n${f}`, new InlineKeyboard().text('✏️ Change text', 'pl:sed:' + n).text('⬆ Move up', 'pl:sup:' + n).row().text('🗑 Delete', 'pl:sdel:' + n).text('⬅ Back', 'pl:svc'));
    }
    case 'sed': { const n = Number(id), f = featureList()[n - 1]; if (!f) return; return plAsk(ctx, { k: 'svcedit', n }, `✏️ Send the new text for service ${n} (now: ${f})`); }
    case 'sup': {
      const n = Number(id), list = featureList().slice(); if (!list[n - 1] || n < 2) return plShow(ctx, svcText(), svcKb());
      [list[n - 2], list[n - 1]] = [list[n - 1], list[n - 2]]; db.features = list; save();
      return plShow(ctx, svcText(), svcKb());
    }
    case 'sdel': { const n = Number(id), list = featureList().slice(); if (!list[n - 1]) return; list.splice(n - 1, 1); db.features = list; save(); return plShow(ctx, svcText(), svcKb()); }
  }
}

// The owner's next text message after tapping an edit button.
async function plansHandleText(ctx) {
  const e = db.edit, value = ctx.message.text.trim();
  const p = e.id ? db.plans.find(x => x.id === e.id) : null;
  const again = msg => ctx.reply(msg + '\n\n(or tap Cancel)', { reply_markup: cancelKb() });
  const done = async (note, text, kb) => { db.edit = null; save(); await ctx.reply('✅ ' + note); return ctx.reply(text, { reply_markup: kb }); };
  const num = v => Number(String(v).replace(/etb/ig, '').replace(/[,\s]/g, ''));
  if (['price', 'name', 'days', 'note'].includes(e.k) && !p) { db.edit = null; save(); return ctx.reply('That plan no longer exists.', { reply_markup: editorHomeKb() }); }
  switch (e.k) {
    case 'price': {
      const n = num(value);
      if (!Number.isFinite(n) || n < 0 || n > 10000000) return again('Please send a number, for example 4000.');
      setPlanPrice(p, Math.round(n)); return done(`Price set to ${p.price}.`, planDetailText(p), planDetailKb(p));
    }
    case 'name': {
      if (!value || value.length > 40) return again('Please send a name of 1–40 characters.');
      p.name = value; return done('Name saved.', planDetailText(p), planDetailKb(p));
    }
    case 'days': {
      const n = Math.round(num(value));
      if (!(n >= 1 && n <= 3650)) return again('Please send a number of days from 1 to 3650.');
      p.days = n; p.months = Math.max(1, Math.round(n / 30)); if (p.amount) p.price = money0(p.amount) + ' ETB';
      db.plans.sort((a, b) => a.days - b.days);
      return done(`Now ${n} days.`, planDetailText(p), planDetailKb(p));
    }
    case 'note': {
      if (value.length > 60) return again('Please keep the note under 60 characters.');
      p.note = value === '-' ? '' : value; return done(p.note ? 'Note saved.' : 'Note removed.', planDetailText(p), planDetailKb(p));
    }
    case 'newplan': {
      const [name, d, pr] = value.split('|').map(x => x.trim());
      const days = Math.round(num(d)), amount = pr ? Math.round(num(pr)) : NaN;
      if (!name || name.length > 40 || !(days >= 1 && days <= 3650) || !Number.isFinite(amount) || amount < 0) return again('Send it like this:\nname | days | price in ETB\nExample: 2 Months | 60 | 3000');
      const np = { id: newId(), name, days, months: Math.max(1, Math.round(days / 30)) }; setPlanPrice(np, amount);
      db.plans.push(np); db.plans.sort((a, b) => a.days - b.days);
      return done('Plan added.', editorHomeText(), editorHomeKb());
    }
    case 'trial': {
      const n = Math.round(num(value));
      if (!(n >= 1 && n <= 90)) return again('Please send a number from 1 to 90.');
      db.trialDays = n; return done(`Free trial is now ${n} days (new sign-ups only).`, editorHomeText(), editorHomeKb());
    }
    case 'pay': {
      if (!value) return again('Please send the text.');
      db.payInfo = value.slice(0, 1000); return done('“How to pay” saved.', editorHomeText(), editorHomeKb());
    }
    case 'svcadd': {
      if (!value || value.length > 120) return again('Please send one line of up to 120 characters.');
      if (featureList().length >= 12) return again('You already have 12 services. Remove one first.');
      db.features = featureList().concat(value); return done('Service added.', svcText(), svcKb());
    }
    case 'svcedit': {
      if (!value || value.length > 120) return again('Please send one line of up to 120 characters.');
      const list = featureList().slice(); if (!list[e.n - 1]) { db.edit = null; save(); return ctx.reply(svcText(), { reply_markup: svcKb() }); }
      list[e.n - 1] = value; db.features = list; return done('Service updated.', svcText(), svcKb());
    }
    case 'svcall': {
      const lines = value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!lines.length || lines.length > 12 || lines.some(x => x.length > 120)) return again('Send 1–12 lines, each up to 120 characters.');
      db.features = lines; return done(`${lines.length} services saved.`, svcText(), svcKb());
    }
  }
  db.edit = null; save();
  return ctx.reply('Cancelled.', { reply_markup: editorHomeKb() });
}

/* ---------- promo / gift codes ---------- */
const promoHelp = () => '🎁 Make a promo (gift) code. The person sends it to the bot (/promo CODE) or types it in the website sign-up box, and gets free access.\n\n'
  + '/gift 12 – 12 months, one person\n/gift 3 5 – 3 months, 5 people can use it\n/gift 7d – 7 days\n/gift 12 1 Abebe – any text after is your note\n\n/gifts – see all codes';

async function sendPromo(ctx, p) {
  await ctx.reply(`🎁 Promo code ready\n\n${p.code}\n\n${promoLabel(p)} free · ${p.maxUses === 1 ? '1 person' : p.maxUses + ' people'}${p.note ? '\nNote: ' + p.note : ''}\n\n`
    + 'Give it to your friend. They send the bot /promo CODE, or type it in the "Promo code" box on the website sign-up page.',
    { reply_markup: new InlineKeyboard().text('🎟 All codes', 'promo:list').text('⬅ Menu', 'menu') });
}

async function listPromos(ctx) {
  const list = (db.promos || []).slice(-15).reverse();
  if (!list.length) return ctx.reply('No promo codes yet.\n\n' + promoHelp());
  const kb = new InlineKeyboard();
  const lines = list.map(p => {
    const st = p.revoked ? '⛔ cancelled' : p.used.length >= p.maxUses ? '✔ used' : '🟢 ready';
    kb.text(`${p.revoked ? '↩ Restore' : '⛔ Cancel'} ${p.code.slice(3)}`, `promo:rev:${p.id}`).row();
    return `${p.code} · ${promoLabel(p)} · ${p.used.length}/${p.maxUses} used · ${st}${p.note ? ' · ' + p.note : ''}`;
  });
  kb.text('➕ New code', 'promo:new').text('⬅ Menu', 'menu');
  await ctx.reply('🎟 Promo codes (newest first)\n\n' + lines.join('\n'), { reply_markup: kb });
}

/* ---------- Monday reminder ---------- */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localTime = ms => new Date(ms + db.reminder.utcOffset * 3600e3);   // read with getUTC...()
const normPair = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const biasOf = p => (p.buyPercent >= 60 ? '🟢 BUY bias' : p.buyPercent <= 40 ? '🔴 SELL bias' : '⚪ Balanced – wait for confirmation');

function chunkText(block) {
  const out = [];
  let cur = '';
  for (const line of block.split('\n')) {
    if ((cur + line).length > 3800) { out.push(cur); cur = ''; }
    cur += line + '\n';
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function buildPlan() {
  const today = localTime(Date.now()).toISOString().slice(0, 10);
  const wish = '🍀 መልካም የትሬድ ሳምንት ይሁንልህ! Have a great trade week!';
  if (!db.pairs.length) {
    return [`📅 Monday plan – ${today}\n\nYou have not added any analysis for this week yet. `
      + `Add your pairs with ➕ Pair and mark the ones you will trade.\n\n${wish}`];
  }
  const marked = db.pairs.filter(p => p.trading);
  const list = marked.length ? marked : db.pairs;
  const updatedMs = db.pairsUpdatedAt ? Date.parse(db.pairsUpdatedAt) : 0;
  const upd = localTime(updatedMs || Date.now());
  const updText = `${DAYS[upd.getUTCDay()]} ${upd.toISOString().slice(0, 10)}`;
  const stale = !updatedMs || (Date.now() - updatedMs) / 864e5 > 4;

  const lines = [`📅 Monday plan – week of ${today}`];
  lines.push(stale
    ? `⚠️ Your analysis was last updated ${updText}. It was not refreshed this weekend – check it before trading.`
    : `Your weekend analysis (${updText}).`);
  lines.push('');
  lines.push(marked.length
    ? '🎯 Pairs you said you will trade this week:'
    : 'You did not mark which pairs you will trade, so here is all your analysis:');
  lines.push('');
  list.forEach((p, i) => {
    const models = db.models.filter(m => m.active !== false && normPair(m.symbols).includes(normPair(p.symbol)))
      .map(m => m.name);
    lines.push(`${i + 1}. ${p.symbol}`);
    lines.push(`   ${biasOf(p)} – ${p.buyPercent}% buy / ${p.sellPercent}% sell`);
    if (p.fundamental) lines.push(`   📝 Your note: ${p.fundamental}`);
    if (p.technical) lines.push(`   🧩 Your technical note: ${p.technical}`);
    if (p.autoSummary) lines.push(`   🧭 ${p.autoSummary}`);
    if (p.autoFundamental) lines.push(`   📰 Auto fundamental: ${p.autoFundamental}`);
    if (p.autoTechnical) lines.push(`   📈 Auto technical: ${p.autoTechnical}`);
    if (p.autoSources && p.autoSources.length) lines.push(`   🔎 Sources: ${p.autoSources.join(' · ')}`);
    if (models.length) lines.push(`   🧠 Model: ${models.join(', ')}`);
    lines.push('');
  });
  lines.push(wish);
  return chunkText(lines.join('\n'));
}

async function sendPlan(chatId = OWNER_ID) {
  const parts = buildPlan();
  for (let i = 0; i < parts.length; i++) {
    await getBot().api.sendMessage(chatId, parts[i],
      i === parts.length - 1 ? { reply_markup: menuKb() } : undefined);
  }
}

/* Called every hour by monday.mjs; sends the plan once, on Monday, after the chosen hour. */
export function runReminder() {
  return serial(async () => {
    if (!BOT_TOKEN || !OWNER_ID) return 'not configured';
    await acquireWriteLock();
    try {
    await loadState();
    try {
      const r = db.reminder;
      const now = localTime(Date.now());
      const today = now.toISOString().slice(0, 10);
      if (!r.enabled || now.getUTCDay() !== 1 || now.getUTCHours() < r.hour) return 'not due';
      let sent = 0;
      if (r.lastSent !== today) {                          // the owner's own plan
        await refreshPairAnalyses(false);
        await sendPlan();
        r.lastSent = today; save(); sent++;
      }
      // every active member gets THEIR OWN plan (their analysis). 25 per run; the next hourly run continues.
      for (const u of db.users) {
        if (sent >= 25) break;
        const ud = (db.userData || {})[u.id];
        if (u.owner || !u.tgId || u.blocked || accessState(u) !== 'active' || !ud || !ud.pairs.length || ud.planSent === today) continue;
        enterScope(u.id);
        try { await sendPlan(u.tgId); } catch (e) { console.error('member plan failed', u.id, e.description || e.message); }
        finally { leaveScope(); }
        ud.planSent = today; save(); sent++;
      }
      return sent ? 'sent' : 'not due';
    } finally {
      await flushState().catch(e => console.error('Saving failed:', e));
    }
    } finally {
      await releaseWriteLock().catch(() => {});
    }
  });
}

/* ---------- build the bot (once per warm start) ---------- */
function getBot() {
  if (bot) return bot;
  bot = new Bot(BOT_TOKEN);

  // The owner has the full bot. Everybody else is a MEMBER: they get their own journal (their own
  // accounts, models, trades and analysis) and nothing of the owner's tools.
  const MEMBER_COMMANDS = ['start', 'menu', 'cancel', 'plans', 'promo', 'login', 'plan'];
  const MEMBER_LISTS = ['trades', 'accounts', 'models', 'pairs'];
  const memberCallbackOk = data => {
    if (data.startsWith('f:')) return true;
    const [kind, coll] = data.split(':');
    if (['menu', 'cancel', 'edit', 'tog', 'trd', 'clearpairs', 'clearok', 'myplan'].includes(kind)) return true;
    if (kind === 'new' || kind === 'list' || kind === 'del' || kind === 'delok') return MEMBER_LISTS.includes(coll) || (kind === 'new' && ['trade', 'account', 'model', 'pair'].includes(coll));
    return false;
  };

  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (ctx.from.id === OWNER_ID) { ctx.isOwner = true; return next(); }
    if (!ctx.chat || ctx.chat.type !== 'private') return;
    const text0 = ctx.message && ctx.message.text ? ctx.message.text : '';
    const payload = (/^\/start(?:@\w+)?\s+(\S+)/.exec(text0) || [])[1] || '';
    const { user } = await memberFromTelegram(ctx.from, payload);
    ctx.member = user;
    const cmd = (/^\/(\w+)/.exec(text0) || [])[1];
    const state = accessState(user);
    if (state === 'blocked') return ctx.reply('⛔ Your account is blocked. Please contact the owner.');
    if (state !== 'active') {                                   // trial / subscription finished: only pay or use a code
      if (cmd === 'promo' || cmd === 'login') return next();
      return ctx.reply((user.plan === 'Free trial' || user.trial ? '⏳ Your free trial has ended.' : '⏳ Your subscription has ended.')
        + '\n\n' + plansText(true) + '\n\nOpen the app to pay and send your payment reference, or use a promo code:\n/promo YOUR-CODE',
        { reply_markup: isHttps(siteUrl()) ? new InlineKeyboard().webApp('💳 Open app to pay', siteUrl().replace(/\/$/, '') + '/') : undefined });
    }
    if (ctx.callbackQuery) { if (!memberCallbackOk(ctx.callbackQuery.data || '')) return ctx.answerCallbackQuery().catch(() => {}); }
    else if (cmd && !MEMBER_COMMANDS.includes(cmd)) return ctx.reply('This command is only for the owner. Use /menu.');
    flowKey = 'flow-' + user.id;
    flow = (await store.get(flowKey, { type: 'json' })) || null;
    enterScope(user.id);
    return next();
  });

  bot.command(['start', 'menu'], ctx => showMenu(ctx, ctx.member
    ? `👋 ${ctx.member.name}\n${planStatus(ctx.member)}\n\nYour journal is private: only you see your accounts, models, trades and analysis.`
    : undefined));
  bot.command('panel', async ctx => {
    if (!isHttps(siteUrl())) return ctx.reply('⚠️ The control panel is not configured yet. Open /api/setup first.');
    return ctx.reply('⚙️ Super Admin Control Panel', { reply_markup: new InlineKeyboard().webApp('⚙️ Control Panel', controlPanelUrl()) });
  });
  bot.command('cancel', async ctx => { cancelFlow(); if (ctx.isOwner && db.edit) { db.edit = null; save(); } await showMenu(ctx, 'Cancelled.'); });

  // The owner's own login for the website in Chrome (no subscription needed, look-only)
  bot.command('password', async ctx => {
    const args = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().split(/\s+/);
    const email = (args[0] || '').toLowerCase();
    const pw = args.slice(1).join(' ');
    if (!EMAIL_RE.test(email) || pw.length < 8) {
      return ctx.reply('Send it like this:\n/password you@email.com YourSecretPassword\n(password at least 8 characters)');
    }
    let owner = db.users.find(x => x.owner);
    const same = db.users.find(x => x.email === email);
    if (same && owner && same !== owner) return ctx.reply('That email is already used by a subscriber. Use another one.');
    if (!owner) owner = same;
    if (!owner) {
      owner = { id: newId(), name: 'Owner', contact: '', createdAt: new Date().toISOString(), expiresAt: 0,
        plan: '', blocked: false };
      db.users.push(owner);
    }
    Object.assign(owner, { email, owner: true, blocked: false, pass: hashPassword(pw) });
    save();
    await ctx.deleteMessage().catch(() => {});
    await ctx.reply('✅ Your website login is saved (I deleted your message). Sign in on the website with that email and password.');
  });

  // Subscription settings
  bot.command('plans', ctx => ctx.reply(plansText(!ctx.isOwner)));

  // A member's own weekly plan, any time (the bot also sends it every Monday)
  bot.command('plan', async ctx => {
    if (ctx.isOwner) return ctx.reply('Use /refreshplan');
    if (!db.pairs.length) return ctx.reply('Add your analysis first (➕ Analysis in /menu).');
    await sendPlan(ctx.from.id);
  });

  // Link this Telegram to a website account:  /login you@mail.com Password
  // (the message is deleted right away). After that the bot and the website are ONE account.
  bot.command('login', async ctx => {
    if (ctx.isOwner) return ctx.reply('You are the owner. Use /password to set your own website login.');
    const args = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().split(/\s+/);
    const email = (args[0] || '').toLowerCase(), pw = args.slice(1).join(' ');
    await ctx.deleteMessage().catch(() => {});
    if (!EMAIL_RE.test(email) || !pw) return ctx.reply('Send it like this:\n/login you@email.com YourPassword\n(I delete your message right away.)');
    const now = Date.now();
    clearOldLoginAttempts(now);
    const key = loginKey({ headers: new Headers() }, 'tglink:' + ctx.from.id);
    const rec = db.loginAttempts[key] || { fails: 0, windowUntil: now + 15 * 60000, lockedUntil: 0 };
    if (Number(rec.lockedUntil) > now) return ctx.reply('Too many tries. Wait a few minutes.');
    const web = db.users.find(u => u.email === email && !u.owner);
    if (!web || !checkPassword(pw, web.pass)) {
      rec.fails = Number(rec.fails || 0) + 1; rec.windowUntil = now + 15 * 60000;
      if (rec.fails >= 5) rec.lockedUntil = now + 15 * 60000;
      db.loginAttempts[key] = rec; save();
      return ctx.reply('⚠️ Wrong email or password.');
    }
    delete db.loginAttempts[key];
    if (web.tgId && web.tgId !== ctx.from.id) return ctx.reply('⚠️ That account is already connected to another Telegram.');
    const mine = ctx.member;
    if (mine && mine.id !== web.id) {
      const a = (db.userData || {})[mine.id], b = (db.userData || {})[web.id];
      const has = d => d && (d.accounts.length || d.models.length || d.trades.length || d.pairs.length);
      if (has(a) && has(b)) return ctx.reply('⚠️ Both this Telegram and that website account already have data. Ask the owner to help.');
      if (has(a)) { db.userData[web.id] = a; }
      leaveScope();                                           // put the lists back before the old empty account is dropped
      db.users = db.users.filter(u => u.id !== mine.id);
      if (db.userData[mine.id] && db.userData[mine.id] !== db.userData[web.id]) delete db.userData[mine.id];
      delete db.userData[mine.id];
    }
    web.tgId = ctx.from.id; save();
    await ctx.reply(`✅ Connected: ${web.name} (${web.email})\n${planStatus(web)}\n\nSend /menu to start.`);
  });
  // A promo / gift code (the owner makes them with /gift)
  bot.command('promo', async ctx => {
    if (ctx.isOwner) return ctx.reply(promoHelp());
    const chk = findUsablePromo(ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, ''));
    if (chk.error) return ctx.reply('⚠️ ' + chk.error + '\n\nSend it like this:\n/promo TE-ABCD-EFGH');
    redeemPromo(ctx.member, chk.promo);
    await notifyOwner(`🎁 Promo code ${chk.promo.code} used by ${ctx.member.name} – ${promoLabel(chk.promo)}`);
    await ctx.reply(`✅ ${promoLabel(chk.promo)} free access added.\n${planStatus(ctx.member)}`);
  });
  bot.command('editplans', async ctx => { db.edit = null; await ctx.reply(editorHomeText(), { reply_markup: editorHomeKb() }); });
  bot.command('setprice', async ctx => {
    const m = /^\/\w+(?:@\w+)?\s+(\d+)\s+([\d,\s]+)(?:etb)?\s*$/i.exec(ctx.message.text.trim());
    const p = m && db.plans[Number(m[1]) - 1], n = m && Math.round(Number(m[2].replace(/[,\s]/g, '')));
    if (!p || !(n >= 0)) return ctx.reply('Send it like this:\n/setprice 2 4000  (plan number, new price in ETB)\n\n' + plansText());
    setPlanPrice(p, n); save();
    await ctx.reply(`✅ ${p.name} is now ${p.price}.\n\n` + plansText());
  });
  bot.command('addplan', async ctx => {
    const parts = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').split('|').map(x => x.trim());
    const days = Math.round(Number(parts[1]));
    if (!parts[0] || !(days >= 1 && days <= 3650)) return ctx.reply('Send it like this:\n/addplan Monthly | 30 | 500 ETB');
    const np = { id: newId(), name: parts[0].slice(0, 40), days, price: (parts[2] || '').slice(0, 40) };
    const amt = Math.round(Number(String(parts[2] || '').replace(/etb/ig, '').replace(/[,\s]/g, '')));
    if (Number.isFinite(amt) && amt > 0) setPlanPrice(np, amt);          // so the website shows the price per month
    db.plans.push(np); db.plans.sort((a, b) => a.days - b.days);
    save();
    await ctx.reply('✅ Plan added.\n\n' + plansText());
  });
  bot.command('delplan', async ctx => {
    const n = Number(ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim());
    if (!Number.isInteger(n) || n < 1 || n > db.plans.length) return ctx.reply('Send the plan number, e.g. /delplan 2\n\n' + plansText());
    if (db.plans.length === 1) return ctx.reply('Keep at least one plan.');
    db.plans.splice(n - 1, 1); save();
    await ctx.reply('🗑 Plan removed.\n\n' + plansText());
  });
  bot.command('payinfo', async ctx => {
    const t = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().slice(0, 1000);
    if (!t) return ctx.reply('Current text:\n' + (db.payInfo || '(not set)') + '\n\nChange it:\n/payinfo Telebirr 09xxxxxxxx (Name). Send the reference number after paying.');
    db.payInfo = t; save();
    await ctx.reply('✅ Saved. Subscribers will see:\n\n' + t);
  });
  // Promo / gift codes: the person types the code on the sign-up page and gets free access.
  //   /gift 12        12-month code, 1 person      /gift 3 5     3-month code, 5 people
  //   /gift 7d        7-day code                   /gift 12 1 Abebe   (any text after = your note)
  bot.command('gift', async ctx => {
    const args = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().split(/\s+/).filter(Boolean);
    const m = /^(\d{1,4})(d?)$/i.exec(args[0] || '');
    if (!m) return ctx.reply(promoHelp());
    const n = Number(m[1]), isDays = !!m[2];
    const uses = args[1] && /^\d+$/.test(args[1]) ? Number(args[1]) : 1;
    const note = args.slice(args[1] && /^\d+$/.test(args[1]) ? 2 : 1).join(' ');
    if (isDays ? !(n >= 1 && n <= 3650) : !(n >= 1 && n <= 60)) return ctx.reply(promoHelp());
    if (!(uses >= 1 && uses <= 1000)) return ctx.reply('Number of people must be 1 to 1000.');
    await sendPromo(ctx, createPromo({ months: isDays ? 0 : n, days: isDays ? n : 0, uses, note }));
  });
  bot.command('gifts', ctx => listPromos(ctx));
  bot.command('grant', async ctx => {
    const [email, d] = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().split(/\s+/);
    const days = Math.round(Number(d));
    const u = db.users.find(x => x.email === String(email || '').toLowerCase());
    if (!u || !(days >= 1 && days <= 3650)) return ctx.reply('Send it like this:\n/grant email@example.com 30');
    extendUser(u, days, u.plan || 'Manual');
    await ctx.reply(`✅ ${u.name} is active until ${dateOf(u.expiresAt)}`);
  });

  // Refresh all selected pair analysis from the web and send the weekly plan now.
  bot.command('refreshplan', async ctx => {
    try {
      await refreshPairAnalyses(true);
      await sendPlan();
    } catch (e) {
      console.error('refreshplan failed', e);
      await ctx.reply('⚠️ Could not refresh the plan right now. Please try again.');
    }
  });

  // Monday reminder settings
  bot.command('reminder', async ctx => {
    const arg = ctx.message.text.replace(/^\/\w+(@\w+)?\s*/, '').trim().toLowerCase();
    const r = db.reminder;
    const eth = h => `${((h + 6) % 12) || 12}:00 ${h >= 6 && h < 12 ? 'ጠዋት' : h >= 12 && h < 18 ? 'ቀን' : h >= 18 ? 'ማታ' : 'ሌሊት'}`;
    const status = () => `Monday reminder: ${r.enabled ? 'ON' : 'OFF'} – ${String(r.hour).padStart(2, '0')}:00 on the normal clock = ${eth(r.hour)} on the Ethiopian clock (UTC${r.utcOffset >= 0 ? '+' : ''}${r.utcOffset})`;
    if (arg === 'on' || arg === 'off') { r.enabled = arg === 'on'; save(); return ctx.reply('✅ ' + status()); }
    if (arg === 'test') return sendPlan();
    const tz = /^tz\s+(-?\d{1,2})$/.exec(arg);
    if (tz && Number(tz[1]) >= -12 && Number(tz[1]) <= 14) { r.utcOffset = Number(tz[1]); save(); return ctx.reply('✅ ' + status()); }
    if (/^\d{1,2}$/.test(arg) && Number(arg) <= 23) { r.hour = Number(arg); r.custom = true; save(); return ctx.reply('✅ ' + status()); }
    await ctx.reply(status() + '\n\n/reminder 6 – change the hour (0-23, normal clock)\n/reminder tz 3 – your time zone (UTC+3)\n/reminder off | on\n/reminder test – send the plan now');
  });

  bot.on('callback_query:data', async ctx => {
    await ctx.answerCallbackQuery().catch(() => {});
    const data = ctx.callbackQuery.data;

    if (data.startsWith('f:')) {                       // answer inside a form
      if (!flow) return showMenu(ctx);
      const value = data.slice(2);
      const step = currentSteps()[flow.i];
      if (step.type === 'multichoice') {
        const opts = step.options(flow.data).map(o => o[1]);
        const picked = flow.data[step.key] || (flow.data[step.key] = []);
        if (value === '__done') {
          if (!picked.length) return ctx.reply('Pick at least one account first.');
          return advance(ctx);
        }
        if (value === '__all') flow.data[step.key] = picked.length === opts.length ? [] : opts.slice();
        else if (opts.includes(value)) { const at = picked.indexOf(value); if (at >= 0) picked.splice(at, 1); else picked.push(value); }
        else return;
        const kb = new InlineKeyboard();
        multiKeyboard(step, kb);
        kb.text('✖ Cancel', 'cancel');
        return ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
      }
      if (value === '__skip' && step.optional) return advance(ctx);
      if (value === '__done' && step.type === 'photos') return advance(ctx);
      if (step.type === 'choice' && step.options(flow.data).some(o => o[1] === value)) {
        flow.data[step.key] = value;
        return advance(ctx);
      }
      return;
    }

    const [kind, coll, id, extra] = data.split(':');
    switch (kind) {
      case 'menu': return showMenu(ctx);
      case 'pl': return ctx.isOwner ? plansCallback(ctx, coll, id, extra) : undefined;
      case 'myplan': return ctx.reply(planStatus(ctx.member) + '\n\n' + plansText(true));
      case 'promo': {
        if (coll === 'list') return listPromos(ctx);
        if (coll === 'make') {                                 // promo:make:<months>
          const months = Number(id);
          if (!PLAN_MONTHS.includes(months)) return showMenu(ctx);
          return sendPromo(ctx, createPromo({ months }));
        }
        if (coll === 'help') return ctx.reply(promoHelp());
        if (coll === 'rev') {
          const p = (db.promos || []).find(x => x.id === id);
          if (p) { p.revoked = !p.revoked; save(); }
          return listPromos(ctx);
        }
        return ctx.reply('🎁 How long should the gift be?', {          // promo:new
          reply_markup: new InlineKeyboard()
            .text('1 month', 'promo:make:1').text('3 months', 'promo:make:3').row()
            .text('6 months', 'promo:make:6').text('12 months', 'promo:make:12').row()
            .text('ℹ️ Other (days, many people)', 'promo:help').text('⬅ Menu', 'menu')
        });
      }
      case 'cancel': cancelFlow(); return showMenu(ctx, 'Cancelled.');
      case 'new': return startFlow(ctx, coll);
      case 'site': return showMenu(ctx, '🌐 ' + (siteUrl() || 'Open /api/setup first'));
      case 'edit': {
        if (coll === 'accounts') {
          const rec = db.accounts.find(x => x.id === id);
          if (!rec) return showMenu(ctx, 'Account not found.');
          cancelFlow(); flow = { name: 'editAccount', i: -1, data: { id: rec.id } }; return advance(ctx);
        }
        if (coll === 'models') {
          const rec = db.models.find(x => x.id === id);
          if (!rec) return showMenu(ctx, 'Model not found.');
          cancelFlow(); flow = { name: 'editModel', i: -1, data: { id: rec.id } }; return advance(ctx);
        }
        if (coll === 'trades') {
          const rec = db.trades.find(x => x.id === id);
          if (!rec) return showMenu(ctx, 'Trade not found.');
          cancelFlow(); flow = { name: 'editTrade', i: -1, data: { id: rec.id } }; return advance(ctx);
        }
        return showMenu(ctx);
      }
      case 'list':
        return ({ trades: listTrades, accounts: listAccounts, models: listModels, pairs: listPairs,
          users: listUsers, pay: listPayments })[coll](ctx);
      case 'del': {
        const warn = coll === 'accounts' ? '\nThis also deletes ALL trades of this account.'
          : coll === 'users' ? '\nThis removes the subscriber and their payment requests.' : '';
        return ctx.reply('Delete this? This cannot be undone.' + warn, {
          reply_markup: new InlineKeyboard().text('✅ Yes, delete', `delok:${coll}:${id}`).text('✖ No', 'menu')
        });
      }
      case 'delok':
        return showMenu(ctx, removeRecord(coll, id) ? '🗑 Deleted.' : 'Already deleted.');
      case 'tog': {
        const m = db.models.find(x => x.id === id);
        if (m) { m.active = m.active === false; save(); }
        return listModels(ctx);
      }
      case 'trd': {                                   // trade this pair this week? (toggle)
        const p = db.pairs.find(x => x.id === coll);
        if (p) { p.trading = !p.trading; save(); }
        return listPairs(ctx);
      }
      case 'pay': {                                   // approve / reject a payment request
        const pay = db.payments.find(x => x.id === id);
        if (!pay || pay.status !== 'pending') return showMenu(ctx, 'That request was already handled.');
        const u = db.users.find(x => x.id === pay.userId);
        if (coll === 'no') { pay.status = 'rejected'; save(); return showMenu(ctx, '❌ Rejected' + (u ? ' – ' + u.name : '')); }
        const plan = db.plans.find(x => x.id === pay.planId);
        if (!u || !plan) return showMenu(ctx, '⚠️ The subscriber or the plan no longer exists.');
        extendUser(u, plan.days, plan.name);
        pay.status = 'approved'; save();
        return showMenu(ctx, `✅ Approved: ${u.name} is active until ${dateOf(u.expiresAt)}`);
      }
      case 'usr': {                                   // subscriber actions
        const u = db.users.find(x => x.id === id);
        if (!u) return showMenu(ctx, 'Subscriber not found.');
        if (coll === 'ext') { extendUser(u, Number(extra) || 30, u.plan || 'Manual'); }
        if (coll === 'blk') { u.blocked = !u.blocked; save(); }
        return showUser(ctx, id);
      }
      case 'clearpairs':
        return ctx.reply('Delete ALL pairs?', {
          reply_markup: new InlineKeyboard().text('✅ Yes, clear', 'clearok').text('✖ No', 'menu')
        });
      case 'clearok':
        db.pairs = []; db.pairsUpdatedAt = new Date().toISOString(); save();
        return showMenu(ctx, '🧹 All pairs cleared.');
    }
  });

  bot.on('message:text', async ctx => {
    if (ctx.isOwner && db.edit) return plansHandleText(ctx);   // answering a Plans & prices question
    if (!flow) return showMenu(ctx);
    const step = currentSteps()[flow.i];
    const value = ctx.message.text.trim();
    if (step.type === 'text') {
      flow.data[step.key] = step.transform ? step.transform(value) : value;
      return advance(ctx);
    }
    if (step.type === 'number') {
      const clean = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(value) ? value.replace(/,/g, '')   // 1,250.50
        : /^-?\d+,\d+$/.test(value) ? value.replace(',', '.')                                  // 1,5 -> 1.5
        : value;
      const n = clean === '' ? NaN : Number(clean);
      if (!Number.isFinite(n) || (step.min != null && n < step.min) || (step.max != null && n > step.max)) {
        return ctx.reply('Please send a valid number'
          + (step.min != null && step.max != null ? ` (${step.min}–${step.max})` : '') + '.');
      }
      flow.data[step.key] = n;
      flow.data[step.key + 'Raw'] = value;
      return advance(ctx);
    }
    if (step.type === 'date') {
      const parsed = parseBotDate(value);
      if (!parsed) return ctx.reply('Please use YYYY-MM-DD HH:MM, for example 2026-10-04 21:30.');
      flow.data[step.key] = parsed;
      return advance(ctx);
    }
    await ctx.reply('Please use the buttons above.');
  });

  bot.on('message:photo', async ctx => {
    const step = flow && currentSteps()[flow.i];
    if (!step || step.type !== 'photos') return ctx.reply('I am not expecting a photo now.');
    const list = flow.data[step.key] || (flow.data[step.key] = []);
    try { list.push(await savePhoto(ctx)); }
    catch (e) { return ctx.reply('⚠️ ' + e.message + '. Please send it again.'); }
    if (step.max != null && list.length >= step.max) return advance(ctx);
    await ctx.reply(`📷 ${list.length} saved. Send more or press Done.`);
  });

  bot.catch(err => console.error('Bot error:', err.error || err));
  return bot;
}

async function telegramWebhook(req) {
  if (req.method !== 'POST') return text('ok');
  if (req.headers.get('x-telegram-bot-api-secret-token') !== webhookSecret()) return text('forbidden', 403);
  const update = await req.json();
  if (Number.isInteger(update.update_id)) {
    if (update.update_id <= (db.lastUpdateId || 0)) return text('ok');   // duplicate delivery
    db.lastUpdateId = update.update_id; save();
  }
  const b = getBot();
  botReady = botReady || b.init();
  await botReady;
  flowDirty = true;
  try { await b.handleUpdate(update); }
  catch (e) { console.error('handleUpdate failed', e); }
  return text('ok');
}

/* Open  https://YOUR-SITE.netlify.app/api/setup  once. */
async function setup(req) {
  const requestUrl = new URL(req.url);
  const origin = requestUrl.origin;
  if (!SETUP_KEY) return text('SETUP_KEY is not configured on Netlify.', 503);
  const supplied = req.headers.get('x-setup-key') || requestUrl.searchParams.get('key') || '';
  const a = Buffer.from(String(supplied));
  const keyBuf = Buffer.from(String(SETUP_KEY));
  if (a.length !== keyBuf.length || !crypto.timingSafeEqual(a, keyBuf)) return text('Forbidden.', 403);
  if (!isHttps(origin)) return text('Open this on the https address of your site.', 400);
  db.siteUrl = origin; save();
  const b = getBot();
  await b.api.setWebhook(origin + '/api/telegram', {
    secret_token: webhookSecret(),
    max_connections: 1,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
  try { db.botUsername = (await b.api.getMe()).username || ''; save(); } catch (e) { console.error('getMe failed', e); }
  // everybody: their own journal
  await b.api.setMyCommands([
    { command: 'menu', description: 'Open the menu' },
    { command: 'plan', description: 'My weekly plan from my analysis' },
    { command: 'login', description: 'Connect my website account' },
    { command: 'promo', description: 'Use a promo (gift) code' },
    { command: 'plans', description: 'Plans and how to pay' },
    { command: 'cancel', description: 'Cancel what I am doing' }
  ]);
  // the owner: everything
  await b.api.setMyCommands([
    { command: 'menu', description: 'Open the menu' },
    { command: 'panel', description: 'Open the Super Admin Control Panel' },
    { command: 'cancel', description: 'Cancel what I am doing' },
    { command: 'gift', description: 'Make a promo (gift) code' },
    { command: 'gifts', description: 'See promo codes' },
    { command: 'reminder', description: 'Monday plan reminder settings' },
    { command: 'password', description: 'Set your own website login' },
    { command: 'plans', description: 'Subscription plans and payment info' },
    { command: 'editplans', description: 'Edit plans, prices and services text' },
    { command: 'refreshplan', description: 'Refresh web analysis and send the weekly plan' }
  ], { scope: { type: 'chat', chat_id: OWNER_ID } });
  await b.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Control Panel', web_app: { url: origin + '/admin/' } } });
  await b.api.setChatMenuButton({ chat_id: OWNER_ID, menu_button: { type: 'web_app', text: 'Control Panel', web_app: { url: origin + '/admin/' } } });
  return text('✅ Done! Your bot is connected.\nNow open your bot in Telegram and send /start');
}

/* =========================================================
   ENTRY POINT  (one request at a time, so data never mixes)
========================================================= */
let chain = Promise.resolve();
const serial = fn => {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
};

async function route(req) {
  if (!BOT_TOKEN || !OWNER_ID) {
    return text('Server is not set up yet: BOT_TOKEN and OWNER_ID are missing.', 500);
  }
  const url = new URL(req.url);
  const needsLock = url.pathname === '/api/setup' || !['GET', 'HEAD'].includes(req.method);
  if (needsLock) await acquireWriteLock();
  await loadState();
  try {
    if (url.pathname === '/api/telegram') return await telegramWebhook(req);
    if (url.pathname === '/api/setup') return await setup(req);
    if (url.pathname.startsWith('/uploads/')) return await serveImage(url.pathname, req);
    if (url.pathname.startsWith('/api/')) return await api(req, url);
    return text('not found', 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || 'Server error' }, e.status || 500);
  } finally {
    leaveScope();
    await flushState().catch(e => console.error('Saving failed:', e));
    if (needsLock) await releaseWriteLock().catch(() => {});
  }
}

export default async req => serial(() => route(req));
