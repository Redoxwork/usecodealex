'use strict';
// UseCodeAlex server.
// Serves the site, keeps the admin settings in one place for every visitor,
// signs people in with Kick, checks if Alex is live, pulls casino wagers,
// and closes each race on time (payout list + next race).
//
// Node 20+ only, no npm packages. Settings come from a .env file next to this one.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadEnv(path.join(__dirname, '.env'));

const { Store } = require('./lib/store');
const { Kick } = require('./lib/kick');
const { make } = require('./lib/casinos/generic');
const R = require('./lib/races');
const { verifyWallet } = require('./lib/wallet');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || '';
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const ROOT = path.join(__dirname, '..');
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const POLL_MS = Math.max(30_000, Number(process.env.POLL_SECONDS || 120) * 1000);

if (!SECRET || SECRET.length < 32) {
  console.error('SESSION_SECRET must be set in server/.env (at least 32 random characters). See .env.example.');
  process.exit(1);
}
if (DEV_LOGIN && /^https:/.test(SITE_URL)) {
  console.error('DEV_LOGIN=1 is for testing on your own computer only. Remove it from .env on the live server.');
  process.exit(1);
}

const db = new Store(DATA);
const kick = new Kick({
  clientId: process.env.KICK_CLIENT_ID,
  clientSecret: process.env.KICK_CLIENT_SECRET,
  redirectUri: SITE_URL + '/auth/kick/callback',
});
const CASINOS = { vega: make('VEGA'), rugs: make('RUGS') };

// ---------- helpers ----------
function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const b64u = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function setSession(res, sess) {
  const body = b64u(JSON.stringify({ ...sess, exp: Date.now() + 30 * R.DAY }));
  cookie(res, 'uca_s', body + '.' + sign(body), 30 * 86400);
}
function getSession(req) {
  const c = parseCookies(req).uca_s;
  if (!c) return null;
  const [body, mac] = c.split('.');
  if (!body || !mac) return null;
  const good = sign(body);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString());
    return s.exp > Date.now() ? s : null;
  } catch (_) { return null; }
}
function cookie(res, name, val, maxAge) {
  const secure = /^https:/.test(SITE_URL) ? '; Secure' : '';
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [].concat(prev, `${name}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`));
}
function parseCookies(req) {
  const out = {};
  for (const p of String(req.headers.cookie || '').split(';')) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra,
  });
  res.end(buf);
}
const json = (res, code, obj) => send(res, code, obj, 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
function redirect(res, to) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}
function readBody(req, limit = 1_000_000) {
  return new Promise((ok, bad) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { bad(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}); }
      catch (_) { bad(Object.assign(new Error('Bad JSON'), { code: 400 })); }
    });
    req.on('error', bad);
  });
}
// Only send people back to pages on this site after sign-in.
function safeNext(n) {
  n = String(n || '/');
  return n.startsWith('/') && !n.startsWith('//') ? n : '/';
}

// ---------- site config ----------
function pub() { return db.get('pub', null); } // { cfg, at, by, rev }
function roleOf(kickName) {
  const p = pub();
  if (!p || !kickName) return null;
  const owner = (process.env.OWNER_KICK || 'alexx').toLowerCase();
  if (kickName.toLowerCase() === owner) return 'Owner';
  const m = ((p.cfg.players || {}).mods || []).find((x) => String(x.kick).toLowerCase() === kickName.toLowerCase());
  return m ? m.role : null;
}
// Before anything is published, only the owner can sign in to the admin.
function roleOrOwner(kickName) {
  if (!kickName) return null;
  if (!pub()) return kickName.toLowerCase() === (process.env.OWNER_KICK || 'alexx').toLowerCase() ? 'Owner' : null;
  return roleOf(kickName);
}
// What visitors get: no player link list (it has Kick names in it).
function publicCfg(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.players) c.players = { autoApprove: !!c.players.autoApprove, mods: [], links: [] };
  return c;
}
function savePub(cfg, by) {
  const p = pub();
  const rev = (p ? p.rev : 0) + 1;
  db.set('pub', { cfg, at: Date.now(), by, rev });
  if (by !== 'auto') {
    const h = db.get('hist', []);
    h.unshift({ at: Date.now(), by, cfg });
    db.set('hist', h.slice(0, 10));
  }
  return rev;
}

