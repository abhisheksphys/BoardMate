// Cost meter: prices each API call from its token usage and keeps session / today / month totals.
import { emit } from './bus.js';
import { settings } from './settings.js';

// USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, Nov 2026).
// read = cache-read multiplier of the input price. Cache writes: 1.25x (5 min) or 2x (1 hour).
const PRICES = [
  ['haiku', { in: 0.1, out: 0.5, read: 0.1 }],
  ['sonnet', { in: 2, out: 10, read: 0.05 }],
  ['opus', { in: 4, out: 20, read: 0.05 }],
  ['fable', { in: 8, out: 40, read: 0.025 }],
];

export function priceOf(model) {
  return (PRICES.find(([k]) => String(model).includes(k)) || PRICES[2])[1];
}

export function costOf(model, u = {}) {
  const p = priceOf(model);
  const cw = u.cache_creation || {};
  const w5 = cw.ephemeral_5m_input_tokens, w1h = cw.ephemeral_1h_input_tokens;
  const writes = w5 !== undefined || w1h !== undefined
    ? (w5 || 0) * 1.25 + (w1h || 0) * 2
    : (u.cache_creation_input_tokens || 0) * (settings.longCache ? 2 : 1.25);
  return ((u.input_tokens || 0) * p.in + writes * p.in + (u.cache_read_input_tokens || 0) * p.in * p.read + (u.output_tokens || 0) * p.out) / 1e6;
}

const KEY = 'live-board-costs';
const dayKey = () => new Date().toLocaleDateString('en-CA');
const monthKey = () => dayKey().slice(0, 7);

function load() {
  let s;
  try { s = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { s = {}; }
  if (s.day !== dayKey()) { s.day = dayKey(); s.today = { total: 0, by: {} }; }
  if (s.month !== monthKey()) { s.month = monthKey(); s.monthTotal = 0; }
  return s;
}

export const meter = {
  session: 0,
  record(model, usage, purpose = 'answer') {
    const c = costOf(model, usage);
    const s = load();
    s.today.total += c;
    s.today.by[purpose] = (s.today.by[purpose] || 0) + c;
    s.monthTotal += c;
    localStorage.setItem(KEY, JSON.stringify(s));
    this.session += c;
    emit('cost', { cost: c, purpose, model });
    return c;
  },
  stats() {
    const s = load();
    return { session: this.session, today: s.today.total, byPurpose: s.today.by, month: s.monthTotal };
  },
};

export function fmt(usd) {
  const r = settings.currencyRate;
  if (r > 0) {
    const v = usd * r;
    return `${settings.currencySymbol}${v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)}`;
  }
  return `$${usd < 0.1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function overBudget() {
  return settings.dailyBudgetUSD > 0 && meter.stats().today >= settings.dailyBudgetUSD;
}
