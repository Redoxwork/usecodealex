'use strict';
// Daily SOL giveaway.
// - Every linked player gets a personal 4-digit code that changes each day (UTC).
// - Typing "<word> <code>" in Alex's Kick chat while he is live enters them for that day.
// - Alex draws a winner on stream; anything not drawn by 00:00 UTC is drawn automatically.
const crypto = require('crypto');

const dayOf = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

class Giveaway {
  constructor(store, secret) {
    this.store = store;
    this.secret = secret;
  }

  _st() {
    const s = this.store.get('give', null) || { days: {}, attempts: [] };
    s.days = s.days || {};
    s.attempts = s.attempts || [];
    return s;
  }
  _save(s) {
    // keep 60 days of history and the last 40 check-in attempts
    const keep = Object.keys(s.days).sort().slice(-60);
    s.days = Object.fromEntries(keep.map((k) => [k, s.days[k]]));
    s.attempts = s.attempts.slice(0, 40);
    this.store.set('give', s);
  }

  today() { return dayOf(); }

  code(kick, day = dayOf()) {
    const h = crypto.createHmac('sha256', this.secret).update('checkin|' + String(kick).toLowerCase() + '|' + day).digest();
    return String(1000 + (h.readUInt32BE(0) % 9000));
  }

  isIn(kick, day = dayOf()) {
    const d = this._st().days[day];
    return !!(d && d.entries.some((e) => e.kick.toLowerCase() === String(kick).toLowerCase()));
  }

  // Record what happened to a chat check-in, so Alex can answer "why didn't mine count?"
  note(kick, result) {
    const s = this._st();
    s.attempts.unshift({ kick, result, at: new Date().toISOString() });
    this._save(s);
  }

  enter(kick, day = dayOf()) {
    const s = this._st();
    const d = (s.days[day] = s.days[day] || { entries: [], winner: null, paid: false, tx: '' });
    if (d.entries.some((e) => e.kick.toLowerCase() === kick.toLowerCase())) return false;
    d.entries.push({ kick, at: new Date().toISOString() });
    this._save(s);
    return true;
  }

  draw(day, by, reroll) {
    const s = this._st();
    const d = s.days[day];
    if (!d || !d.entries.length) throw Object.assign(new Error('Nobody checked in that day.'), { code: 400 });
    if (d.winner && !reroll) throw Object.assign(new Error('That day already has a winner.'), { code: 409 });
    if (d.paid) throw Object.assign(new Error('That day is already paid. Untick paid first to redraw.'), { code: 409 });
    const pool = d.winner ? d.entries.filter((e) => e.kick !== d.winner.kick) : d.entries;
    if (!pool.length) throw Object.assign(new Error('Nobody else to draw.'), { code: 400 });
    const w = pool[crypto.randomInt(pool.length)];
    d.winner = { kick: w.kick, at: new Date().toISOString(), by };
    this._save(s);
    return d.winner;
  }

  setPaid(day, paid, tx) {
    const s = this._st();
    const d = s.days[day];
    if (!d || !d.winner) throw Object.assign(new Error('Draw a winner first.'), { code: 400 });
    d.paid = !!paid;
    d.tx = String(tx || '').slice(0, 140);
    this._save(s);
  }

  // Days before today that have entries but no winner get drawn automatically.
  autoDraw() {
    const s = this._st();
    const today = dayOf();
    const done = [];
    for (const day of Object.keys(s.days)) {
      const d = s.days[day];
      if (day < today && !d.winner && d.entries.length) {
        this.draw(day, 'auto');
        done.push(day);
      }
    }
    return done;
  }

  admin() {
    const s = this._st();
    const days = Object.keys(s.days).sort().reverse().slice(0, 14).map((day) => ({ day, ...s.days[day] }));
    return { today: dayOf(), days, attempts: s.attempts };
  }

  publicInfo() {
    const s = this._st();
    const today = dayOf();
    const last = Object.keys(s.days).sort().reverse().map((k) => [k, s.days[k]]).find(([, d]) => d.winner);
    return {
      today: (s.days[today] || { entries: [] }).entries.length,
      last: last ? { kick: last[1].winner.kick, day: last[0] } : null,
    };
  }
}

module.exports = { Giveaway, dayOf };