// ---------- live data (Kick + casinos) ----------
const live = db.get('live', { boards: { vega: null, rugs: null }, totals: { vega: null, rugs: null }, kick: { ok: false, live: false }, at: 0, errors: {} });
function saveLive() { live.at = Date.now(); db.set('live', live); }

async function pollKick() {
  if (!kick.configured) return;
  const p = pub();
  const url = (p && p.cfg.site && p.cfg.site.socials && p.cfg.site.socials.kick) || 'https://kick.com/alexx';
  const slug = url.replace(/\/+$/, '').split('/').pop();
  try {
    const c = await kick.channel(slug);
    live.kick = { ok: true, ...c };
    delete live.errors.kick;
  } catch (e) {
    live.errors.kick = e.message;
    log('[kick]', e.message);
  }
  saveLive();
}

async function pollCasino(race) {
  const ad = CASINOS[race];
  const p = pub();
  if (!ad.configured || !p) return null;
  const rc = p.cfg.races[race];
  const end = Date.parse(rc.end);
  if (isNaN(end)) return null;
  try {
    const { rows, total } = await ad.fetchBoard({ start: R.startOf(end, rc.period), end: Math.min(Date.now(), end) });
    live.boards[race] = rows.slice(0, 200).map((r) => [R.mask(r[0]), Math.round(r[1] * 100) / 100]);
    live.totals[race] = Math.round(total * 100) / 100;
    delete live.errors[race];
    saveLive();
    return live.boards[race];
  } catch (e) {
    live.errors[race] = e.message;
    saveLive();
    log('[' + race + ']', e.message);
    return null;
  }
}

// ---------- race clock ----------
let closing = false;
async function raceClock() {
  const p = pub();
  if (!p || closing) return;
  closing = true;
  try {
    let changed = false;
    const cfg = JSON.parse(JSON.stringify(p.cfg));
    for (const race of ['vega', 'rugs']) {
      const rc = cfg.races[race];
      let end = Date.parse(rc.end);
      if (isNaN(end) || Date.now() < end) continue;
      // Final numbers: one last pull from the casino, otherwise the manual board.
      let rows = await pollCasino(race);
      if (!rows) rows = (rc.board || []).map((x) => [String(x[0]), +x[1] || 0]);
      const board = R.finalBoard(rows, rc);
      const prizes = (rc.prizes || []).map((x) => +x || 0);
      const winners = prizes.map((pz, i) => (board[i] ? { nm: board[i][0], w: board[i][1], p: pz, paid: false, tx: '', at: '' } : null)).filter(Boolean);
      cfg.payouts = cfg.payouts || {};
      cfg.payouts[race] = cfg.payouts[race] || [];
      if (winners.length) cfg.payouts[race].unshift({ m: R.label(race, end, rc.period), rows: winners });
      // Next race: same length, starting where this one ended.
      while (end <= Date.now()) end = R.nextEnd(end, rc.period);
      rc.end = new Date(end).toISOString();
      rc.board = null;
      rc.adj = {};
      rc.total = 0;
      live.boards[race] = CASINOS[race].configured ? [] : null;
      live.totals[race] = CASINOS[race].configured ? 0 : null;
      changed = true;
      log(`[clock] ${race} race closed: ${winners.length} winners saved, next race ends ${rc.end}`);
    }
    if (changed) { savePub(cfg, 'auto'); saveLive(); }
  } catch (e) {
    log('[clock]', e.message);
  } finally {
    closing = false;
  }
}

// ---------- player links ----------
const nonces = new Map(); // kick -> { nonce, at }
function addLink(kickName, race, casino, st) {
  const p = pub();
  if (!p) throw Object.assign(new Error('The site is not set up yet.'), { code: 503 });
  const cfg = JSON.parse(JSON.stringify(p.cfg));
  cfg.players = cfg.players || { mods: [], links: [] };
  const links = (cfg.players.links = cfg.players.links || []);
  const taken = links.find((l) => l.race === race && String(l.casino).toLowerCase() === casino.toLowerCase() && l.kick.toLowerCase() !== kickName.toLowerCase() && l.st !== 'no');
  if (taken) throw Object.assign(new Error('That account is already linked to someone else. Ask Alex if it is yours.'), { code: 409 });
  // One link per Kick account per race: replace the old request.
  for (let i = links.length - 1; i >= 0; i--) if (links[i].race === race && links[i].kick.toLowerCase() === kickName.toLowerCase()) links.splice(i, 1);
  const status = st || (cfg.players.autoApprove ? 'ok' : 'pending');
  links.unshift({ kick: kickName, casino, race, st: status, at: new Date().toISOString() });
  savePub(cfg, 'auto');
  return status;
}
function myLinks(kickName) {
  const p = pub();
  if (!p || !kickName) return [];
  return ((p.cfg.players || {}).links || [])
    .filter((l) => l.kick.toLowerCase() === kickName.toLowerCase())
    .map((l) => ({ race: l.race, casino: l.casino, st: l.st }));
}

