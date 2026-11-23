'use strict';
// Kick public API (docs.kick.com).
// - Sign in: OAuth 2.1 authorization code + PKCE (S256) on id.kick.com
// - Live status: GET https://api.kick.com/public/v1/channels?slug=<slug> with an app token
// - Who signed in: GET https://api.kick.com/public/v1/users with the user's token
const crypto = require('crypto');

// KICK_ID_URL / KICK_API_URL exist only so tests can point at a fake Kick. Leave them unset.
const ID = process.env.KICK_ID_URL || 'https://id.kick.com';
const API = process.env.KICK_API_URL || 'https://api.kick.com/public/v1';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

class Kick {
  constructor({ clientId, clientSecret, redirectUri, log = console }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.log = log;
    this.pending = new Map(); // state -> { verifier, next, at }
    this.app = null; // { token, exp }
  }

  get configured() {
    return !!(this.clientId && this.clientSecret);
  }

  // Step 1: send the visitor to Kick.
  authorizeUrl(next) {
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    this.pending.set(state, { verifier, next, at: Date.now() });
    this._sweep();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'user:read',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${ID}/oauth/authorize?${q}`;
  }

  // Step 2: Kick sends the visitor back with ?code=&state=
  async finish(code, state) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 10 * 60 * 1000) throw new Error('Sign-in expired, please try again.');
    const tok = await this._token({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code_verifier: p.verifier,
      code,
    });
    const r = await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) throw new Error('Kick user lookup failed (' + r.status + ')');
    const j = await r.json();
    const u = j && j.data && j.data[0];
    if (!u || !u.name) throw new Error('Kick did not return a username.');
    // We only need the name and id. The user token is not stored.
    return { kick: u.name, uid: u.user_id, next: p.next };
  }

  async _token(body) {
    const r = await fetch(`${ID}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error('Kick token request failed (' + r.status + '): ' + t.slice(0, 200));
    return JSON.parse(t);
  }

  async _appToken() {
    if (this.app && Date.now() < this.app.exp - 60_000) return this.app.token;
    const t = await this._token({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    this.app = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    return this.app.token;
  }

  // Live status for one channel slug (e.g. "alexx").
  async channel(slug) {
    const token = await this._appToken();
    const r = await fetch(`${API}/channels?slug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.status === 401) this.app = null; // token revoked, get a new one next time
    if (!r.ok) throw new Error('Kick channel lookup failed (' + r.status + ')');
    const j = await r.json();
    const c = j && j.data && j.data[0];
    if (!c) throw new Error('Kick channel "' + slug + '" not found');
    const s = c.stream || {};
    return {
      id: c.broadcaster_user_id,
      live: !!s.is_live,
      title: c.stream_title || '',
      category: (c.category && c.category.name) || '',
      thumbnail: s.is_live ? s.thumbnail || '' : '',
    };
  }

  // ----- webhooks -----
  // Kick signs "<message id>.<timestamp>.<raw body>" with RSA-SHA256; the public key is fetched, never hardcoded.
  async publicKey(force) {
    if (!force && this.pk && Date.now() - this.pk.at < 6 * 3600_000) return this.pk.key;
    const r = await fetch(`${API}/public-key`);
    if (!r.ok) throw new Error('Kick public key fetch failed (' + r.status + ')');
    const j = await r.json();
    const pem = j && j.data && j.data.public_key;
    if (!pem) throw new Error('Kick public key missing');
    this.pk = { key: crypto.createPublicKey(pem), at: Date.now() };
    return this.pk.key;
  }

  async verifyWebhook(headers, raw) {
    const id = headers['kick-event-message-id'];
    const ts = headers['kick-event-message-timestamp'];
    const sig = headers['kick-event-signature'];
    if (!id || !ts || !sig) return false;
    const data = Buffer.concat([Buffer.from(`${id}.${ts}.`), raw]);
    const check = (key) => crypto.verify('sha256', data, key, Buffer.from(sig, 'base64'));
    try {
      if (check(await this.publicKey())) return true;
      return check(await this.publicKey(true)); // key may have just been rotated
    } catch (e) {
      this.log.error('[kick] webhook verify', e.message);
      return false;
    }
  }

  // Make sure Kick sends us chat messages and live/offline changes for this channel.
  async ensureSubscriptions(broadcasterId) {
    const want = ['chat.message.sent', 'livestream.status.updated'];
    const token = await this._appToken();
    const h = { Authorization: `Bearer ${token}` };
    const r = await fetch(`${API}/events/subscriptions?broadcaster_user_id=${broadcasterId}`, { headers: h });
    if (!r.ok) throw new Error('Kick subscriptions list failed (' + r.status + ')');
    const have = new Set(((await r.json()).data || []).filter((x) => x.method === 'webhook').map((x) => x.event));
    const missing = want.filter((e) => !have.has(e));
    if (!missing.length) return [];
    const p = await fetch(`${API}/events/subscriptions`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ broadcaster_user_id: broadcasterId, events: missing.map((name) => ({ name, version: 1 })), method: 'webhook' }),
    });
    const t = await p.text();
    if (!p.ok) throw new Error('Kick subscribe failed (' + p.status + '): ' + t.slice(0, 200));
    const bad = (JSON.parse(t).data || []).filter((x) => x.error);
    if (bad.length) throw new Error('Kick subscribe: ' + bad.map((x) => x.name + ' ' + x.error).join(', '));
    return missing;
  }

  _sweep() {
    const cut = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of this.pending) if (v.at < cut) this.pending.delete(k);
  }
}

module.exports = { Kick };
