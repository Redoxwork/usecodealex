'use strict';
// Generic "JSON over HTTPS" affiliate adapter.
//
// Every casino adapter returns the same shape:
//   { rows: [[username, amount], ...], total: number }
// where amount is the player's wager inside the race window
// (USD for Vega, SOL for Rugs.fun) and total is the community total.
//
// Configure it with environment variables (PREFIX is VEGA or RUGS):
//   PREFIX_API_URL      URL. {start} and {end} are replaced with ISO dates,
//                       {start_ms} / {end_ms} with unix milliseconds.
//   PREFIX_API_KEY      secret sent in a header (optional)
//   PREFIX_API_HEADER   header name for the key (default: Authorization, sent as "Bearer <key>")
//   PREFIX_LIST_PATH    where the player list sits in the JSON, e.g. "data" or "result.players"
//   PREFIX_NAME_FIELD   username field in each item (default: username)
//   PREFIX_WAGER_FIELD  wager field in each item (default: wagered)
//   PREFIX_DIVIDE       divide amounts by this (e.g. 1e9 for lamports to SOL, 100 for cents)
//
// If the real API needs something this can't express (signing, paging, a POST body),
// copy this file to vega.js / rugs.js and change fetchBoard(). Nothing else changes.

function pick(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function make(prefix) {
  const env = (k, d) => process.env[`${prefix}_${k}`] || d;
  return {
    name: prefix.toLowerCase(),
    get configured() {
      return !!env('API_URL');
    },
    async fetchBoard({ start, end }) {
      const url = env('API_URL')
        .replace('{start}', encodeURIComponent(new Date(start).toISOString()))
        .replace('{end}', encodeURIComponent(new Date(end).toISOString()))
        .replace('{start_ms}', String(start))
        .replace('{end_ms}', String(end));
      const headers = { Accept: 'application/json' };
      const key = env('API_KEY');
      if (key) {
        const h = env('API_HEADER', 'Authorization');
        headers[h] = h.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
      }
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`${prefix} API ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      const list = pick(j, env('LIST_PATH', ''));
      if (!Array.isArray(list)) throw new Error(`${prefix} API: no list at "${env('LIST_PATH', '(root)')}"`);
      const nf = env('NAME_FIELD', 'username');
      const wf = env('WAGER_FIELD', 'wagered');
      const div = Number(env('DIVIDE', '1')) || 1;
      const rows = list
        .map((it) => [String(pick(it, nf) || '').trim(), Number(pick(it, wf)) / div || 0])
        .filter((p) => p[0] && p[1] > 0)
        .sort((a, b) => b[1] - a[1]);
      const total = rows.reduce((s, p) => s + p[1], 0);
      return { rows, total };
    },
  };
}

module.exports = { make };
