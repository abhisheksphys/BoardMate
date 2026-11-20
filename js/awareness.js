// Claude's awareness of the whole board, like a second person watching you work:
// - a board map it keeps itself (always on, cheap: text only): the parts of the page, what each is for, how they
//   build on each other, your goal, open points. Shared by watching and answering, so it is one memory.
// - remarks with timing (always on): "now" (an error the next lines build on), "at a pause", or "only if asked";
//   remarks you dismissed are not raised again.
// - Awareness Normal / Deep (setting + toolbar toggle) decides the parts that cost more: how many other areas
//   Claude may ask to see before judging new work, and (Deep) a step-back look at the whole page in pauses,
//   by the strong model.
import { settings } from './settings.js';
import { union } from './bus.js';

export const DEEP = () => settings.awareness === 'deep';
export const extraAreasAllowed = () => (DEEP() ? 3 : 1);

export function mapOf(page) {
  page.map ||= { goal: '', areas: [], open: [] };
  page.map.areas ||= [];
  page.map.open ||= [];
  return page.map;
}

// The map as text for Claude. `crop` (optional): areas inside that picture get their box in its pixels,
// others say roughly where they are relative to it.
export function mapForPrompt(board, page, crop = null) {
  const m = mapOf(page);
  if (!m.areas.length && !m.goal && !m.open.length) return 'none yet (start it)';
  const where = (a) => {
    if (!crop) return undefined;
    const r = crop.bounds;
    const inside = a.x < r.x + r.w && a.x + a.w > r.x && a.y < r.y + r.h && a.y + a.h > r.y;
    if (inside) return { in_image_1: board.rectToImage(crop, a) };
    const cy = a.y + a.h / 2, cx = a.x + a.w / 2;
    return { elsewhere: cy < r.y ? 'above' : cy > r.y + r.h ? 'below' : cx < r.x ? 'left' : 'right' };
  };
  return JSON.stringify({
    goal: m.goal || undefined,
    areas: m.areas.map((a) => ({ id: a.id, name: a.name, purpose: a.purpose, uses: a.uses?.length ? a.uses : undefined, ...where(a) })),
    open: m.open.length ? m.open : undefined,
  });
}

// Applies Claude's "map" update; boxes come in pixels of `crop`.
export function applyMap(board, page, upd, crop) {
  if (!upd || typeof upd !== 'object') return 0;
  const m = mapOf(page);
  let n = 0;
  if (typeof upd.goal === 'string' && upd.goal.trim()) { m.goal = upd.goal.trim().slice(0, 200); n++; }
  for (const id of Array.isArray(upd.remove) ? upd.remove : []) {
    const i = m.areas.findIndex((a) => a.id === id);
    if (i >= 0) { m.areas.splice(i, 1); n++; }
  }
  for (const a of Array.isArray(upd.areas) ? upd.areas : []) {
    if (!a || !a.id) continue;
    let box = null;
    if (crop && [a.x0, a.y0, a.x1, a.y1].every(Number.isFinite)) {
      const p = board.imageToWorld(crop, Math.min(a.x0, a.x1), Math.min(a.y0, a.y1));
      const q = board.imageToWorld(crop, Math.max(a.x0, a.x1), Math.max(a.y0, a.y1));
      box = { x: p.x, y: p.y, w: Math.max(10, q.x - p.x), h: Math.max(10, q.y - p.y) };
    }
    const old = m.areas.find((x) => x.id === String(a.id));
    if (old) {
      if (a.name) old.name = String(a.name).slice(0, 60);
      if (a.purpose) old.purpose = String(a.purpose).slice(0, 160);
      if (Array.isArray(a.uses)) old.uses = a.uses.map(String).slice(0, 6);
      if (box) Object.assign(old, union(old.w ? old : null, box));
    } else if (box) {
      m.areas.push({ id: String(a.id).slice(0, 20), name: String(a.name || a.id).slice(0, 60), purpose: String(a.purpose || '').slice(0, 160), uses: Array.isArray(a.uses) ? a.uses.map(String).slice(0, 6) : [], ...box });
    } else continue;
    n++;
  }
  if (Array.isArray(upd.open)) { m.open = upd.open.map((s) => String(s).slice(0, 160)).filter(Boolean).slice(0, 8); n++; }
  if (m.areas.length > 14) m.areas.splice(0, m.areas.length - 14);
  return n;
}

// What was said recently in the panel (questions and answers), so watching knows the conversation.
export function recentConversation(sessions) {
  const chat = (sessions?.chat || []).filter((c) => c.role === 'user' || c.role === 'assistant').slice(-4);
  if (!chat.length) return 'none';
  return chat.map((c) => `${c.role === 'user' ? 'User' : 'You'}: ${String(c.md).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
}

// Remarks: what Claude has noticed on this page, when it was (or will be) said.
export function remarksOf(page) { return (page.remarks ||= []); }

export function addRemark(page, r) {
  const list = remarksOf(page);
  list.push({ t: Date.now(), ...r });
  if (list.length > 30) list.splice(0, list.length - 30);
}

export const dismissedOf = (page) => (page.dismissed ||= []);
export function noteDismissed(page, notes) {
  const d = dismissedOf(page);
  for (const n of notes) if (n && !d.includes(n)) d.push(String(n).slice(0, 160));
  if (d.length > 15) d.splice(0, d.length - 15);
}

// For a question: the map and remarks in the answer's own picture coordinates.
export function awarenessForQuestion(board, page, snap) {
  const m = mapOf(page);
  const out = {};
  if (m.goal) out.goal = m.goal;
  if (m.areas.length) out.areas = m.areas.map((a) => ({ name: a.name, purpose: a.purpose, uses: a.uses?.length ? a.uses.map((id) => m.areas.find((x) => x.id === id)?.name || id) : undefined, at: board.rectToImage(snap, a) }));
  if (m.open.length) out.open_points = m.open;
  const rem = remarksOf(page).slice(-8).map((r) => ({ remark: r.text, said: r.delivered ? 'yes' : r.urgency === 'ask' ? 'kept for when asked' : 'waiting for a pause' }));
  if (rem.length) out.watching_remarks = rem;
  const dis = dismissedOf(page);
  if (dis.length) out.user_dismissed = dis.slice(-6);
  return Object.keys(out).length ? out : undefined;
}