// ---------- static files ----------
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8', 'no-cache'],
  '/og.jpg': ['og.jpg', 'image/jpeg', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
  '/favicon.ico': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400'],
};
const fileCache = new Map();
function serveFile(res, urlPath) {
  const f = FILES[urlPath];
  if (!f) {
    // Unknown page: send the site, which shows its own 404 screen.
    return redirect(res, '/#lost');
  }
  let buf = fileCache.get(f[0]);
  if (!buf || process.env.NO_CACHE === '1') {
    buf = fs.readFileSync(path.join(ROOT, f[0]));
    fileCache.set(f[0], buf);
  }
  send(res, 200, buf, f[1], { 'Cache-Control': f[2] });
}

// ---------- routes ----------
async function route(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const m = req.method;
  const sess = getSession(req);

  // Mutating API calls must carry this header (blocks cross-site form posts).
  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-uca'] !== '1') return json(res, 403, { error: 'Missing header' });

  if (p === '/api/health') return json(res, 200, { ok: true, kick: kick.configured, vega: CASINOS.vega.configured, rugs: CASINOS.rugs.configured, published: !!pub() });

  if (p === '/api/doc/site/pub' && m === 'GET') {
    const d = pub();
    if (!d) return json(res, 200, { exists: false });
    const admin = sess && roleOrOwner(sess.kick);
    return json(res, 200, { exists: true, data: { cfg: JSON.stringify(admin ? d.cfg : publicCfg(d.cfg)), at: d.at, by: d.by, rev: d.rev } });
  }
  if (p === '/api/doc/site/hist' && m === 'GET') {
    if (!(sess && roleOrOwner(sess.kick))) return json(res, 403, { error: 'Admins only' });
    return json(res, 200, { exists: true, data: { list: JSON.stringify(db.get('hist', [])) } });
  }
  if (p === '/api/publish' && m === 'PUT') {
    const role = sess && roleOrOwner(sess.kick);
    if (!role) return json(res, 403, { error: 'Sign in with an admin Kick account.' });
    const b = await readBody(req);
    if (!b || typeof b.cfg !== 'object' || !b.cfg.races || !b.cfg.site) return json(res, 400, { error: 'Bad settings' });
    const cur = pub();
    if (cur && b.baseRev !== cur.rev) {
      return json(res, 409, { error: 'The site changed since you opened the admin (a race reset or another admin published).', rev: cur.rev, cfg: JSON.stringify(cur.cfg) });
    }
    let cfg = b.cfg;
    if (role === 'Mod' && cur) {
      // Mods can only manage players and payouts.
      cfg = JSON.parse(JSON.stringify(cur.cfg));
      cfg.players = { ...cfg.players, links: b.cfg.players.links, autoApprove: cfg.players.autoApprove, mods: cfg.players.mods };
      cfg.payouts = b.cfg.payouts;
    }
    if (role !== 'Owner' && cur) cfg.players.mods = cur.cfg.players.mods; // only the owner adds or removes admins
    const rev = savePub(cfg, sess.kick);
    log('[admin] published by @' + sess.kick + ' rev ' + rev);
    setTimeout(() => { raceClock(); pollKick(); pollCasino('vega'); pollCasino('rugs'); }, 500);
    return json(res, 200, { ok: true, rev });
  }

  if (p === '/api/live') {
    return json(res, 200, { boards: live.boards, totals: live.totals, kick: live.kick, at: live.at });
  }
  if (p === '/api/status') {
    if (!(sess && roleOrOwner(sess.kick))) return json(res, 403, { error: 'Admins only' });
    return json(res, 200, { errors: live.errors, at: live.at, kick: kick.configured, vega: CASINOS.vega.configured, rugs: CASINOS.rugs.configured });
  }

  if (p === '/api/me') {
    if (!sess) return json(res, 200, { kick: null, signIn: kick.configured || DEV_LOGIN });
    return json(res, 200, { kick: sess.kick, role: roleOrOwner(sess.kick), links: myLinks(sess.kick) });
  }

  if (p === '/api/link' && m === 'POST') {
    if (!sess) return json(res, 401, { error: 'Sign in with Kick first.' });
    const b = await readBody(req, 20_000);
    if (b.race === 'vega') {
      const name = String(b.casino || '').trim();
      if (!/^[\w.\-]{3,32}$/.test(name)) return json(res, 400, { error: 'Enter your Vega username (3 to 32 letters, numbers, dots, dashes or underscores).' });
      const st = addLink(sess.kick, 'vega', name);
      return json(res, 200, { ok: true, st, links: myLinks(sess.kick) });
    }
    if (b.race === 'rugs') {
      const n = nonces.get(sess.kick);
      nonces.delete(sess.kick);
      if (!n || Date.now() - n.at > 10 * 60 * 1000) return json(res, 400, { error: 'That request expired. Try again.' });
      const msg = linkMessage(sess.kick, n.nonce);
      if (!verifyWallet(String(b.wallet || ''), msg, String(b.sig || ''))) return json(res, 400, { error: 'Wallet signature did not match. Try again.' });
      const st = addLink(sess.kick, 'rugs', String(b.wallet), 'ok');
      return json(res, 200, { ok: true, st, links: myLinks(sess.kick) });
    }
    return json(res, 400, { error: 'Unknown race' });
  }
  if (p === '/api/link/nonce' && m === 'POST') {
    if (!sess) return json(res, 401, { error: 'Sign in with Kick first.' });
    const nonce = crypto.randomBytes(12).toString('hex');
    nonces.set(sess.kick, { nonce, at: Date.now() });
    return json(res, 200, { message: linkMessage(sess.kick, nonce) });
  }

  // ---- sign in with Kick ----
  if (p === '/auth/kick') {
    const next = safeNext(u.searchParams.get('next'));
    if (!kick.configured) return redirect(res, next + (next.includes('?') ? '&' : '?') + 'signin=off');
    return redirect(res, kick.authorizeUrl(next));
  }
  if (p === '/auth/kick/callback') {
    try {
      if (u.searchParams.get('error')) throw new Error('Kick sign-in was cancelled.');
      const r = await kick.finish(u.searchParams.get('code'), u.searchParams.get('state'));
      setSession(res, { kick: r.kick, uid: r.uid });
      log('[auth] signed in @' + r.kick);
      return redirect(res, safeNext(r.next));
    } catch (e) {
      log('[auth]', e.message);
      return redirect(res, '/?signin=failed');
    }
  }
  if (p === '/auth/dev' && DEV_LOGIN) {
    const name = String(u.searchParams.get('u') || '').replace(/[^\w.\-]/g, '').slice(0, 25);
    if (!name) return json(res, 400, { error: 'u= required' });
    setSession(res, { kick: name, uid: 0 });
    return redirect(res, safeNext(u.searchParams.get('next')));
  }
  if (p === '/auth/logout') {
    cookie(res, 'uca_s', '', 0);
    return redirect(res, safeNext(u.searchParams.get('next')));
  }

  if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (m !== 'GET' && m !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  return serveFile(res, p);
}

function linkMessage(kickName, nonce) {
  return `UseCodeAlex: link this wallet to Kick @${kickName}. This is not a transaction and costs nothing. Code: ${nonce}`;
}

// ---------- start ----------
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) log('[error]', req.method, req.url, e.stack || e.message);
    if (!res.headersSent) json(res, code, { error: code === 500 ? 'Server error' : e.message });
  });
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(PORT, HOST, () => {
  log(`UseCodeAlex running on ${HOST}:${PORT} (public URL ${SITE_URL})`);
  log(`Kick sign-in: ${kick.configured ? 'on' : 'OFF (set KICK_CLIENT_ID/SECRET)'} · Vega API: ${CASINOS.vega.configured ? 'on' : 'off'} · Rugs.fun API: ${CASINOS.rugs.configured ? 'on' : 'off'}${DEV_LOGIN ? ' · DEV LOGIN ON' : ''}`);
});

const timers = [
  setInterval(pollKick, 60_000),
  setInterval(() => { pollCasino('vega'); pollCasino('rugs'); }, POLL_MS),
  setInterval(raceClock, 30_000),
];
setTimeout(() => { pollKick(); pollCasino('vega'); pollCasino('rugs'); raceClock(); }, 1000);

function stop() {
  timers.forEach(clearInterval);
  try { db.flush(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
