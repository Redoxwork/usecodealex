'use strict';
// Race clock: work out each race window, close finished races and start the next one.

const DAY = 864e5;

function addMonth(t) {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
function subMonth(t) {
  const d = new Date(t);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

function nextEnd(end, period) {
  if (period === 'Weekly') return end + 7 * DAY;
  if (period === 'Every 2 weeks') return end + 14 * DAY;
  return addMonth(end);
}
function startOf(end, period) {
  if (period === 'Weekly') return end - 7 * DAY;
  if (period === 'Every 2 weeks') return end - 14 * DAY;
  return subMonth(end);
}

// Leaderboards show "Da***x" style names, never full usernames.
function mask(name) {
  const s = String(name);
  if (s.length <= 3) return s[0] + '***';
  return s.slice(0, 2) + '***' + s.slice(-1);
}

// Same rules the site uses: apply admin hides and +/- adjustments, then sort.
function finalBoard(rows, rc) {
  const hidden = rc.hidden || [];
  const adj = rc.adj || {};
  return rows
    .map((p) => [String(p[0]), (+p[1] || 0) + (+adj[p[0]] || 0)])
    .filter((p) => !hidden.includes(p[0]) && p[1] > 0)
    .sort((a, b) => b[1] - a[1]);
}

function label(race, end, period) {
  const e = new Date(end);
  if (race === 'vega' && period === 'Monthly') {
    // Name a monthly race after the month it ran in (the day before it ended).
    return new Date(end - DAY).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const s = new Date(startOf(end, period));
  const f = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(s)}–${f(new Date(e - DAY))}`;
}

module.exports = { nextEnd, startOf, mask, finalBoard, label, DAY };
