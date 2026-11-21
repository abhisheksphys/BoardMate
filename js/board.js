// The ink board: Pencil/pressure strokes, eraser, select/move, pan/zoom, pages, undo,
// typeset AI blocks, margin marks, and image snapshots for Claude.
import { emit, uid, union, sleep } from './bus.js';
import { settings, writingSettings } from './settings.js';
import { texToImage, lineToTex, wrapTokens } from './mathrender.js';
import { cachedBg, renderBg, bgNeedsBetter, thumbBg } from './pdfbg.js';

const FONT = '-apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
const r1 = (v) => Math.round(v * 10) / 10;
const dist = (a, b) => Math.hypot(a.sx - b.sx, a.sy - b.sy);
const mid = (a, b) => ({ sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normRect = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

// Character height of some handwriting ≈ median stroke height, ignoring dots and long flat strokes (fraction
// bars, underlines); handwritten letters average about 0.6 of the typeset font size. Returns a font size or null.
function sizeOf(strokes) {
  const hs = (strokes || [])
    .map((s) => { const b = strokeBBox(s); const pad = s.width * 1.5; return { h: b.h - 2 * pad, w: b.w - 2 * pad }; })
    .filter((d) => d.h >= 4 && !(d.w > 4 * d.h && d.h < 10))
    .map((d) => d.h)
    .sort((a, b) => a - b);
  if (hs.length < 2) return null;
  const lo = Math.floor(hs.length * 0.15), hi = Math.ceil(hs.length * 0.85);
  const core = hs.slice(lo, Math.max(lo + 1, hi));
  return Math.max(12, Math.min(96, core[Math.floor(core.length / 2)] / 0.6));
}

// How thick your ink actually is (median over strokes, with your typical pressure).
function inkWidth(strokes) {
  const ws = (strokes || []).slice(-60).map((s) => {
    const ps = s.points || [];
    const p = ps.length ? ps.reduce((a, q) => a + (q[2] ?? 0.5), 0) / ps.length : 0.5;
    return s.width * (0.55 + 0.9 * p);
  }).sort((a, b) => a - b);
  return ws.length ? Math.round(ws[Math.floor(ws.length / 2)] * 10) / 10 : 0;
}

// The colour you write in most there (by amount of ink).
function inkColor(strokes) {
  const n = new Map();
  for (const s of (strokes || []).slice(-80)) n.set(s.color, (n.get(s.color) || 0) + (s.points?.length || 1));
  let best = null, bn = 0;
  for (const [c, k] of n) if (k > bn) { best = c; bn = k; }
  return best;
}

// Lasso selections carry their outline (path, world points) as well as their bounding box (x, y, w, h).
export function inPolygon(pt, path) {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const [xi, yi] = path[i], [xj, yj] = path[j];
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const inSelection = (sel, pt) => !!sel && pt.x >= sel.x && pt.x <= sel.x + sel.w && pt.y >= sel.y && pt.y <= sel.y + sel.h && (!sel.path || inPolygon(pt, sel.path));
function tracePath(ctx, path) {
  ctx.beginPath();
  path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

export // a darker shade of a #rrggbb colour (headings)
function darker(c, k = 0.35) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ''));
  if (!m) return c;
  const n = parseInt(m[1], 16);
  const ch = (v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0');
  return `#${ch(n >> 16)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

function strokeBBox(s) {
  if (s._bb) return s._bb;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  const pad = s.width * 1.5;
  s._bb = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  return s._bb;
}

// Cuts the part of stroke s that lies inside circle (c, r). Returns null if the circle doesn't touch it,
// otherwise the remaining pieces (possibly none). Cuts land exactly on the circle edge, so erasing looks natural.
export function clipStroke(s, c, r) {
  const pts = s.points;
  const r2 = r * r;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  let touched = false;
  const pieces = [];
  let cur = [];
  if ((pts[0][0] - c.x) ** 2 + (pts[0][1] - c.y) ** 2 < r2) touched = true;
  else cur.push(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - c.x, fy = a[1] - c.y;
    const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r2;
    let t0 = 1, t1 = 0;
    if (A > 1e-9) {
      const disc = B * B - 4 * A * C;
      if (disc > 0) { const sq = Math.sqrt(disc); t0 = (-B - sq) / (2 * A); t1 = (-B + sq) / (2 * A); }
    } else if (C < 0) { t0 = 0; t1 = 1; }
    const enter = Math.max(0, t0), exit = Math.min(1, t1);
    if (enter < exit) {
      touched = true;
      if (enter > 0) cur.push(lerp(a, b, enter));
      if (cur.length) pieces.push(cur);
      cur = exit < 1 ? [lerp(a, b, exit), b] : [];
    } else {
      cur.push(b);
    }
  }
  if (cur.length) pieces.push(cur);
  if (!touched) return null;
  return pieces
    .filter((p) => p.length >= 2 && p.some((q, i) => i && Math.hypot(q[0] - p[0][0], q[1] - p[0][1]) > 0.3))
    .map((points) => ({ id: uid(), points: points.map((q) => [r1(q[0]), r1(q[1]), q[2]]), color: s.color, width: s.width }));
}

const halfWidth = (s, p) => (s.width * (0.55 + 0.9 * (p ?? 0.5))) / 2;

// Path through points, smoothed with quadratic curves between midpoints.
function smoothThrough(ctx, P, start) {
  if (start) ctx.moveTo(P[0][0], P[0][1]);
  else ctx.lineTo(P[0][0], P[0][1]);
  for (let i = 1; i < P.length - 1; i++) ctx.quadraticCurveTo(P[i][0], P[i][1], (P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2);
  ctx.lineTo(P[P.length - 1][0], P[P.length - 1][1]);
}

// Draws a stroke as ONE filled outline with pressure-varying width and round ends (how ink apps render),
// instead of many small overlapping segments. `extra` = predicted points shown ahead of the Pencil tip.
export function drawStroke(ctx, s, extra) {
  const pts = extra?.length ? s.points.concat(extra) : s.points;
  const n = pts.length;
  if (!n) return;
  ctx.fillStyle = s.color;
  if (n < 3) {
    ctx.strokeStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineWidth = halfWidth(s, pts[0][2]) * 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
    ctx.stroke();
    return;
  }
  const L = [], R = [], corners = [];
  let pdx = 0, pdy = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const r = halfWidth(s, pts[i][2]);
    L.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    R.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
    if (i > 1 && dx * pdx + dy * pdy < 0.6) corners.push([pts[i - 1], halfWidth(s, pts[i - 1][2])]); // sharp turn
    pdx = dx; pdy = dy;
  }
  const end = pts[n - 1], start = pts[0];
  const aEnd = Math.atan2(L[n - 1][1] - end[1], L[n - 1][0] - end[0]);
  const aStart = Math.atan2(R[0][1] - start[1], R[0][0] - start[0]);
  ctx.beginPath();
  smoothThrough(ctx, L, true);
  ctx.arc(end[0], end[1], halfWidth(s, end[2]), aEnd, aEnd - Math.PI, true); // round end
  smoothThrough(ctx, R.reverse(), false);
  ctx.arc(start[0], start[1], halfWidth(s, start[2]), aStart, aStart - Math.PI, true); // round start
  ctx.closePath();
  ctx.fill();
  // fill sharp corners so the outline never shows a notch
  for (const [p, r] of corners) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
  }
}

const MARK_STYLE = {
  ok: { color: '#1f8a4c', sym: '✓' },
  warn: { color: '#c77700', sym: '!' },
  error: { color: '#d0312d', sym: '✗' },
  note: { color: '#1a5fd0', sym: 'i' },
};

// Notebook sessions: fixed-size pages (world units: 96 per inch), shown whole and flipped like GoodNotes.
export const PAGE_SIZES = { A4: [794, 1123], A5: [559, 794], Letter: [816, 1056], Square: [900, 900] };
const PAGE_MARGIN = 16; // screen px around a page shown whole
const PAGE_GAP = 28; // screen px between pages while flipping
const PAGE_INSET = 24; // world px Claude's writing keeps from the page edge
// Spring resistance past the last (or first) page: follows the finger less and less, never beyond `limit`.
const spring = (d, limit) => Math.sign(d) * limit * (1 - Math.exp(-Math.abs(d) / limit));

function drawMark(ctx, m, z) {
  const st = MARK_STYLE[m.kind] || MARK_STYLE.note;
  const r = 11 / z;
  ctx.save();
  ctx.beginPath();
  ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2 / z;
  ctx.strokeStyle = st.color;
  ctx.stroke();
  ctx.fillStyle = st.color;
  ctx.font = `bold ${13 / z}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(st.sym, m.x, m.y + 0.5 / z);
  ctx.restore();
}

export class Board {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    // Live layer on top: the stroke being drawn, eraser circle, selection, marks. Redrawing it is cheap,
    // so the page layer underneath is only touched when ink is committed or the view changes.
    this.o = document.createElement('canvas');
    this.o.className = 'live-layer';
    canvas.after(this.o);
    this.octx = this.o.getContext('2d', { desynchronized: true }) || this.o.getContext('2d');
    this.pendingRegion = null;
    this.pendingStrokes = [];
    this.needFull = false;
    this.pages = [];
    this.pi = 0;
    this.tool = 'pen';
    this.locked = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.touches = new Map();
    this.drawing = null;
    this.gesture = null;
    this.dirty = null;
    this.penSeen = false;
    this.layouts = new Map(); // block id -> rendered layout
    this.noImageBlocks = false;
    this.layout = null; // null = freeform; { size, orient, scroll, paper } = notebook
    this.slide = 0; // notebook: screen px the pages are shifted while flipping
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bindInput();
  }

  // (safety net: if the page index ever points past the end, e.g. after a session switch, use the nearest page)
  get page() {
    const p = this.pages[this.pi];
    if (p || !this.pages.length) return p;
    this.pi = Math.max(0, Math.min(this.pi | 0, this.pages.length - 1));
    return this.pages[this.pi];
  }

  // Runs fn with page p as the board's page for a moment, synchronously (nothing else can run in between),
  // then switches back to whatever page was showing. Lay the page's blocks out first (layoutPage).
  withPageSync(p, fn) {
    const showing = this.page;
    const i = this.pages.indexOf(p);
    if (i < 0) return null;
    this.pi = i;
    try { return fn(p); }
    finally { const k = this.pages.indexOf(showing); this.pi = k >= 0 ? k : Math.max(0, Math.min(this.pi, this.pages.length - 1)); }
  }

  async layoutPage(p) {
    await Promise.all((p?.blocks || []).map((b) => (this.layouts.has(b.id) ? null : this.layoutBlock(b))));
  }

  newPage(name) {
    const p = { id: uid(), name: name || `Page ${this.pages.length + 1}`, paper: this.layout?.paper || this.sessionPaper || settings.paper, strokes: [], blocks: [], marks: [], notebook: [], view: { ox: 40, oy: 40, z: 1 } };
    this.pages.push(p);
    return p;
  }

  load(pages) {
    this.backStack = [];
    this.pages = Array.isArray(pages) ? pages : [];
    if (!this.pages.length) this.newPage();
    for (const p of this.pages) { p.notebook ||= []; p.marks ||= []; p.blocks ||= []; p.view ||= { ox: 40, oy: 40, z: 1 }; }
    this.goto(0);
  }

  // view: arrive zoomed in (flipping while zoomed keeps the zoom); otherwise a notebook page is shown whole
  goto(i, { view } = {}) {
    if (i < 0 || i >= this.pages.length) return;
    this.pi = i;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.activeBlock = null;
    this.slide = 0;
    if (this.layout) {
      if (view) { Object.assign(this.page.view, view); this.clampView(); }
      else this.fit();
      this.prepareNeighbours();
    }
    this.prepareBlocks();
    this.render();
    emit('page', { page: this.page, index: i, count: this.pages.length });
  }

  addPage() { this.newPage(); this.goto(this.pages.length - 1); this.saveSoon(); }

  // ---------- page management (the Pages overview) ----------
  // Default names ("Page 3") follow the page's position; names you give a page are kept.
  renumber() { this.pages.forEach((p, i) => { if (!p.customName && /^Page \d+$/.test(p.name || 'Page 0')) p.name = `Page ${i + 1}`; }); }

  pagesChanged(keepId) {
    this.renumber();
    const i = this.pages.findIndex((p) => p.id === keepId);
    this.goto(i >= 0 ? i : Math.min(this.pi, this.pages.length - 1));
    emit('changed');
    this.saveSoon();
  }

  insertPage(at) {
    const keep = this.page.id;
    this.newPage();
    const p = this.pages.pop();
    this.pages.splice(Math.max(0, Math.min(at, this.pages.length)), 0, p);
    this.pagesChanged(keep);
    return p;
  }

  duplicatePage(i) {
    const src = this.pages[i];
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = uid();
    for (const b of copy.blocks) b.id = uid(); // its own blocks (laid out separately)
    for (const s of copy.strokes) s.id = uid();
    if (src.customName) copy.name = `${src.name} (copy)`;
    copy.starred = false;
    const keep = this.page.id;
    this.pages.splice(i + 1, 0, copy);
    this.pagesChanged(keep);
    return copy;
  }

  deletePage(i) {
    if (!this.pages[i]) return;
    const keep = this.page.id;
    this.pages.splice(i, 1);
    if (!this.pages.length) this.newPage(); // a session always keeps one page
    this.backStack = (this.backStack || []).filter((e) => this.pages.some((p) => p.id === (e.id ?? e)));
    this.pagesChanged(keep);
  }

  movePage(from, to) {
    if (!this.pages[from] || from === to) return;
    const keep = this.page.id;
    const [p] = this.pages.splice(from, 1);
    this.pages.splice(Math.max(0, Math.min(to, this.pages.length)), 0, p);
    this.pagesChanged(keep);
  }

  toggleStar(i = this.pi) {
    const p = this.pages[i];
    if (!p) return;
    p.starred = !p.starred;
    emit('page', { page: this.page, index: this.pi, count: this.pages.length });
    this.saveSoon();
    return p.starred;
  }

  // Claude moving the view to a place on the board ("take me to where I wrote the Lagrangian"): `rect` in board
  // units on page `i` (default: this page). zoom: 'close' fills the screen with it, 'normal' shows it with some
  // surroundings, 'whole' shows everything (the whole notebook page / everything written). Remembered for Back.
  focusOn(rect, { page = this.pi, zoom = 'normal' } = {}) {
    if (!this.pages[page]) return false;
    (this.backStack ||= []).push({ id: this.page.id, view: { ...this.page.view } });
    if (this.backStack.length > 20) this.backStack.shift();
    if (page !== this.pi) this.goto(page);
    const v = this.page.view;
    let r = rect;
    if (zoom === 'whole' || !r) r = this.layout ? this.pageRect() : this.contentBounds() || this.visibleWorld();
    const margin = zoom === 'close' ? 0.08 : zoom === 'whole' ? 0.04 : 0.3; // share of the screen left around it
    const W = this.w * (1 - 2 * margin), H = this.h * (1 - 2 * margin);
    let z = Math.min(W / Math.max(r.w, 1), H / Math.max(r.h, 1));
    z = Math.max(this.layout ? this.fitZoom() : 0.2, Math.min(zoom === 'close' ? 4 : 2.2, z));
    if (zoom === 'normal') z = Math.min(z, Math.max(v.z, this.layout ? this.fitZoom() * 1.6 : 1.2)); // not closer than needed
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const target = { z, ox: this.w / 2 - cx * z, oy: this.h / 2 - cy * z };
    // a tall target: start at its top rather than its middle
    if (r.h * z > this.h * 0.9) target.oy = this.h * 0.06 - r.y * z;
    this.glideTo(target);
    emit('page', { page: this.page, index: this.pi, count: this.pages.length });
    return true;
  }

  // moves the view smoothly to { z, ox, oy } (notebook: kept on the page)
  glideTo(to) {
    const v = this.page.view, from = { ...v }, t0 = performance.now(), ms = 380;
    cancelAnimationFrame(this.glideRaf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      v.z = from.z + (to.z - from.z) * e;
      v.ox = from.ox + (to.ox - from.ox) * e;
      v.oy = from.oy + (to.oy - from.oy) * e;
      if (k >= 1) this.clampView();
      this.render();
      if (k < 1) this.glideRaf = requestAnimationFrame(step);
      else { this.prepareNeighbours?.(); this.saveSoon(); }
    };
    this.glideRaf = requestAnimationFrame(step);
  }

  // A jump (overview, page number, search, Claude) remembers where you were, for the Back button.
  // Swiping to the next page is not a jump.
  jumpTo(i, { remember = true } = {}) {
    if (!this.pages[i] || i === this.pi) return;
    if (remember) { (this.backStack ||= []).push(this.page.id); if (this.backStack.length > 20) this.backStack.shift(); }
    if (this.layout && Math.abs(i - this.pi) === 1 && !remember) this.flipTo(i - this.pi);
    else this.goto(i);
  }

  // Back: to the page (and, after Claude moved the view, the exact spot and zoom) you were at before the jump.
  // Entries are page ids, or { id, view } for a spot on a page.
  goBack() {
    while (this.backStack?.length) {
      const e = this.backStack.pop();
      const i = this.pages.findIndex((p) => p.id === (e.id ?? e));
      if (i < 0) continue;
      if (e.view) {
        if (i !== this.pi) this.goto(i, { view: e.view });
        else this.glideTo(e.view);
        emit('page', { page: this.page, index: this.pi, count: this.pages.length });
        return true;
      }
      if (i !== this.pi) { this.goto(i); return true; }
    }
    emit('page', { page: this.page, index: this.pi, count: this.pages.length });
    return false;
  }

  // Small picture of a page for the overview: a notebook page as a whole sheet (with its paper),
  // a freeform page as what is written on it. Cached until the page changes.
  async thumbnail(i, width = 220) {
    const p = this.pages[i];
    if (!p) return null;
    const last = p.strokes[p.strokes.length - 1];
    const stamp = `${p.strokes.length}:${last?.id || ''}:${last?.points?.length || 0}:${p.blocks.length}:${p.blocks.map((b) => `${b.x | 0},${b.y | 0},${b.w | 0}`).join(';')}:${p.paper}:${p.bg ? `${p.bg.pdf}#${p.bg.page}` : this.layout ? `${this.layout.size}${this.layout.orient}` : 'free'}`;
    let bgImg = null;
    if (p.bg) { try { bgImg = await thumbBg(p.bg, width * 2); } catch {} }
    this.thumbs ||= new Map();
    const hit = this.thumbs.get(p.id);
    if (hit?.stamp === stamp) return hit.url;
    await this.layoutPage(p);
    return this.withPageSync(p, () => {
      let bb;
      if (this.layout) bb = this.pageRect();
      else {
        const cb = this.contentBounds();
        bb = cb ? { x: cb.x - 30, y: cb.y - 30, w: cb.w + 60, h: cb.h + 60 } : { x: 0, y: 0, w: 800, h: 600 };
        const ratio = 1.3; // keep tiles a similar shape: pad the short side
        if (bb.h / bb.w < ratio) { const nh = bb.w * ratio; bb.y -= (nh - bb.h) / 2; bb.h = nh; }
        else { const nw = bb.h / ratio; bb.x -= (nw - bb.w) / 2; bb.w = nw; }
      }
      const scale = width / bb.w;
      const cv = document.createElement('canvas');
      cv.width = Math.round(bb.w * scale);
      cv.height = Math.round(bb.h * scale);
      const ctx = cv.getContext('2d');
      const paint = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (bgImg) ctx.drawImage(bgImg, 0, 0, cv.width, cv.height);
        this.skipBg = !!p.bg;
        try { this.drawContent(ctx, { z: scale, ox: -bb.x * scale, oy: -bb.y * scale }, 1, bb, true); }
        finally { this.skipBg = false; }
      };
      paint();
      let url;
      try { url = cv.toDataURL('image/jpeg', 0.8); }
      catch { this.noImageBlocks = true; paint(); this.noImageBlocks = false; url = cv.toDataURL('image/jpeg', 0.8); }
      this.thumbs.set(p.id, { stamp, url });
      return url;
    });
  }

  // ---------- geometry ----------
  resize() {
    const r = this.c.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.c.width = Math.max(1, Math.round(r.width * this.dpr));
    this.c.height = Math.max(1, Math.round(r.height * this.dpr));
    this.c.style.width = r.width + 'px';
    this.c.style.height = r.height + 'px';
    this.o.width = this.c.width;
    this.o.height = this.c.height;
    this.o.style.width = r.width + 'px';
    this.o.style.height = r.height + 'px';
    if (this.page) { this.clampView(); this.render(); }
  }

  evtPos(e) {
    const r = this.c.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  toWorld(sx, sy) {
    const v = this.page.view;
    return { x: (sx - v.ox) / v.z, y: (sy - v.oy) / v.z };
  }

  visibleWorld() {
    const a = this.toWorld(0, 0), b = this.toWorld(this.w, this.h);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  contentBounds() {
    if (!this.page) return null;
    let bb = null;
    for (const s of this.page.strokes) bb = union(bb, strokeBBox(s));
    for (const b of this.page.blocks) bb = union(bb, { x: b.x, y: b.y, w: b.w || 200, h: b.h || 40 });
    return bb;
  }

  zoomAt(sx, sy, factor) {
    const v = this.page.view;
    const z = clamp(v.z * factor, 0.2, 6);
    const wx = (sx - v.ox) / v.z, wy = (sy - v.oy) / v.z;
    v.z = z;
    v.ox = sx - wx * z;
    v.oy = sy - wy * z;
    this.clampView();
    this.render();
  }

  // ---------- notebook pages ----------
  setLayout(layout) {
    this.layout = layout ? { size: layout.size || 'A4', orient: layout.orient || 'portrait', scroll: layout.scroll || 'vertical', paper: layout.paper || 'ruled', ...(layout.pdf ? { pdf: layout.pdf } : {}) } : null;
    this.slide = 0;
    if (this.page) { if (this.layout) this.fit(); this.render(); }
  }

  // A page from a PDF keeps that page's own size; blank pages use the notebook's page setup.
  pageSize(page = this.page) {
    if (page?.bg) return { w: page.bg.w, h: page.bg.h };
    const [a, b] = PAGE_SIZES[this.layout?.size] || PAGE_SIZES.A4;
    return this.layout?.orient === 'landscape' ? { w: b, h: a } : { w: a, h: b };
  }

  pageRect(page = this.page) { const s = this.pageSize(page); return { x: 0, y: 0, w: s.w, h: s.h }; }

  fitZoom(page = this.page) {
    const s = this.pageSize(page);
    return Math.max(0.05, Math.min((this.w - 2 * PAGE_MARGIN) / s.w, (this.h - 2 * PAGE_MARGIN) / s.h));
  }

  // the whole page, centred
  fit() {
    if (!this.layout || !this.page) return;
    const v = this.page.view, s = this.pageSize(), z = this.fitZoom();
    v.z = z;
    v.ox = (this.w - s.w * z) / 2;
    v.oy = (this.h - s.h * z) / 2;
  }

  atFit() { return !!this.layout && this.page.view.z <= this.fitZoom() * 1.02; }

  // Notebook: never smaller than the whole page; zoomed in, the page always covers the screen.
  clampView() {
    if (!this.layout || !this.page) return;
    const v = this.page.view, s = this.pageSize();
    if (v.z <= this.fitZoom() * 1.02) return this.fit();
    const axis = (size, screen, o) => (size * v.z <= screen - 2 * PAGE_MARGIN ? (screen - size * v.z) / 2 : clamp(o, screen - PAGE_MARGIN - size * v.z, PAGE_MARGIN));
    v.ox = axis(s.w, this.w, v.ox);
    v.oy = axis(s.h, this.h, v.oy);
  }

  vertical() { return this.layout?.scroll !== 'horizontal'; }

  // screen distance from one page to the next while flipping
  // (pages can differ in size, e.g. a blank A4 page between PDF pages: neighbours are drawn at the same zoom,
  // and the step is from this page's edge to the neighbour's edge)
  pageStep(dir = 1) {
    const v = this.vertical(), z = this.page.view.z;
    const span = (p) => { const s = this.pageSize(p); return (v ? s.h : s.w) * z; };
    const other = this.pages[this.pi + (dir < 0 ? -1 : 1)];
    if (dir < 0 && other) return span(other) + PAGE_GAP;
    return span(this.page) + PAGE_GAP;
  }

  prepareNeighbours() {
    for (const k of [-1, 1]) {
      const p = this.pages[this.pi + k];
      if (p) for (const b of p.blocks) if (!this.layouts.has(b.id)) this.layoutBlock(b);
      // PDF pages: render the neighbours' backgrounds ahead, so flipping shows them sharp
      if (p?.bg) { const px = p.bg.w * this.page.view.z * this.dpr; if (bgNeedsBetter(p.bg, px)) renderBg(p.bg, px).catch(() => {}); }
    }
    if (this.page?.bg) { const px = this.page.bg.w * this.page.view.z * this.dpr; if (bgNeedsBetter(this.page.bg, px)) renderBg(this.page.bg, px).then(() => this.render()).catch(() => {}); }
  }

  // Slide to the next (+1) or previous (-1) page, or back (0), and settle there: a page is never left half in view.
  // Zoomed in, the zoom is kept: going forward you land at the top of the next page, going back at the bottom
  // of the previous one (like scrolling through a document).
  flipTo(dir) {
    const v = this.page.view, vert = this.vertical();
    const zoomed = !this.atFit();
    let target = dir === 0 || !this.pages[this.pi + dir] ? 0 : -dir * this.pageStep(dir);
    let arrive = null;
    if (zoomed && target !== 0) {
      const next = this.pages[this.pi + dir], ns = this.pageSize(next), cs = this.pageSize();
      const o = vert ? v.oy : v.ox, screen = vert ? this.h : this.w, span = (vert ? ns.h : ns.w) * v.z;
      // where the new page's leading edge should end up on screen
      const dest = span <= screen - 2 * PAGE_MARGIN ? (screen - span) / 2 : dir > 0 ? PAGE_MARGIN : screen - PAGE_MARGIN - span;
      const now = dir > 0 ? o + this.pageStep(1) : o - this.pageStep(-1); // its edge now (slide 0)
      target = dest - now;
      const cross = vert ? v.ox + ((cs.w - ns.w) * v.z) / 2 : v.oy + ((cs.h - ns.h) * v.z) / 2;
      arrive = vert ? { z: v.z, ox: cross, oy: dest } : { z: v.z, ox: dest, oy: cross };
    }
    const from = this.slide, t0 = performance.now(), ms = 220;
    cancelAnimationFrame(this.flipRaf);
    const stepFn = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      this.slide = from + (target - from) * e;
      this.render();
      if (k < 1) { this.flipRaf = requestAnimationFrame(stepFn); return; }
      this.flipRaf = null;
      if (target !== 0) { this.slide = 0; this.goto(this.pi + dir, arrive ? { view: arrive } : {}); this.saveSoon(); }
      else { this.slide = 0; this.render(); }
    };
    this.flipRaf = requestAnimationFrame(stepFn);
  }

  // An image of another page (for Claude), without showing it: its blocks are laid out first.
  async pageSnapshot(i, opts = {}) {
    const p = this.pages[i];
    await this.bgReady(p);
    await this.layoutPage(p);
    return this.withPageSync(p, () => ({ snap: this.snapshot(opts), page: p }));
  }

  // Keeps something Claude wrote (or a picture) on the page; writing that no longer fits continues on the next page.
  async keepOnPage(b) {
    if (!this.layout || !b) return null;
    const s = this.pageSize(), m = this.inset(), mv = this.insetV(); // left/right, top/bottom
    if (b.kind !== 'image' && !b.maxW) { this.fitToArea(b); this.layouts.delete(b.id); await this.layoutBlock(b); }
    if ((b.w || 0) > s.w - 2 * m) await this.scaleBlock(b.id, (s.w - 2 * m) / b.w);
    b.x = clamp(b.x, m, Math.max(m, s.w - m - (b.w || 0)));
    b.y = Math.max(mv, b.y);
    if (b.y + (b.h || 0) <= s.h - mv || b.kind === 'image') {
      b.y = Math.min(b.y, Math.max(mv, s.h - mv - (b.h || 0)));
      this.render();
      this.saveSoon();
      return null;
    }
    // Too long for what is left of the page: the lines that fit stay here, the rest continues at the top of the
    // next page (a new blank page when there is none, or when the next one is a PDF page), page after page.
    const lay = this.layouts.get(b.id);
    const avail = s.h - mv - b.y;
    let fit = 0;
    if (lay && b.lines?.length > 1) {
      for (let k = 1; k <= b.lines.length; k++) {
        const its = lay.items.filter((it) => it.li !== undefined && it.li < k);
        const bottom = its.length ? Math.max(...its.map((it) => it.y + it.h)) : 0;
        if (bottom <= avail) fit = k; else break;
      }
    }
    if (!fit && b.y <= mv + 4) fit = 1; // even one line is taller than a page: keep it here rather than loop
    const from = this.pi;
    let rest = null;
    if (fit && fit < (b.lines?.length || 0)) {
      rest = { ...b, id: uid(), lines: b.lines.slice(fit) };
      delete rest.w; delete rest.h;
      b.lines = b.lines.slice(0, fit);
      this.layouts.delete(b.id);
      await this.layoutBlock(b);
    } else if (fit) { this.render(); this.saveSoon(); return null; }
    else { rest = b; this.page.blocks.splice(this.page.blocks.indexOf(b), 1); }
    this.render();
    if (from + 1 >= this.pages.length) this.newPage();
    else if (this.pages[from + 1].bg) { const np = this.newPage(); this.pages.pop(); this.pages.splice(from + 1, 0, np); this.renumber(); emit('changed'); }
    const next = this.pages[from + 1];
    let bottom = mv;
    const gp = this.blockGap(b.fontPx || 22);
    for (const st of next.strokes) { const bb = strokeBBox(st); bottom = Math.max(bottom, bb.y + bb.h + gp); }
    for (const x of next.blocks) bottom = Math.max(bottom, x.y + (x.h || 0) + gp);
    rest.y = bottom;
    const anim = this.anims?.get(b.id);
    if (anim) await this.animationsDone(); // finish writing on this page before turning to the next
    next.blocks.push(rest);
    this.goto(from + 1);
    if (rest !== b) { await this.layoutBlock(rest); this.pushUndo({ add: { blocks: [rest] } }); }
    if (anim) this.animate(rest, anim.per, anim.signal);
    this.markDirty({ x: rest.x, y: rest.y, w: rest.w || 0, h: rest.h || 0 }, { ai: rest.author !== 'user' });
    this.saveSoon();
    const more = await this.keepOnPage(rest); // it may need yet another page
    return { page: more?.page ?? from + 1 };
  }

  ensureVisible(rect) {
    const vis = this.visibleWorld();
    const inside = rect.x >= vis.x && rect.y >= vis.y && rect.x + rect.w <= vis.x + vis.w && rect.y + rect.h <= vis.y + vis.h;
    if (inside) return;
    const v = this.page.view;
    v.ox = this.w * 0.15 - rect.x * v.z;
    v.oy = this.h * 0.2 - rect.y * v.z;
    this.clampView();
    this.render();
  }

  // ---------- input ----------
  bindInput() {
    const c = this.c;
    c.style.touchAction = 'none';
    // Stop iOS from claiming Pencil/finger touches for its own gestures (scroll, zoom, text magnifier),
    // which makes Safari cancel or drop quick strokes. Pointer events still arrive normally.
    const block = (e) => { if (e.cancelable) e.preventDefault(); };
    for (const t of ['touchstart', 'touchmove', 'touchend']) c.addEventListener(t, block, { passive: false });
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e, false));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    // A lift that happens over something else (a floating button, the panel) still ends the drag or stroke.
    for (const t of ['pointerup', 'pointercancel']) {
      window.addEventListener(t, (e) => {
        if (e.target === c) return;
        if (this.drawing?.pointerId === e.pointerId || this.touches.has(e.pointerId)) this.onUp(e, t === 'pointercancel');
      }, true);
    }
    c.addEventListener('pointerleave', () => { if (!this.drawing && this.eraserCursor) { this.eraserCursor = null; this.renderLive(); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { sx, sy } = this.evtPos(e);
      if (e.ctrlKey || e.metaKey) this.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.01));
      else if (this.atFit()) {
        // notebook, whole page in view: a scroll flips to the next or previous page
        this.wheelAcc = (this.wheelAcc || 0) + (this.vertical() ? e.deltaY : e.deltaX || e.deltaY);
        clearTimeout(this.wheelTimer);
        this.wheelTimer = setTimeout(() => { this.wheelAcc = 0; }, 250);
        if (Math.abs(this.wheelAcc) > 90 && !this.flipRaf) { const d = Math.sign(this.wheelAcc); this.wheelAcc = 0; this.flipTo(d); }
      } else {
        const v = this.page.view, before = this.vertical() ? v.oy - e.deltaY : v.ox - (e.deltaX || 0);
        v.ox -= e.deltaX; v.oy -= e.deltaY; this.clampView(); this.render();
        if (this.layout) {
          // zoomed in: scrolling on past the page's end turns to the next (previous) page, keeping the zoom
          const over = before - (this.vertical() ? v.oy : v.ox);
          if (Math.abs(over) > 0.5) {
            this.wheelAcc = (this.wheelAcc || 0) - over;
            clearTimeout(this.wheelTimer);
            this.wheelTimer = setTimeout(() => { this.wheelAcc = 0; }, 250);
            if (Math.abs(this.wheelAcc) > 120 && !this.flipRaf) { const d = Math.sign(this.wheelAcc); this.wheelAcc = 0; this.flipTo(d); }
          }
        }
      }
      this.saveSoon();
    }, { passive: false });
  }

  fingerDraws() { return settings.fingerDraws && !this.penSeen; }

  onDown(e) {
    if (e.pointerType === 'pen') this.penSeen = true;
    emit('user-input');
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.evtPos(e));
      // a quick two-finger tap (no pinch, no drag) switches to the last tool: watch for one
      if (this.touches.size >= 2) this.multiTouch = true; // not a one-finger tap any more
      if (this.touches.size === 2) this.tap2 = { t: performance.now(), start: new Map(this.touches), view: { ...this.page.view }, ok: true };
      else if (this.touches.size > 2) this.tap2 = null;
      try { this.c.setPointerCapture(e.pointerId); } catch {}
      // Select tool: one finger on an image or block grabs it (move, or resize at the corner handle);
      // one finger on empty space still pans, two fingers still zoom.
      const grabs = this.touches.size === 1 && this.tool === 'select' && !this.locked && this.grabbable(e);
      if (grabs) this.touches.delete(e.pointerId);
      else if (!this.fingerDraws() || this.touches.size >= 2) {
        const d = this.drawing;
        if (d && d.pointerType === 'touch') {
          // a second finger arrived: put a half-dragged item back, then zoom/pan
          if (d.move) Object.assign(d.move, d.from);
          if (d.resize) Object.assign(d.resize, d.from);
          this.drawing = null;
          this.render();
        }
        this.startGesture();
        return;
      } else this.touches.delete(e.pointerId); // single finger drawing
    }
    if (this.drawing) {
      // The previous stroke's pen-up never arrived (it happens with very fast writing):
      // keep that stroke and start the new one, instead of ignoring the new one.
      if (this.drawing.stroke) this.finishStroke(this.drawing);
      // a drag (move, resize, select, lasso) whose lift was lost: finish it, so the board never stays frozen
      else if (this.drawing.pointerId !== e.pointerId) this.onUp({ pointerId: this.drawing.pointerId, pointerType: this.drawing.pointerType, clientX: e.clientX, clientY: e.clientY }, false);
      else return;
    }
    try { this.c.setPointerCapture(e.pointerId); } catch {}
    const p = this.evtPos(e);
    const w = this.toWorld(p.sx, p.sy);

    const mk = this.hitMark(w);
    if (mk && this.tool !== 'eraser') { emit('mark', mk); return; }

    if (this.locked) { emit('locked-tap'); return; }
    clearTimeout(this.settleTimer);

    const base = { pointerId: e.pointerId, pointerType: e.pointerType };
    if (this.tool === 'pen') {
      this.drawing = { ...base, stroke: { id: uid(), points: [[r1(w.x), r1(w.y), e.pressure || 0.5]], color: settings.penColor, width: settings.penWidth } };
    } else if (this.tool === 'eraser') {
      this.drawing = { ...base, erase: true, removed: { strokes: [], blocks: [], marks: [] }, added: new Map(), dirty: null };
      this.eraserCursor = w;
      this.eraseAt(w);
    } else if (this.tool === 'select') {
      const a = this.activeBlock;
      const handle = a && this.page.blocks.includes(a) ? this.hitHandle(a, w, e.pointerType === 'touch') : null;
      if (handle) {
        // a corner: resize, keeping proportions, the opposite corner stays put (Claude's blocks get a new letter
        // size on release); the left/right edge of Claude's blocks: the width, text rewraps, letters stay the size
        this.drawing = { ...base, resize: a, handle, from: { x: a.x, y: a.y, w: a.w, h: a.h, fontPx: a.fontPx, strokePx: a.strokePx, maxW: a.maxW, fixedW: a.fixedW }, start: w };
      } else {
        const b = this.hitBlock(w, e.pointerType === 'touch');
        const wasActive = !!b && this.activeBlock === b;
        if (!b || !wasActive) this.barOpen = false; // a newly selected block starts without its bar
        this.activeBlock = b;
        if (b) this.drawing = { ...base, move: b, from: { x: b.x, y: b.y }, start: w, wasActive };
        else this.drawing = { ...base, sel: { x0: w.x, y0: w.y } };
      }
    } else if (this.tool === 'lasso') {
      this.drawing = { ...base, lasso: [[w.x, w.y]] };
    }
    this.renderLive();
  }

  // Dragging the left or right edge of one of Claude's text blocks: a new width; the text rewraps as you drag
  // (letters keep their size). It stays within the page (notebook) and is never narrower than a few words.
  dragWidth(d, w) {
    const b = d.resize, fw = d.from.w || 100, fs = b.fontPx || 22;
    const area = this.layout ? this.writeArea() : null;
    let newW = d.handle === 'e' ? fw + (w.x - d.start.x) : fw - (w.x - d.start.x);
    newW = Math.max(fs * 5, newW);
    if (area) newW = Math.min(newW, d.handle === 'e' ? area.right - d.from.x : d.from.x + fw - area.left);
    d.newW = newW;
    d.guideX = d.handle === 'e' ? d.from.x + newW : d.from.x + fw - newW;
    if (d.handle === 'w') b.x = d.guideX;
    // rewrap live, one layout at a time (each one is quick: the typeset pieces are cached)
    if (!d.laying) {
      d.laying = true;
      const target = newW;
      this.relayoutWidth(b, target).finally(() => {
        d.laying = false;
        if (this.drawing === d && d.newW !== target) this.dragWidth(d, d.lastW || w);
      });
    }
    d.lastW = w;
  }

  // Lay a text block out again at width `width` (null: as it was set before), its own width from now on
  // (not the preferred column width of the writing style).
  async relayoutWidth(b, width) {
    if (width) { b.maxW = width; b.fixedW = true; }
    await this.layoutBlock(b); // replaces the old layout when done (no flicker meanwhile)
    this.render();
  }

  // Handles of the selected block: four corners (size) and, on Claude's text blocks, the middle of the left and
  // right edges (width). Returns 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e' or null.
  handlesOf(b) {
    const x0 = b.x, x1 = b.x + (b.w || 100), y0 = b.y, y1 = b.y + (b.h || 30), ym = (y0 + y1) / 2;
    const hs = [['se', x1, y1], ['sw', x0, y1], ['ne', x1, y0], ['nw', x0, y0]];
    if (b.kind !== 'image') hs.push(['e', x1, ym], ['w', x0, ym]);
    return hs;
  }

  hitHandle(b, w, finger = false) {
    const r = (finger ? 34 : 24) / this.page.view.z; // a fingertip needs a bigger target than the Pencil
    let best = null, bd = r;
    for (const [id, hx, hy] of this.handlesOf(b)) { const d = Math.hypot(w.x - hx, w.y - hy); if (d < bd) { bd = d; best = id; } }
    return best;
  }

  grabbable(e) {
    const p = this.evtPos(e);
    const w = this.toWorld(p.sx, p.sy);
    const a = this.activeBlock;
    return (a && this.page.blocks.includes(a) && this.hitHandle(a, w, true)) || !!this.hitBlock(w, true);
  }

  // The bar over a selected block (Select tool): its screen rect, or null when it should be hidden.
  updateBlockBar() {
    const b = this.barOpen && this.tool === 'select' && this.activeBlock && this.page.blocks.includes(this.activeBlock) && !this.drawing?.move && !this.drawing?.resize ? this.activeBlock : null;
    let r = null;
    if (b) { const v = this.page.view; r = { x: b.x * v.z + v.ox, y: b.y * v.z + v.oy, w: (b.w || 100) * v.z, h: (b.h || 30) * v.z, image: b.kind === 'image' }; }
    const key = r ? `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}` : '';
    if (key === this.barKey) return;
    this.barKey = key;
    emit('block-bar', r);
  }

  // Duplicate: a copy just below (new id), selected, one undo step.
  async duplicateActiveBlock() {
    const b = this.activeBlock;
    if (!b || !this.page.blocks.includes(b)) return null;
    const c = structuredClone({ ...b });
    c.id = uid();
    c.y = b.y + (b.h || 30) + this.blockGap(b.fontPx || 22);
    this.page.blocks.push(c);
    await this.layoutBlock(c);
    this.pushUndo({ add: { blocks: [c] } });
    this.activeBlock = c;
    this.markDirty({ x: c.x, y: c.y, w: c.w || 1, h: c.h || 1 }, { ai: c.author !== 'user' });
    if (this.layout) await this.keepOnPage(c);
    this.render();
    this.saveSoon();
    return c;
  }

  // The selected block as the selection (for "Ask")
  selectActiveBlock() {
    const b = this.activeBlock;
    if (!b) return;
    const pad = 6;
    this.selection = { x: b.x - pad, y: b.y - pad, w: (b.w || 100) + 2 * pad, h: (b.h || 30) + 2 * pad };
    emit('selection', this.selection);
    this.renderLive();
  }

  deleteActiveBlock() {
    const b = this.activeBlock;
    if (!b || !this.page.blocks.includes(b)) return false;
    this.page.blocks = this.page.blocks.filter((x) => x !== b);
    this.pushUndo({ remove: { blocks: [b] } });
    this.activeBlock = null;
    this.markDirty({ x: b.x, y: b.y, w: b.w || 1, h: b.h || 1 }, { ai: b.author !== 'user' });
    this.render();
    this.saveSoon();
    return true;
  }

  onMove(e) {
    if (this.touches.has(e.pointerId)) {
      const pos = this.evtPos(e);
      this.touches.set(e.pointerId, pos);
      const s0 = this.tap2?.start.get(e.pointerId);
      if (s0 && Math.hypot(pos.sx - s0.sx, pos.sy - s0.sy) > 12) this.tap2.ok = false;
      this.updateGesture();
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) {
      // Pencil hover / mouse: show the eraser circle before touching down.
      if (!d && this.tool === 'eraser' && e.pointerType !== 'touch') {
        const p = this.evtPos(e);
        this.eraserCursor = this.toWorld(p.sx, p.sy);
        this.renderLive();
      }
      return;
    }
    // Coalesced events: every sample the Pencil produced since the last frame (up to 240 per second).
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) {
      const p = this.evtPos(ev);
      const w = this.toWorld(p.sx, p.sy);
      if (d.stroke) this.addPoint(d.stroke, w, ev.pressure, true);
      else if (d.erase) { this.eraserCursor = w; this.eraseAt(w); }
      else if (d.move) { d.move.x = d.from.x + w.x - d.start.x; d.move.y = d.from.y + w.y - d.start.y; }
      else if (d.resize && (d.handle === 'e' || d.handle === 'w')) this.dragWidth(d, w);
      else if (d.resize) {
        const fw = d.from.w || 100, fh = d.from.h || 30;
        const sx = d.handle.includes('w') ? -1 : 1, sy = d.handle.includes('n') ? -1 : 1;
        // the handle follows the Pencil diagonally: use whichever direction was dragged more
        const k = Math.max((fw + sx * (w.x - d.start.x)) / fw, (fh + sy * (w.y - d.start.y)) / fh);
        const min = Math.max(30 / this.page.view.z / fw, d.resize.kind === 'image' ? 0 : 8 / (d.from.fontPx || 22));
        const max = d.resize.kind === 'image' ? 20 : 160 / (d.from.fontPx || 22);
        d.k = Math.min(max, Math.max(min, k));
        d.resize.w = fw * d.k;
        d.resize.h = fh * d.k;
        // the opposite corner stays where it was
        d.resize.x = sx > 0 ? d.from.x : d.from.x + fw - d.resize.w;
        d.resize.y = sy > 0 ? d.from.y : d.from.y + fh - d.resize.h;
      }
      else if (d.sel) { d.sel.x1 = w.x; d.sel.y1 = w.y; }
      else if (d.lasso) {
        const [lx, ly] = d.lasso[d.lasso.length - 1];
        if (Math.hypot(w.x - lx, w.y - ly) > 3 / this.page.view.z) d.lasso.push([w.x, w.y]);
      }
    }
    if (d.stroke) {
      // Predicted events: where the Pencil is about to be. Drawn ahead of the tip (never saved) to hide latency.
      const pred = settings.inkPrediction && e.getPredictedEvents ? e.getPredictedEvents() : [];
      const last = d.stroke.points[d.stroke.points.length - 1];
      d.predicted = pred.slice(0, 3).map((ev) => { const p = this.evtPos(ev); const w = this.toWorld(p.sx, p.sy); return [w.x, w.y, last[2]]; });
    }
    if (d.move || d.resize) this.render();
    else this.renderLive();
  }

  onUp(e, cancelled) {
    if (this.touches.has(e.pointerId)) {
      const g = this.gesture;
      this.touches.delete(e.pointerId);
      this.gesture = null;
      // one-finger double tap on the page (quick, in the same spot, no other finger involved): the app runs the
      // action chosen for it in Settings
      if (!this.touches.size) {
        const multi = this.multiTouch;
        this.multiTouch = false;
        const p = e.clientX !== undefined ? this.evtPos(e) : null;
        const quick = p && !multi && g?.kind === 'pan' && performance.now() - g.t0 < 260 && Math.hypot(p.sx - g.p0.sx, p.sy - g.p0.sy) < 10;
        if (quick && !this.hitMark(this.toWorld(p.sx, p.sy), true)) {
          const lt = this.lastTap;
          if (lt && performance.now() - lt.t < 350 && Math.hypot(p.sx - lt.sx, p.sy - lt.sy) < 40) {
            this.lastTap = null;
            if (this.slide) { this.slide = 0; this.render(); }
            emit('double-tap', this.toWorld(p.sx, p.sy));
            return;
          }
          this.lastTap = { t: performance.now(), sx: p.sx, sy: p.sy };
        } else this.lastTap = null;
      }
      const t2 = this.tap2;
      if (!this.touches.size && t2) {
        this.tap2 = null;
        if (t2.ok && performance.now() - t2.t < 350) {
          // two-finger tap: undo the tiny zoom/pan the fingers caused, then tell the app
          Object.assign(this.page.view, t2.view);
          this.slide = 0;
          this.pullAdd = false;
          this.render();
          emit('two-finger-tap');
          return;
        }
      }
      if (this.touches.size) { if (this.slide) { this.slide = 0; this.pullAdd = false; this.render(); } this.startGesture(); }
      else if (g?.kind === 'pan' && performance.now() - g.t0 < 350 && e.clientX !== undefined && Math.hypot(this.evtPos(e).sx - g.p0.sx, this.evtPos(e).sy - g.p0.sy) < 10 && this.hitMark(this.toWorld(this.evtPos(e).sx, this.evtPos(e).sy), true)) {
        // a finger tap on a margin mark (not a swipe)
        if (this.slide) { this.slide = 0; this.render(); }
        emit('mark', this.hitMark(this.toWorld(this.evtPos(e).sx, this.evtPos(e).sy), true));
      } else {
        if ((g?.paging || g?.kind === 'pan') && this.pullAdd) {
          // pulled far enough past the last page: a new page springs in
          this.pullAdd = false;
          this.newPage();
          this.flipTo(1);
        } else if (g?.paging) {
          // flip if dragged far enough (or flicked), otherwise settle back on this page
          const fast = Math.abs(this.slide) > 40 && performance.now() - g.t0 < 300;
          const far = Math.abs(this.slide) > this.pageStep() * 0.18;
          this.flipTo(far || fast ? -Math.sign(this.slide) : 0);
        } else if (g?.kind === 'pan' && this.slide) {
          // zoomed in and dragged past the page's end: on to the next (previous) page if pulled far enough
          const fast = Math.abs(this.slide) > 40 && performance.now() - (g.overT0 || 0) < 300;
          const far = Math.abs(this.slide) > Math.min(this.pageStep() * 0.18, 150);
          this.flipTo(far || fast ? -Math.sign(this.slide) : 0);
        }
        this.saveSoon();
      }
      return;
    }
    const d = this.drawing;
    if (!d || d.pointerId !== e.pointerId) return;

    if (d.stroke) {
      // A fast stroke can arrive as just pen-down + pen-up: the pen-up position is the stroke's end.
      const p = this.evtPos(e);
      this.addPoint(d.stroke, this.toWorld(p.sx, p.sy), e.pressure);
      // If iOS cancelled the touch, keep whatever was drawn rather than dropping it.
      if (cancelled && d.stroke.points.length < 2) { this.drawing = null; this.renderLive(); return; }
      this.finishStroke(d);
      return;
    }
    this.drawing = null;
    if (d.erase) {
      if (e.pointerType === 'pen') this.eraserCursor = null; // hover will bring it back if supported
      const r = d.removed;
      const added = [...d.added.values()];
      if (r.strokes.length || r.blocks.length || r.marks.length || added.length) {
        // One undo step restores everything this erase gesture changed.
        this.pushUndo({ remove: r, add: { strokes: added } });
        if (d.dirty) this.markDirty(d.dirty);
      }
    } else if (d.move) {
      // a tap (no real drag) on a block that was already selected shows or hides its bar
      if (Math.hypot(d.move.x - d.from.x, d.move.y - d.from.y) * this.page.view.z < 6) {
        Object.assign(d.move, d.from);
        if (d.wasActive) this.barOpen = !this.barOpen;
      }
      if (d.move.x !== d.from.x || d.move.y !== d.from.y) {
        this.pushUndo({ move: { id: d.move.id, from: d.from, to: { x: d.move.x, y: d.move.y } } });
        this.markDirty({ x: d.move.x, y: d.move.y, w: d.move.w || 1, h: d.move.h || 1 }, { ai: d.move.author !== 'user' });
      }
    } else if (d.resize && (d.handle === 'e' || d.handle === 'w')) {
      const b = d.resize;
      if (d.newW && Math.abs(d.newW - (d.from.maxW || d.from.w)) > 2) {
        this.relayoutWidth(b, d.newW).then(() => {
          this.pushUndo({ move: { id: b.id, from: d.from, to: { x: b.x, y: b.y, w: b.w, h: b.h, fontPx: b.fontPx, strokePx: b.strokePx, maxW: b.maxW, fixedW: true } } });
          this.markDirty({ x: b.x, y: b.y, w: b.w, h: b.h }, { ai: b.author !== 'user' });
          this.render();
          this.saveSoon();
        });
      } else if (d.from.maxW !== b.maxW) { Object.assign(b, { x: d.from.x, maxW: d.from.maxW, fixedW: d.from.fixedW }); this.relayoutWidth(b, null); }
    } else if (d.resize) {
      const b = d.resize;
      if (d.k && Math.abs(d.k - 1) > 0.01) {
        if (b.kind !== 'image') {
          // Claude's text and maths: typeset again at the new size (stays sharp), not stretched
          b.fontPx = (d.from.fontPx || 22) * d.k;
          if (b.maxW) b.maxW *= d.k; // same line breaks, just bigger or smaller
          if (d.from.strokePx) b.strokePx = d.from.strokePx * d.k;
          this.layouts.delete(b.id);
          this.layoutBlock(b).then(() => { this.render(); this.saveSoon(); });
        }
        this.pushUndo({ move: { id: b.id, from: d.from, to: { x: b.x, y: b.y, w: b.w, h: b.h, fontPx: b.fontPx, strokePx: b.strokePx, maxW: b.maxW } } });
        this.markDirty({ x: b.x, y: b.y, w: b.w, h: b.h }, { ai: b.author !== 'user' });
      } else Object.assign(b, { x: d.from.x, y: d.from.y, w: d.from.w, h: d.from.h });
    } else if (d.sel) {
      const s = d.sel;
      const big = s.x1 !== undefined && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 8 / this.page.view.z;
      this.selection = big ? normRect(s.x0, s.y0, s.x1, s.y1) : null;
      emit('selection', this.selection);
    } else if (d.lasso) {
      // close the loop; a tiny scribble clears the selection instead
      const xs = d.lasso.map((p) => p[0]), ys = d.lasso.map((p) => p[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const big = d.lasso.length >= 5 && Math.hypot(box.w, box.h) > 16 / this.page.view.z;
      this.selection = big ? { ...box, path: d.lasso.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) } : null;
      emit('selection', this.selection);
    }
    if (d.move || d.resize) this.render();
    else this.renderLive();
    this.saveSoon();
  }

  // smooth = light low-pass filter on position and pressure (removes hand/sensor jitter);
  // the pen-up point is added unsmoothed so the stroke ends exactly where the Pencil lifted.
  addPoint(s, w, pressure, smooth = false) {
    const last = s.points[s.points.length - 1];
    const k = smooth ? Math.max(0, Math.min(0.8, settings.inkSmoothing ?? 0.3)) : 0;
    const x = last[0] + (w.x - last[0]) * (1 - k);
    const y = last[1] + (w.y - last[1]) * (1 - k);
    if (Math.hypot(x - last[0], y - last[1]) <= 0.6 / this.page.view.z) return;
    // pen-up reports pressure 0; reuse the last pressure so the stroke end doesn't thin out
    const p = pressure > 0 ? last[2] * k + pressure * (1 - k) : last[2];
    s.points.push([r1(x), r1(y), Math.round(p * 1000) / 1000]);
  }

  finishStroke(d) {
    const s = d.stroke;
    if (this.drawing === d) this.drawing = null;
    if (s.points.length === 1) s.points.push([s.points[0][0] + 0.2, s.points[0][1] + 0.2, s.points[0][2]]);
    this.page.strokes.push(s);
    this.pushUndo({ add: { strokes: [s] } });
    this.markDirty(strokeBBox(s));
    (this.recentInk ||= []).push({ page: this.page.id, t: Date.now(), bb: strokeBBox(s) });
    if (this.recentInk.length > 400) this.recentInk.splice(0, 100);
    this.commitToPage(s); // drawn onto the page once; nothing else is redrawn
    this.saveSoon();
  }

  startGesture() {
    const pts = [...this.touches.values()];
    const v = this.page.view;
    if (pts.length === 1) this.gesture = { kind: 'pan', p0: pts[0], o0: { x: v.ox, y: v.oy }, paging: this.atFit(), t0: performance.now() };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      this.gesture = { kind: 'pinch', d0: Math.max(1, dist(a, b)), m0: mid(a, b), z0: v.z, o0: { x: v.ox, y: v.oy } };
    }
  }

  updateGesture() {
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.touches.values()];
    const v = this.page.view;
    if (g.kind === 'pan' && pts.length === 1 && g.paging) {
      // notebook, whole page in view: drag along the scroll direction to flip (with resistance at the ends)
      let d = this.vertical() ? pts[0].sy - g.p0.sy : pts[0].sx - g.p0.sx;
      const step = this.pageStep();
      this.pullAdd = false;
      if (d < 0 && this.pi === this.pages.length - 1) {
        // past the last page: pull against a spring; far enough and letting go adds a page
        d = spring(d, step * 0.5);
        this.pullAdd = Math.abs(d) > step * 0.2;
      } else if (d > 0 && this.pi === 0) d = spring(d, step * 0.2);
      this.slide = d;
    } else if (g.kind === 'pan' && pts.length === 1) {
      v.ox = g.o0.x + pts[0].sx - g.p0.sx;
      v.oy = g.o0.y + pts[0].sy - g.p0.sy;
      const want = this.vertical() ? v.oy : v.ox;
      this.clampView();
      if (this.layout) {
        // notebook, zoomed in: dragging on past the page's end brings the next (or previous) page in
        let d = want - (this.vertical() ? v.oy : v.ox);
        const step = Math.min(this.pageStep(), this.vertical() ? this.h : this.w);
        this.pullAdd = false;
        if (d < 0 && this.pi === this.pages.length - 1) { d = spring(d, step * 0.5); this.pullAdd = Math.abs(d) > step * 0.2; }
        else if (d > 0 && this.pi === 0) d = spring(d, step * 0.2);
        if (d && !this.slide) g.overT0 = performance.now();
        this.slide = d;
      }
    } else if (g.kind === 'pan' && pts.length >= 2) {
      this.startGesture();
    } else if (g.kind === 'pinch' && pts.length >= 2) {
      const [a, b] = pts;
      const z = clamp((g.z0 * dist(a, b)) / g.d0, 0.2, 6);
      const m = mid(a, b);
      const wx = (g.m0.sx - g.o0.x) / g.z0, wy = (g.m0.sy - g.o0.y) / g.z0;
      v.z = z;
      v.ox = m.sx - wx * z;
      v.oy = m.sy - wy * z;
      this.clampView();
    }
    this.render();
  }

  // Where you were just writing: your strokes on this page in the half-minute before your latest one, if that
  // latest stroke is less than 3 minutes old. Claude gets it as a hint for "this" / "the last line".
  focusArea({ maxAgeSec = 180, spanSec = 30 } = {}) {
    const ink = (this.recentInk || []).filter((r) => r.page === this.page?.id && this.page.strokes.length);
    if (!ink.length) return null;
    const last = ink[ink.length - 1].t;
    const age = (Date.now() - last) / 1000;
    if (age > maxAgeSec) return null;
    // start from the latest stroke and grow backwards in time, only through strokes close to what is
    // already included (so a jump to another part of the page doesn't widen it)
    let bb = ink[ink.length - 1].bb;
    for (let i = ink.length - 2; i >= 0; i--) {
      const r = ink[i];
      if (r.t < last - spanSec * 1000) break;
      const g = 120;
      if (r.bb.x < bb.x + bb.w + g && r.bb.x + r.bb.w > bb.x - g && r.bb.y < bb.y + bb.h + g * 0.6 && r.bb.y + r.bb.h > bb.y - g * 0.6) bb = union(bb, r.bb);
    }
    // keep only what is still on the page (it may have been erased since)
    const cb = this.contentBounds();
    if (!bb || !cb || bb.x > cb.x + cb.w || bb.y > cb.y + cb.h || bb.x + bb.w < cb.x || bb.y + bb.h < cb.y) return null;
    return { rect: bb, secondsAgo: Math.round(age) };
  }

  // boxes of your strokes that lie in the vertical band of r (to widen a close-up to whole lines)
  lineBoxes(r) {
    return this.page.strokes.map(strokeBBox).filter((bb) => bb.y < r.y + r.h && bb.y + bb.h > r.y && bb.h < r.h * 1.5);
  }

  // ---------- change tracking ----------
  // ai: a change made by Claude (its own blocks, or you moving/resizing/deleting one of them): it is saved,
  // but live watching does not spend a look on it.
  markDirty(bb, { ai = false } = {}) {
    emit('changed');
    if (ai || !bb) return;
    this.dirty = union(this.dirty, bb);
    (this.dirtyParts ||= []).push(bb); // the separate pieces, so far-apart changes can be looked at separately
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const d = this.dirty, parts = this.dirtyParts || [];
      this.dirty = null;
      this.dirtyParts = [];
      if (d) emit('settled', { bb: d, parts });
    }, 1100);
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => emit('save'), 700);
  }

  pushUndo(op) {
    this.undoStack.push(op);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  applyOp(op, reverse) {
    const P = this.page;
    const add = (it) => {
      if (it.strokes) P.strokes.push(...it.strokes);
      if (it.blocks) { P.blocks.push(...it.blocks); this.prepareBlocks(); }
      if (it.marks) P.marks.push(...it.marks);
    };
    const rem = (it) => {
      const ids = new Set([...(it.strokes || []), ...(it.blocks || []), ...(it.marks || [])].map((x) => x.id));
      P.strokes = P.strokes.filter((x) => !ids.has(x.id));
      P.blocks = P.blocks.filter((x) => !ids.has(x.id));
      P.marks = P.marks.filter((x) => !ids.has(x.id));
    };
    if (op.add) (reverse ? rem : add)(op.add);
    if (op.remove) (reverse ? add : rem)(op.remove);
    if (op.move) {
      const b = P.blocks.find((x) => x.id === op.move.id);
      if (b) {
        const before = b.fontPx, beforeW = b.maxW;
        Object.assign(b, reverse ? op.move.from : op.move.to);
        if (b.kind !== 'image' && (b.fontPx !== before || b.maxW !== beforeW)) { this.layouts.delete(b.id); this.layoutBlock(b); }
      }
    }
  }

  // ---------- matching Claude's writing to yours ----------
  // Typical height of your handwriting (in page units) where Claude is about to write.
  // Looks, in order: inside your selection → your lines around/above that spot → your recent writing.
  // Returns { fontPx, source } or null if there's no handwriting to go by.
  writingSize(at, selection = null) {
    const got = this.writingPool(at, selection);
    if (!got) return null;
    const fontPx = sizeOf(got.pool);
    return fontPx ? { fontPx, source: got.source } : null;
  }

  // Your average writing size on this page (all of it), for "manual" sizes in units of your writing.
  averageWritingSize() {
    const own = sizeOf(this.page.strokes);
    if (own) return own;
    for (const p of this.pages) { const s = sizeOf(p.strokes); if (s) return s; } // a fresh page: your other pages
    return null;
  }

  // The strokes Claude's writing should match: inside the selection, else the writing near the spot, else recent.
  writingPool(at, selection = null) {
    const strokes = this.page.strokes;
    if (!strokes.length) return null;
    const center = (s) => { const b = strokeBBox(s); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
    let pool = [], source = '';
    if (selection) {
      pool = strokes.filter((s) => inSelection(selection, center(s)));
      source = 'selection';
    }
    if (pool.length < 3 && at) {
      // nearby: mostly the lines just above / beside the spot, closest first
      const near = strokes
        .map((s) => { const c = center(s); return { s, d: Math.hypot((c.x - at.x) * 0.5, (c.y - at.y) * (c.y > at.y + 40 ? 3 : 1)) }; })
        .sort((a, b) => a.d - b.d)
        .slice(0, 12) // a word or two of the closest writing: enough to measure, without mixing in other lines
        .map((x) => x.s);
      if (near.length >= 3) { pool = near; source = 'nearby writing'; }
    }
    if (pool.length < 3) { pool = strokes.slice(-40); source = 'recent writing'; }
    return { pool, source };
  }

  // How Claude's next block looks. Each of size, stroke width and colour is either "mimic" (taken from your
  // writing where it goes) or "manual" (a set value). Size is in units of your own writing, except
  // "fixed": one absolute size (points; 1 pt = 96/72 board units, so 12 pt prints as 12 pt) everywhere.
  aiStyle(at, selection = null, extraScale = 1) {
    const s = this.ws();
    const got = this.writingPool(at, selection);
    const pool = got?.pool || [];
    const avg = this.averageWritingSize() || 22;
    const local = (got && sizeOf(pool)) || avg;
    const factor = s.aiSizeMode === 'manual' ? Number(s.aiSizeManual) || 1 : Number(s.aiSizeScale) || 1;
    const base = s.aiSizeMode === 'manual' ? avg : local;
    const scale = Math.max(0.2, Math.min(4, factor * (Number(extraScale) || 1)));
    let fontPx = Math.round(Math.max(10, Math.min(160, base * scale)) * 10) / 10;
    if (s.aiSizeMode === 'fixed') {
      const pt = Math.max(6, Math.min(120, Number(s.aiSizeFixed) || 18));
      // a size Claude was asked for this once ("write it bigger") still applies on top
      fontPx = Math.round(Math.max(8, Math.min(160, pt * (96 / 72) * Math.max(0.2, Math.min(4, Number(extraScale) || 1)))) * 10) / 10;
    }
    // stroke: the line thickness wanted for the letters (same units as your pen width)
    const strokePx = s.aiWeightMode === 'mimic' ? inkWidth(pool.length ? pool : this.page.strokes) : Math.max(0, Number(s.aiWeightManual) || 0);
    const color = s.aiColorMode === 'mimic' ? inkColor(pool.length ? pool : this.page.strokes) || s.penColor : s.aiColor;
    return { fontPx, strokePx, color };
  }

  aiFontSize(at, selection = null, extraScale = 1) { return this.aiStyle(at, selection, extraScale).fontPx; }

  // Resize one of Claude's blocks (or an image) by a factor, with undo.
  async scaleBlock(id, factor) {
    const b = this.page.blocks.find((x) => x.id === id);
    if (!b || !(factor > 0)) return null;
    const from = { x: b.x, y: b.y, w: b.w, h: b.h, fontPx: b.fontPx };
    if (b.kind === 'image') { b.w *= factor; b.h *= factor; }
    else {
      b.fontPx = Math.max(8, Math.min(160, (b.fontPx || 22) * factor));
      if (b.strokePx) b.strokePx *= factor;
      this.layouts.delete(b.id);
      await this.layoutBlock(b);
    }
    this.pushUndo({ move: { id: b.id, from, to: { x: b.x, y: b.y, w: b.w, h: b.h, fontPx: b.fontPx } } });
    this.render();
    this.saveSoon();
    return b;
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return;
    this.applyOp(op, true);
    this.redoStack.push(op);
    this.afterHistory(op);
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.applyOp(op, false);
    this.undoStack.push(op);
    this.afterHistory(op);
  }

  // after undo/redo: only what that step changed counts as changed (before, the whole page did, so live
  // watching re-read the whole page after every undo)
  afterHistory(op) {
    let bb = null;
    const P = this.page;
    const each = (g) => {
      for (const st of g?.strokes || []) bb = union(bb, strokeBBox(st));
      for (const bl of g?.blocks || []) if (bl.author === 'user') bb = union(bb, { x: bl.x, y: bl.y, w: bl.w || 1, h: bl.h || 1 });
    };
    if (op) {
      each(op.add); each(op.remove);
      if (op.move) { const bl = P.blocks.find((x) => x.id === op.move.id); if (bl?.author === 'user') for (const r of [op.move.from, op.move.to]) bb = union(bb, { x: r.x, y: r.y, w: r.w || bl.w || 1, h: r.h || bl.h || 1 }); }
    } else bb = this.contentBounds();
    this.markDirty(bb);
    this.render();
    this.saveSoon();
  }

  // ---------- hit testing / erasing ----------
  hitBlock(w, finger = false) {
    const pad = (finger ? 18 : 12) / this.page.view.z; // a margin around each block, the same on screen at any zoom
    for (let i = this.page.blocks.length - 1; i >= 0; i--) {
      const b = this.page.blocks[i];
      if (w.x >= b.x - pad && w.x <= b.x + (b.w || 100) + pad && w.y >= b.y - pad && w.y <= b.y + (b.h || 30) + pad) return b;
    }
    return null;
  }

  // The handwritten line a margin mark belongs to: strokes left of the mark, at its height (board units).
  lineAt(m) {
    let box = null;
    const band = 45;
    for (const st of this.page.strokes) {
      const bb = strokeBBox(st);
      if (bb.x > m.x + 10 || bb.x + bb.w < m.x - 1400) continue;
      if (bb.y + bb.h < m.y - band || bb.y > m.y + band) continue;
      box = union(box, bb);
    }
    return box || { x: m.x - 200, y: m.y - 20, w: 200, h: 40 };
  }

  // Where a block of size w×h can go near a line without covering writing: below the line, else to the
  // right of the mark, else above. Returns {x, y}.
  freeSpotNear(line, m, w, h) {
    const gap = 14;
    const taken = [...this.page.strokes.map(strokeBBox), ...this.page.blocks.map((b) => ({ x: b.x - 12, y: b.y, w: (b.w || 100) + 12, h: b.h || 30 }))];
    const hits = (r) => taken.some((t) => t.x < r.x + r.w && t.x + t.w > r.x && t.y < r.y + r.h && t.y + t.h > r.y);
    const pr = this.layout ? this.pageRect() : null;
    const onPage = (r) => { const m = this.inset(), mv = this.insetV(); return !pr || (r.x >= m && r.y >= mv && r.x + r.w <= pr.w - m && r.y + r.h <= pr.h - mv); };
    const cands = [
      { x: line.x + 12, y: line.y + line.h + gap },
      { x: m.x + 26, y: m.y - h / 2 },
      { x: line.x + 12, y: line.y - gap - h },
    ];
    // further down, if the space under the line is taken (the next lines of the derivation)
    for (let k = 1; k <= 6; k++) cands.push({ x: line.x + 12, y: line.y + line.h + gap + k * 40 });
    const fit = cands.find((c) => onPage({ ...c, w, h }) && !hits({ ...c, w, h })) || cands.find((c) => !hits({ ...c, w, h })) || cands[0];
    return fit;
  }

  hitMark(w, finger = false) {
    if (!settings.showMarks) return null;
    const r = (finger ? 22 : 14) / this.page.view.z;
    return this.page.marks.find((m) => Math.hypot(m.x - w.x, m.y - w.y) < r) || null;
  }

  eraserRadius() {
    return (settings.eraserSize || 20) / 2 / this.page.view.z; // size is on-screen pixels, whatever the zoom
  }

  // Erases along the path from the previous eraser position, so fast movements leave no gaps.
  eraseAt(w) {
    const d = this.drawing;
    const r = this.eraserRadius();
    const prev = d.last || w;
    d.last = w;
    const steps = Math.max(1, Math.ceil(Math.hypot(w.x - prev.x, w.y - prev.y) / (r * 0.5)));
    for (let i = 1; i <= steps; i++) {
      this.eraseCircle({ x: prev.x + ((w.x - prev.x) * i) / steps, y: prev.y + ((w.y - prev.y) * i) / steps }, r, d);
    }
  }

  eraseCircle(c, r, d) {
    const P = this.page;
    const whole = settings.eraserMode === 'stroke';
    const keep = [];
    let changed = false;
    let region = null;
    for (const s of P.strokes) {
      const bb = strokeBBox(s);
      const rr = r + s.width * 0.5;
      // cheap rejection: only strokes whose box is near the circle are examined
      if (c.x < bb.x - rr || c.x > bb.x + bb.w + rr || c.y < bb.y - rr || c.y > bb.y + bb.h + rr) { keep.push(s); continue; }
      const pieces = clipStroke(s, c, rr);
      if (!pieces) { keep.push(s); continue; }
      changed = true;
      d.dirty = union(d.dirty, bb);
      // a piece made earlier in this same gesture just disappears; an original stroke is remembered for undo
      if (d.added.has(s.id)) d.added.delete(s.id);
      else d.removed.strokes.push(s);
      if (!whole) for (const p of pieces) { keep.push(p); d.added.set(p.id, p); }
      // only the part of the page the eraser touched is redrawn
      const m = s.width * 1.5 + 2 / P.view.z;
      region = union(region, whole ? bb : { x: c.x - rr - m, y: c.y - rr - m, w: 2 * (rr + m), h: 2 * (rr + m) });
    }
    if (changed) { P.strokes = keep; this.renderRegion(region); }

    // Claude's typeset blocks (and pasted pictures) go whole when touched, only if the setting says so; by default
    // the eraser leaves them alone, so you can rub out your own writing on top of a block. Marks go when touched.
    if (settings.eraserBlocks) for (const b of [...P.blocks]) {
      const nx = Math.max(b.x, Math.min(c.x, b.x + (b.w || 1))), ny = Math.max(b.y, Math.min(c.y, b.y + (b.h || 1)));
      if (Math.hypot(nx - c.x, ny - c.y) < r) {
        P.blocks = P.blocks.filter((x) => x !== b);
        d.removed.blocks.push(b);
        this.render();
        d.dirty = union(d.dirty, { x: b.x, y: b.y, w: b.w || 1, h: b.h || 1 });
      }
    }
    for (const m of [...P.marks]) {
      if (Math.hypot(m.x - c.x, m.y - c.y) < r + 8 / P.view.z) { P.marks = P.marks.filter((x) => x !== m); d.removed.marks.push(m); }
    }
  }

  // ---------- AI blocks ----------
  async layoutBlock(b) {
    if (b.kind === 'image') {
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.onerror = res; img.src = b.src; });
      const lay = { items: [{ img, x: 0, y: 0, w: b.w, h: b.h }], w: b.w, h: b.h };
      this.layouts.set(b.id, lay);
      this.render();
      return lay;
    }
    const fontPx = b.fontPx || 22;
    // the board writing style (Settings → Board writing style; a preset sets these)
    const st = this.ws();
    const serif = st.textFont !== 'sans';
    const gap = fontPx * ({ compact: 0.25, normal: 0.45, relaxed: 0.75 }[st.lineSpacing] ?? 0.45);
    const para = fontPx * ({ small: 0.3, normal: 0.6, large: 1.0 }[st.paraSpacing] ?? 0.6);
    const hScale = { small: 0.88, normal: 1, large: 1.15 }[st.headingScale] ?? 1;
    const indent = fontPx * ({ none: 0, small: 1.2, medium: 2.4 }[st.stepIndent] ?? 0);
    const mathScale = Math.max(0.6, Math.min(1.6, Number(st.mathScale) || 1));
    const headColor = st.headingColor === 'same' ? b.color : darker(b.color);
    const items = [];
    let y = 0, w = 0;
    // Claude's writing stays inside the page / the visible board: long lines wrap (whole words; inline maths is
    // never cut) at the block's width, or the preferred column width if narrower; wide display maths is scaled down.
    const col = Number(st.columnChars) > 0 ? Number(st.columnChars) * fontPx * 0.5 : Infinity;
    let maxW = Math.min(b.maxW > 0 ? b.maxW : Infinity, b.fixedW ? Infinity : col); // a width you set by hand wins
    const FACE = serif ? `Georgia, 'Times New Roman', serif` : FONT;
    const measure = (t, size, bold) => { this.ctx.font = `${bold ? '650 ' : ''}${size}px ${FACE}`; return this.ctx.measureText(t).width; };
    const tex = (t, size, color, display) => texToImage(t, { color, fontPx: size, strokePx: b.strokePx || 0, display });
    const pushImg = (im, li, kind, under) => {
      let iw = im.w, ih = im.h;
      const room = maxW - (kind === 'display' ? 0 : under ? indent : 0);
      if (iw > room) { const k = Math.max(0.5, room / iw); iw *= k; ih *= k; }
      items.push({ img: im.img, x: 0, y, w: iw, h: ih, li, kind, under });
      y += ih + gap;
      w = Math.max(w, iw + (under && kind !== 'display' ? indent : 0));
    };
    const pushText = (text, size, bold, li, color, under) => {
      text = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[\s(])\*([^*\s][^*]*?)\*/g, '$1$2'); // drawn as plain text: no markup stars
      const tw = measure(text, size, bold);
      items.push({ text, x: 0, y, w: tw, h: size * 1.3, fontPx: size, bold, serif, color, li, kind: bold ? 'heading' : 'text', under });
      y += size * 1.3 + gap;
      w = Math.max(w, tw + (under ? indent : 0));
    };
    let underHeading = false;
    for (const [li, raw] of b.lines.entries()) {
      let line = String(raw);
      // "# Heading" / "## Subheading": bigger and bold, with space above; "- item" becomes a bullet
      let size = fontPx, bold = false, color = b.color;
      const hm = line.match(/^\s*(#{1,3})\s+(.*)$/);
      if (hm) {
        size = fontPx * (hm[1].length === 1 ? 1.35 : hm[1].length === 2 ? 1.18 : 1.06) * hScale;
        bold = true;
        color = headColor;
        line = hm[2];
        if (li) y += para;
        underHeading = true;
      }
      const under = !bold && underHeading;
      const room = maxW - (under ? indent : 0);
      line = line.replace(/^\s*[-•]\s+/, '• ').replace(/^\s*\*\s+/, '• '); // bullets; **bold** and *italic* are typeset
      const L = lineToTex(line, { serif, bold });
      if (L.display) {
        if (li && items.length) y += para * 0.5;
        const im = await tex(L.tex, size * mathScale, color, true);
        if (im && !im.error) pushImg(im, li, 'display', under);
        else { const tw = measure(line, size, bold); pushText(line, tw > room ? Math.max(size * 0.5, (size * room) / tw) : size, bold, li, color, under); }
        y += para * 0.5;
        continue;
      }
      // the line as it is, if it fits
      const whole = L.plain ? null : await tex(L.tex, size, color, false);
      const ok = (im) => im && !im.error;
      if (L.plain ? measure(L.text, size, bold) <= room : ok(whole) && whole.w <= room) { if (L.plain || !ok(whole)) pushText(L.plain ? L.text : line, size, bold, li, color, under); else pushImg(whole, li, bold ? 'heading' : 'text', under); continue; }
      if (!L.plain && !ok(whole) && measure(line, size, bold) <= room) { pushText(line, size, bold, li, color, under); continue; }
      // too wide: break into pieces (words, and each $...$ kept whole) and fill rows up to the width
      const tokens = wrapTokens(line);
      const widthOf = async (t) => {
        if (t.startsWith('$') && t.endsWith('$') && t.length > 1) { const im = await tex(t.slice(1, -1), size, color, false); return ok(im) ? im.w : measure(t, size, bold); }
        return measure(t, size, bold);
      };
      // hanging indent (setting): the rows after the first are set in a little, so each line's start stands out
      const hang = st.hangIndent ? fontPx * 1.2 : 0;
      const rows = [];
      let cur = [], curW = 0;
      for (const t of tokens) {
        const tw = await widthOf(t);
        const lim = rows.length ? room - hang : room;
        if (cur.length && curW + tw > lim) { rows.push(cur); cur = [t]; curW = tw; } else { cur.push(t); curW += tw; }
      }
      if (cur.length) rows.push(cur);
      // each row typeset; if the typeset row is still too wide (estimates differ a little), its last word moves down
      for (let r = 0; r < rows.length; r++) {
        const text = rows[r].join('').trim();
        if (!text) continue;
        const R = lineToTex(text, { serif, bold });
        const n0 = items.length;
        const lim = r ? room - hang : room;
        if (R.plain) pushText(R.text, size, bold, li, color, under);
        else {
          const im = await tex(R.tex, size, color, false);
          if (ok(im) && im.w > lim * 1.02 && rows[r].length > 1) { (rows[r + 1] ||= []).unshift(rows[r].pop()); r--; continue; }
          if (ok(im)) pushImg(im, li, bold ? 'heading' : 'text', under); else pushText(text, size, bold, li, color, under);
        }
        if (r && hang) for (let q = n0; q < items.length; q++) { items[q].hang = hang; w = Math.max(w, items[q].w + hang + (under ? indent : 0)); }
      }
    }
    // indent lines under headings; centre display equations in the column
    const colW = Math.max(w, 1); // centred within the block's widest line
    for (const it of items) {
      if (it.kind === 'display' && st.displayAlign !== 'left') it.x = Math.max(0, (colW - it.w) / 2);
      else if (it.under && it.kind !== 'heading') it.x = indent;
      if (it.hang) it.x += it.hang;
    }
    w = Math.max(w, ...items.map((it) => it.x + it.w));
    const lay = { items, w, h: Math.max(fontPx, y - gap) };
    b.w = lay.w;
    b.h = lay.h;
    this.layouts.set(b.id, lay);
    this.render();
    return lay;
  }

  // Block padding: the space between a block's side bar and its text (and a little above / below the text).
  blockPad(b) { return ({ none: 0.15, small: 0.35, normal: 0.6, large: 1.0 }[this.ws().blockPadding] ?? 0.6) * (b?.fontPx || 22); }
  // Space Claude leaves between its block and the writing above it (yours or its own).
  blockGap(fontPx = 22) { return ({ small: 0.6, normal: 1.1, large: 1.8 }[this.ws().blockGap] ?? 1.1) * fontPx; }

  // the page padding Claude's writing keeps (Settings → Board → Claude's writing, or the session's own)
  inset() { const m = Number(this.ws().writeMargin); return Number.isFinite(m) && m >= 0 ? Math.min(160, m) : PAGE_INSET; }
  insetV() { const m = Number(this.ws().writeMarginV); return Number.isFinite(m) && m >= 0 ? Math.min(200, m) : this.inset(); }

  // Claude's writing in this session: the global settings, or the session's own (Page setup)
  ws() { return writingSettings(this.sessionWriting); }

  setSessionWriting(w, { relayout = true } = {}) {
    this.sessionWriting = w || null;
    this.layouts.clear(); // every block is laid out again in the session's style
    if (relayout && this.page) this.restyle();
  }

  // the board writing style changed: lay Claude's blocks out again (every page; the open one now)
  restyle() {
    const m = this.inset();
    for (const p of this.pages) for (const b of p.blocks) {
      if (b.kind === 'image') continue;
      this.layouts.delete(b.id);
      // notebook: the page margin may have changed, so the text width follows it (unless you set the width by hand)
      if (this.layout && !b.fixedW && b.author !== 'user') this.fitToArea(b, { left: m, right: this.pageSize(p).w - m, top: this.insetV() });
    }
    this.prepareBlocks();
    this.prepareNeighbours?.();
    this.render();
  }

  prepareBlocks() {
    for (const b of this.page.blocks) if (!this.layouts.has(b.id)) this.layoutBlock(b);
  }

  // A place for new writing of about w × h at `pos` that doesn't run into what is already on the page.
  // If `pos` is crowded (e.g. a selection inside one of Claude's blocks, or inside a paragraph of your writing),
  // the writing goes below the whole group the selection belongs to (the block, or the cluster of lines around it),
  // and further down past anything in the way. Not a hard rule: it only avoids clashes.
  placeFree(pos, { w, h }, near = null) {
    const pad = 10;
    const occupied = [
      ...this.page.blocks.map((b) => { const pd = b.kind === 'image' ? 0 : this.blockPad(b) + 3; return { x: b.x - pd, y: b.y - pd * 0.25, w: (b.w || 100) + pd, h: (b.h || 30) + pd * 0.5 }; }),
      ...this.page.strokes.map(strokeBBox),
    ];
    const hits = (r) => occupied.filter((o) => o.x < r.x + r.w + pad && o.x + o.w + pad > r.x && o.y < r.y + r.h + pad && o.y + o.h + pad > r.y);
    const first = Math.min(h, 160); // the first lines decide whether the spot is free
    if (!hits({ x: pos.x, y: pos.y, w, h: first }).length) return pos;
    // the group: everything the selection touches, grown through neighbours that are close (same paragraph/block)
    let g = near ? { ...near } : { x: pos.x, y: pos.y - 1, w: 1, h: 1 };
    const close = (o) => o.x < g.x + g.w + 40 && o.x + o.w + 40 > g.x && o.y < g.y + g.h + 36 && o.y + o.h + 36 > g.y;
    for (let grew = true, n = 0; grew && n < 200; n++) {
      grew = false;
      for (const o of occupied) if (close(o) && (o.x < g.x || o.y < g.y || o.x + o.w > g.x + g.w || o.y + o.h > g.y + g.h)) { g = union(g, o); grew = true; }
    }
    const gapY = this.blockGap(this.aiStyle(null).fontPx);
    const p = { x: Math.max(g.x + this.blockPad() + 3, this.writeArea().left), y: g.y + g.h + gapY }; // room for a block's side bar
    // past anything still in the way, further down
    for (let n = 0; n < 60; n++) {
      const inWay = hits({ x: p.x, y: p.y, w, h: first });
      if (!inWay.length) break;
      p.y = Math.max(...inWay.map((o) => o.y + o.h)) + gapY;
    }
    return p;
  }

  // ---------- writing animation (Settings → Board: style and time per line) ----------
  // Each line (row) of a block appears in turn: "write" draws it left to right like a pen, "fade" fades it in,
  // "lines" shows it at once; "off" shows the whole block at once. Only on screen: pictures for Claude,
  // thumbnails and exports always show the whole block. The whole block takes at most about 15 s.
  animate(b, perMs, signal) {
    const style = settings.writeAnimation || 'write';
    const lay = this.layouts.get(b.id);
    if (style === 'off' || !lay?.items.length || !(perMs > 0)) return;
    const n = lay.items.length;
    const per = Math.max(60, Math.min(perMs, 15000 / n));
    (this.anims ||= new Map()).set(b.id, { t0: performance.now(), per, style, n, signal });
    if (!this.animRaf) this.animRaf = requestAnimationFrame(() => this.animTick());
  }

  animTick() {
    this.animRaf = null;
    const now = performance.now();
    for (const [id, a] of this.anims || []) {
      if (a.signal?.aborted || now - a.t0 > a.n * a.per + 50) { this.anims.delete(id); continue; }
      // keep the line being written in view (freeform: scroll along; notebook pages are shown whole)
      const b = this.page?.blocks.find((x) => x.id === id), lay = b && this.layouts.get(id);
      const i = Math.min(a.n - 1, Math.floor((now - a.t0) / a.per));
      if (b && lay && !this.layout && i !== a.shown) { a.shown = i; const it = lay.items[i]; if (it) this.ensureVisible({ x: b.x + it.x, y: b.y + it.y, w: it.w, h: it.h + 40 }); }
    }
    this.render();
    if (this.anims?.size) this.animRaf = requestAnimationFrame(() => this.animTick());
    else for (const f of this.animWaiters?.splice(0) || []) f();
  }

  // resolves when every writing animation has finished (or was stopped)
  animationsDone() {
    if (!this.anims?.size) return Promise.resolve();
    return new Promise((res) => (this.animWaiters ||= []).push(res));
  }

  // ---------- taking you to a place ("go to where I wrote Maxwell's equations") ----------
  // Glides the view so the place (board units) is in the middle of the screen, zoomed in on it if asked
  // (or if it doesn't fit), and outlines it for a moment so you see what was meant.
  showPlace(rect, { zoom = false } = {}) {
    const v = this.page.view, m = 40;
    let z = v.z;
    const fitsZ = Math.min((this.w - 2 * m) / Math.max(rect.w, 1), (this.h - 2 * m) / Math.max(rect.h, 1));
    if (zoom) z = Math.min(3, fitsZ * 0.85);
    else if (rect.w * z > this.w - 2 * m || rect.h * z > this.h - 2 * m) z = Math.min(z, fitsZ); // make it fit
    if (this.layout) z = Math.max(z, this.fitZoom());
    z = Math.max(0.2, Math.min(6, z));
    const cx = rect.x + rect.w / 2;
    // centred; a place taller than the screen starts at its top
    const oy = rect.h * z > this.h - 2 * m ? m - rect.y * z : this.h / 2 - (rect.y + rect.h / 2) * z;
    const target = { z, ox: this.w / 2 - cx * z, oy };
    // where clampView would put it (notebook pages can't be pushed off screen)
    const save = { ...v };
    Object.assign(v, target); this.clampView(); const end = { ...v }; Object.assign(v, save);
    const t0 = performance.now(), ms = 380, from = { ...v };
    cancelAnimationFrame(this.placeRaf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      // zoom changes smoothly in log space, the position follows
      v.z = from.z * Math.pow(end.z / from.z, e);
      v.ox = from.ox + (end.ox - from.ox) * e;
      v.oy = from.oy + (end.oy - from.oy) * e;
      this.render();
      if (k < 1) this.placeRaf = requestAnimationFrame(step);
      else { this.clampView(); this.render(); this.saveSoon(); }
    };
    this.placeRaf = requestAnimationFrame(step);
    this.flash = { rect, until: performance.now() + 2200 };
    const pulse = () => { this.renderLive(); if (this.flash && performance.now() < this.flash.until) requestAnimationFrame(pulse); else { this.flash = null; this.renderLive(); } };
    requestAnimationFrame(pulse);
  }

  // Where Claude may write: a notebook page minus its margins; on a freeform page, the part of the board you can
  // see now (e.g. half the screen when the panel takes the other half), minus a margin.
  writeArea() {
    if (this.layout) { const s = this.pageSize(), m = this.inset(), mv = this.insetV(); return { left: m, right: s.w - m, top: mv, bottom: s.h - mv }; }
    const vis = this.visibleWorld(), m = this.inset() / this.page.view.z, mv = this.insetV() / this.page.view.z; // freeform: margins on screen
    return { left: vis.x + m, right: vis.x + vis.w - m, top: vis.y + mv, bottom: vis.y + vis.h - mv };
  }

  // Fits a block's position and wrap width into the write area (keeps at least ~half the area's width to write in).
  fitToArea(b, area = this.writeArea()) {
    const { right, top } = area;
    const left = area.left + (b.kind !== 'image' && this.ws().aiSideBar !== false ? this.blockPad(b) + 3 : 0); // the side bar and padding stay inside the page padding
    if (Number.isFinite(top) && Number.isFinite(b.y) && b.y < top) b.y = top; // not above the top margin
    const full = Math.max(80, right - left);
    b.x = Math.max(left, b.x);
    let maxW = right - b.x;
    if (maxW < full * 0.5) { maxW = full * 0.5; b.x = Math.max(left, right - maxW); }
    b.maxW = maxW;
  }

  async addBlock({ lines = [], x, y, kind = 'math', src, w, h, fontPx = 22, color, strokePx = 0 }, { animateMs = 0, signal, author = 'ai' } = {}) {
    const b = { id: uid(), kind, x, y, lines: [], color: color || settings.aiColor, fontPx, strokePx, author, src, w, h };
    if (kind !== 'image') this.fitToArea(b);
    this.page.blocks.push(b);
    b.lines = [...lines];
    const anim = kind !== 'image' && animateMs > 0 && settings.writeAnimation !== 'off';
    if (anim) (this.unready ||= new Set()).add(b.id); // not shown until typeset, so the animation starts from nothing
    try { await this.layoutBlock(b); } finally { this.unready?.delete(b.id); }
    if (anim) this.animate(b, animateMs, signal); // plays while the caller carries on // plays while the caller carries on
    this.pushUndo({ add: { blocks: [b] } });
    this.ensureVisible({ x: b.x, y: b.y, w: b.w || 100, h: b.h || 40 });
    this.saveSoon();
    return b;
  }

  async pinImage(src, w, h) {
    const cb = this.contentBounds();
    const vis = this.visibleWorld();
    if (this.layout) {
      // notebook: below what is on the page, as wide as fits
      const s = this.pageSize();
      const m = this.inset(), mv = this.insetV();
      const scale = Math.min(1, 520 / w, (s.w - 2 * m) / w);
      const b = await this.addBlock({ kind: 'image', src, x: m, y: cb ? cb.y + cb.h + 30 : mv, w: w * scale, h: h * scale });
      await this.keepOnPage(b);
      return b;
    }
    const scale = Math.min(1, 520 / w);
    const x = cb ? cb.x + cb.w + 60 : vis.x + 40;
    const y = cb ? cb.y : vis.y + 40;
    return this.addBlock({ kind: 'image', src, x, y, w: w * scale, h: h * scale });
  }

  // An image you paste, drop or pick: placed where you dropped it, or in the middle of the view,
  // at most about half the visible width, then selected so it can be moved or resized straight away.
  async placeImage(src, w, h, at) {
    const vis = this.visibleWorld();
    const scale = Math.min(1 / this.page.view.z, (vis.w * 0.5) / w, (vis.h * 0.6) / h);
    const W = w * scale, H = h * scale;
    const x = at ? at.x - W / 2 : vis.x + (vis.w - W) / 2;
    const y = at ? at.y - H / 2 : vis.y + (vis.h - H) / 2;
    const b = await this.addBlock({ kind: 'image', src, x, y, w: W, h: H }, { author: 'user' });
    await this.keepOnPage(b);
    this.activeBlock = b;
    this.markDirty({ x, y, w: W, h: H });
    this.render();
    return b;
  }

  setLocked(v) {
    if (this.locked === v) return;
    this.locked = v;
    if (v) this.drawing = null;
    emit('lock', v);
    this.renderLive();
  }

  // ---------- marks & notebook ----------
  addMark(m) {
    const mk = { id: uid(), src: 'chat', ...m };
    this.page.marks.push(mk);
    this.renderLive();
    this.saveSoon();
    return mk;
  }

  replaceMarks(src, marks) {
    this.page.marks = this.page.marks.filter((m) => m.src !== src).concat(marks.map((m) => ({ id: uid(), src, ...m })));
    this.renderLive();
    this.saveSoon();
  }

  // ---------- snapshots ----------
  // Renders (part of) the page to a JPEG for Claude. Returns mapping info so image pixels can be
  // converted back to board coordinates.
  // whole: always the whole page (a big freeform page otherwise shows only what is on screen, to stay legible)
  snapshot({ region = null, maxDim = 1400, maxScale = 2, pad = 30, whole = false } = {}) {
    let bb = region || this.contentBounds() || (this.layout ? this.pageRect() : this.visibleWorld());
    if (this.layout && !region) {
      // what is on the page (writing off the page's edge is not part of it)
      const pr = this.pageRect();
      const x0 = Math.max(bb.x, 0), y0 = Math.max(bb.y, 0), x1 = Math.min(bb.x + bb.w, pr.w), y1 = Math.min(bb.y + bb.h, pr.h);
      bb = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : pr;
    }
    bb = { x: bb.x - pad, y: bb.y - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad };
    let scale = Math.min(maxScale, maxDim / Math.max(bb.w, bb.h));
    let partial = false;
    if (!region && !whole && scale < 0.5) {
      const vis = this.visibleWorld();
      bb = { x: vis.x, y: vis.y, w: vis.w, h: vis.h };
      scale = Math.min(maxScale, maxDim / Math.max(bb.w, bb.h));
      partial = true;
    }
    const W = Math.max(8, Math.round(bb.w * scale));
    const H = Math.max(8, Math.round(bb.h * scale));
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const view = { z: scale, ox: -bb.x * scale, oy: -bb.y * scale };
    this.draw(ctx, view, 1, false);
    const veil = (ctx) => {
      // a lasso: what lies outside the outline is faded, so the picture shows what was circled
      if (!region?.path) return;
      ctx.save();
      ctx.setTransform(scale, 0, 0, scale, view.ox, view.oy);
      ctx.beginPath();
      ctx.rect(bb.x, bb.y, bb.w, bb.h);
      region.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill('evenodd');
      ctx.setLineDash([6 / scale, 5 / scale]);
      ctx.lineWidth = 1.5 / scale;
      ctx.strokeStyle = '#1a5fd0';
      tracePath(ctx, region.path);
      ctx.stroke();
      ctx.restore();
    };
    veil(ctx);
    let data;
    try {
      data = cv.toDataURL('image/jpeg', 0.85);
    } catch {
      // Some browsers taint canvases that drew SVG images; fall back to drawing AI blocks as text.
      this.noImageBlocks = true;
      const cv2 = document.createElement('canvas');
      cv2.width = W;
      cv2.height = H;
      this.draw(cv2.getContext('2d'), view, 1, false);
      veil(cv2.getContext('2d'));
      this.noImageBlocks = false;
      data = cv2.toDataURL('image/jpeg', 0.85);
    }
    return { b64: data.split(',')[1], dataUrl: data, media_type: 'image/jpeg', bounds: bb, scale, width: W, height: H, partial };
  }

  imageToWorld(snap, px, py) {
    return { x: snap.bounds.x + px / snap.scale, y: snap.bounds.y + py / snap.scale };
  }

  worldToImage(snap, x, y) {
    return { x: Math.round((x - snap.bounds.x) * snap.scale), y: Math.round((y - snap.bounds.y) * snap.scale) };
  }

  rectToImage(snap, r) {
    const a = this.worldToImage(snap, r.x, r.y);
    return { x: a.x, y: a.y, w: Math.round(r.w * snap.scale), h: Math.round(r.h * snap.scale) };
  }

  // ---------- rendering ----------
  // Three kinds of update, batched into one animation frame:
  //  render()          – whole page (view changed, undo, page switch…), culled to what is visible;
  //  renderRegion(r)   – only a rectangle of the page (erasing);
  //  renderLive()      – only the live layer (the stroke being drawn, cursors), the page is untouched.
  // A finished stroke is drawn onto the page once (commitToPage), never by redrawing everything.
  render() { this.needFull = true; this.schedule(); }
  renderLive() { this.schedule(); }
  renderRegion(r) { this.pendingRegion = union(this.pendingRegion, r); this.schedule(); }
  commitToPage(s) { this.pendingStrokes.push(s); this.schedule(); }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      if (!this.page) return;
      const v = this.page.view;
      if (this.layout && (this.needFull || this.slide)) {
        this.drawNotebook();
      } else if (this.needFull) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.c.width, this.c.height);
        this.drawContent(this.ctx, v, this.dpr, null, true);
      } else {
        if (this.pendingRegion) this.redrawRegion(this.pendingRegion);
        if (this.pendingStrokes.length) {
          this.ctx.save();
          this.ctx.setTransform(this.dpr * v.z, 0, 0, this.dpr * v.z, this.dpr * v.ox, this.dpr * v.oy);
          if (this.layout) { const pr = this.pageRect(); this.ctx.beginPath(); this.ctx.rect(pr.x, pr.y, pr.w, pr.h); this.ctx.clip(); }
          for (const s of this.pendingStrokes) drawStroke(this.ctx, s);
          this.ctx.restore();
        }
      }
      this.needFull = false;
      this.pendingRegion = null;
      this.pendingStrokes = [];
      this.drawLive();
    });
  }

  redrawRegion(r) {
    const v = this.page.view, ctx = this.ctx;
    const pad = 4 / v.z;
    let rr = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    if (this.layout) {
      // only the part on the page (the grey around it never changes)
      const pr = this.pageRect();
      const x0 = Math.max(rr.x, pr.x), y0 = Math.max(rr.y, pr.y), x1 = Math.min(rr.x + rr.w, pr.w), y1 = Math.min(rr.y + rr.h, pr.h);
      if (x1 <= x0 || y1 <= y0) return;
      rr = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    ctx.save();
    ctx.setTransform(this.dpr * v.z, 0, 0, this.dpr * v.z, this.dpr * v.ox, this.dpr * v.oy);
    ctx.beginPath();
    ctx.rect(rr.x, rr.y, rr.w, rr.h);
    ctx.clip();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
    this.drawContent(ctx, v, this.dpr, rr, true);
    ctx.restore();
  }

  // Draws page content (grid, Claude's blocks, ink) that intersects `area` (default: what the canvas shows).
  drawContent(ctx, view, scale, area, grid) {
    ctx.setTransform(scale * view.z, 0, 0, scale * view.z, scale * view.ox, scale * view.oy);
    const vis = area || { x: -view.ox / view.z, y: -view.oy / view.z, w: ctx.canvas.width / (scale * view.z), h: ctx.canvas.height / (scale * view.z) };
    const meets = (b) => b.x < vis.x + vis.w && b.x + b.w > vis.x && b.y < vis.y + vis.h && b.y + b.h > vis.y;
    if (this.page.bg) { if (!this.skipBg) this.drawBg(ctx, view, scale); }
    else if (grid) this.drawGrid(ctx, view, vis);
    for (const b of this.page.blocks) if (meets({ x: b.x - 12, y: b.y, w: (b.w || 200) + 12, h: b.h || 40 })) this.drawBlock(ctx, b);
    for (const s of this.page.strokes) if (meets(strokeBBox(s))) drawStroke(ctx, s);
  }

  // A PDF page's background: the sharpest copy rendered so far, and a sharper one asked for when needed
  // (it is drawn when ready). Until the first one is ready, a light placeholder.
  drawBg(ctx, view, scale) {
    const bg = this.page.bg, px = bg.w * view.z * scale;
    const img = cachedBg(bg);
    if (img) ctx.drawImage(img, 0, 0, bg.w, bg.h);
    else { ctx.fillStyle = '#f4f5f7'; ctx.fillRect(0, 0, bg.w, bg.h); }
    if (ctx === this.ctx && bgNeedsBetter(bg, px)) {
      renderBg(bg, px).then(() => this.render()).catch((e) => { if (!this.bgWarned) { this.bgWarned = true; emit('notice', { kind: 'error', text: 'Could not draw a PDF page: ' + (e.message || e) }); } });
    }
  }

  // Before a picture of a page goes to Claude (or into a thumbnail/export), its PDF page is rendered sharp enough.
  async bgReady(page = this.page, px = 1400) {
    if (page?.bg) { try { await renderBg(page.bg, px); } catch {} }
  }

  // Notebook: grey desk, the current page (and, while flipping, its neighbours) as sheets of paper.
  // Pages can differ in size (PDF pages, blank pages between them): each is drawn at its own size, centred.
  drawNotebook() {
    const ctx = this.ctx, v = this.page.view, s = this.pageSize(), step = this.pageStep();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e6e8ec';
    ctx.fillRect(0, 0, this.c.width, this.c.height);
    const keep = this.pi;
    for (const k of [-1, 0, 1]) {
      const i = keep + k;
      if (!this.pages[i]) continue;
      const off = this.slide + (k < 0 ? -this.pageStep(-1) : k > 0 ? this.pageStep(1) : 0);
      if (Math.abs(off) >= (this.vertical() ? this.h : this.w) + step) continue;
      const ns = this.pageSize(this.pages[i]);
      const cross = this.vertical() ? ((s.w - ns.w) * v.z) / 2 : ((s.h - ns.h) * v.z) / 2;
      const view = { z: v.z, ox: v.ox + (this.vertical() ? cross : off), oy: v.oy + (this.vertical() ? off : cross) };
      this.pi = i;
      try {
        ctx.save();
        ctx.setTransform(this.dpr * view.z, 0, 0, this.dpr * view.z, this.dpr * view.ox, this.dpr * view.oy);
        ctx.shadowColor = 'rgba(0,0,0,0.16)';
        ctx.shadowBlur = 10 * this.dpr;
        ctx.shadowOffsetY = 2 * this.dpr;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, ns.w, ns.h);
        ctx.shadowColor = 'transparent';
        ctx.beginPath();
        ctx.rect(0, 0, ns.w, ns.h);
        ctx.clip();
        this.drawContent(ctx, view, this.dpr, null, true);
        ctx.restore();
      } finally {
        this.pi = keep;
      }
    }
    // pulling past the last page: the outline of a page that is about to be added
    if (this.slide < 0 && keep === this.pages.length - 1) {
      const off = this.slide + step;
      const ns = this.pageSize({}); // a new page is blank: the notebook's page size
      const cross = this.vertical() ? ((s.w - ns.w) * v.z) / 2 : ((s.h - ns.h) * v.z) / 2;
      const x = v.ox + (this.vertical() ? cross : off), y = v.oy + (this.vertical() ? off : cross);
      const w = ns.w * v.z, h = ns.h * v.z, d = this.dpr;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = Math.min(1, Math.abs(this.slide) / (Math.min(step, this.vertical() ? this.h : this.w) * 0.2));
      ctx.setLineDash([8 * d, 6 * d]);
      ctx.lineWidth = 2 * d;
      ctx.strokeStyle = this.pullAdd ? '#1a5fd0' : '#9aa0aa';
      ctx.fillStyle = this.pullAdd ? 'rgba(26,95,208,0.06)' : 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x * d, y * d, w * d, h * d, 6 * d) : ctx.rect(x * d, y * d, w * d, h * d);
      ctx.fill();
      ctx.stroke();
      // the label sits in the visible strip of the new page
      const vis = this.vertical() ? { cx: x + w / 2, cy: Math.max(y, 0) + Math.min(this.h - Math.max(y, 0), 120) / 2 } : { cx: Math.max(x, 0) + Math.min(this.w - Math.max(x, 0), 220) / 2, cy: y + h / 2 };
      ctx.setLineDash([]);
      ctx.fillStyle = this.pullAdd ? '#1a5fd0' : '#6b6b70';
      ctx.font = `600 ${15 * d}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.pullAdd ? '＋  Release to add a page' : '＋  Pull to add a page', vis.cx * d, vis.cy * d);
      ctx.restore();
    }
  }

  // Snapshot for Claude (no grid, no marks).
  draw(ctx, view, scale) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.drawContent(ctx, view, scale, null, false);
  }

  drawLive() {
    const ctx = this.octx, view = this.page.view, scale = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.o.width, this.o.height);
    ctx.setTransform(scale * view.z, 0, 0, scale * view.z, scale * view.ox, scale * view.oy);
    if (this.drawing?.stroke) drawStroke(ctx, this.drawing.stroke, this.drawing.predicted);
    const ab = this.tool === 'select' && this.activeBlock && this.page.blocks.includes(this.activeBlock) ? this.activeBlock : this.drawing?.move;
    this.updateBlockBar();
    if (ab) {
      const pad = 4 / view.z;
      ctx.save();
      ctx.strokeStyle = '#1a5fd0';
      ctx.lineWidth = 1.5 / view.z;
      ctx.strokeRect(ab.x - pad, ab.y - pad, (ab.w || 100) + 2 * pad, (ab.h || 30) + 2 * pad);
      if (this.tool === 'select') { // handles: corners = size, left/right edge = width (text rewraps)
        const hr = 7 / view.z;
        ctx.fillStyle = '#ffffff';
        ctx.lineWidth = 2 / view.z;
        for (const [id, hx, hy] of this.handlesOf(ab)) {
          ctx.beginPath();
          if (id.length === 1) { const hw = 5 / view.z, hh = 16 / view.z; ctx.roundRect ? ctx.roundRect(hx - hw, hy - hh, hw * 2, hh * 2, hw) : ctx.rect(hx - hw, hy - hh, hw * 2, hh * 2); }
          else ctx.arc(hx, hy, hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        // while dragging an edge: where the new edge will be
        const d = this.drawing;
        if (d?.resize === ab && d.newW && (d.handle === 'e' || d.handle === 'w')) {
          ctx.save();
          ctx.setLineDash([5 / view.z, 4 / view.z]);
          ctx.strokeStyle = 'rgba(26,95,208,0.6)';
          const gx = d.handle === 'e' ? d.guideX : d.guideX;
          ctx.beginPath(); ctx.moveTo(gx, ab.y - 20 / view.z); ctx.lineTo(gx, ab.y + ab.h + 20 / view.z); ctx.stroke();
          ctx.restore();
        }
      }
      ctx.restore();
    }
    if (this.flash) {
      // the place Claude just took you to: a soft outline that fades out
      const f = this.flash, left = (f.until - performance.now()) / 2200;
      if (left > 0) {
        const pad = 10 / view.z;
        ctx.save();
        ctx.globalAlpha = Math.min(1, left * 2);
        ctx.lineWidth = 3 / view.z;
        ctx.strokeStyle = '#1a5fd0';
        ctx.fillStyle = 'rgba(26,95,208,0.08)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(f.rect.x - pad, f.rect.y - pad, f.rect.w + 2 * pad, f.rect.h + 2 * pad, 10 / view.z) : ctx.rect(f.rect.x - pad, f.rect.y - pad, f.rect.w + 2 * pad, f.rect.h + 2 * pad);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    if (settings.showMarks) for (const m of this.page.marks) drawMark(ctx, m, view.z);
    if (this.tool === 'eraser' && this.eraserCursor) {
      const ec = this.eraserCursor;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ec.x, ec.y, this.eraserRadius(), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,120,128,0.10)';
      ctx.fill();
      ctx.lineWidth = 1.25 / view.z;
      ctx.strokeStyle = 'rgba(60,60,67,0.55)';
      ctx.stroke();
      ctx.restore();
    }
    const lassoNow = this.drawing?.lasso;
    const lassoSel = !lassoNow && !this.drawing?.sel && this.selection?.path;
    if (lassoNow || lassoSel) {
      ctx.save();
      ctx.setLineDash([6 / view.z, 5 / view.z]);
      ctx.lineWidth = 1.5 / view.z;
      ctx.strokeStyle = '#1a5fd0';
      ctx.fillStyle = 'rgba(26,95,208,0.07)';
      tracePath(ctx, lassoNow || this.selection.path);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    const sel = this.drawing?.sel?.x1 !== undefined ? normRect(this.drawing.sel.x0, this.drawing.sel.y0, this.drawing.sel.x1, this.drawing.sel.y1) : lassoNow || lassoSel ? null : this.selection;
    if (sel) {
      ctx.save();
      ctx.setLineDash([6 / view.z, 5 / view.z]);
      ctx.lineWidth = 1.5 / view.z;
      ctx.strokeStyle = '#1a5fd0';
      ctx.fillStyle = 'rgba(26,95,208,0.06)';
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
      ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
      ctx.restore();
    }
    if (this.locked) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = 'rgba(26,95,208,0.35)';
      ctx.lineWidth = 4 * scale;
      ctx.strokeRect(2 * scale, 2 * scale, ctx.canvas.width - 4 * scale, ctx.canvas.height - 4 * scale);
      ctx.restore();
    }
  }

  // Paper: this page's own choice, else the default for new pages. Never part of what Claude sees.
  paperOf(page = this.page) { return page?.paper || settings.paper || 'dots'; }

  setPaper(style) {
    this.page.paper = style;
    this.render();
    this.saveSoon();
  }

  drawGrid(ctx, view, vis) {
    const style = this.paperOf();
    if (style === 'plain') return;
    const step = Math.max(16, Number(settings.paperSpacing) || 40);
    const x0 = Math.floor(vis.x / step) * step, y0 = Math.floor(vis.y / step) * step;
    if (style === 'dots') {
      if (view.z < 0.45) return;
      ctx.fillStyle = '#d9dce1';
      const r = 1.1 / view.z;
      for (let x = x0; x < vis.x + vis.w; x += step)
        for (let y = y0; y < vis.y + vis.h; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
      return;
    }
    if (view.z < 0.3) return;
    ctx.save();
    ctx.lineWidth = 1 / view.z;
    ctx.strokeStyle = style === 'grid' ? '#e2e6ec' : '#d6dde8';
    ctx.beginPath();
    for (let y = y0; y < vis.y + vis.h; y += step) { ctx.moveTo(vis.x, y); ctx.lineTo(vis.x + vis.w, y); }
    if (style === 'grid') for (let x = x0; x < vis.x + vis.w; x += step) { ctx.moveTo(x, vis.y); ctx.lineTo(x, vis.y + vis.h); }
    ctx.stroke();
    if (style === 'ruled' && vis.x < 0 && vis.x + vis.w > 0) {
      // a notebook's margin line
      ctx.strokeStyle = '#f0c4c4';
      ctx.beginPath(); ctx.moveTo(0, vis.y); ctx.lineTo(0, vis.y + vis.h); ctx.stroke();
    }
    ctx.restore();
  }

  drawBlock(ctx, b) {
    if (ctx === this.ctx && this.unready?.has(b.id)) return;
    const lay = this.layouts.get(b.id);
    if (b.kind !== 'image' && this.ws().aiSideBar !== false) {
      ctx.fillStyle = b.color + '55';
      // while it is being written, the side bar grows with the lines
      const an = ctx === this.ctx && this.anims?.get(b.id), its = an && this.layouts.get(b.id)?.items;
      let bh = b.h || 24;
      if (its?.length) { const i = Math.min(its.length - 1, Math.floor((performance.now() - an.t0) / an.per)); bh = Math.min(bh, its[i].y + its[i].h); }
      const pad = this.blockPad(b);
      ctx.fillRect(b.x - pad - 2.5, b.y - pad * 0.25, 2.5, bh + pad * 0.5);
    }
    if (!lay || (this.noImageBlocks && b.kind !== 'image')) {
      ctx.fillStyle = b.color || '#1a5fd0';
      ctx.font = `${b.fontPx || 22}px ${FONT}`;
      ctx.textBaseline = 'top';
      (b.lines || []).forEach((ln, i) => ctx.fillText(String(ln), b.x, b.y + i * (b.fontPx || 22) * 1.6));
      return;
    }
    if (b.kind === 'image') {
      try { ctx.drawImage(lay.items[0].img, b.x, b.y, b.w, b.h); } catch {}
      return;
    }
    // while its corner handle is being dragged, the block is shown stretched; on release it is typeset at the new size
    const k = lay.w > 0 && b.w > 0 ? b.w / lay.w : 1;
    if (Math.abs(k - 1) > 0.01) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(k, k);
      ctx.translate(-b.x, -b.y);
      try { this.drawItems(ctx, b, lay); } finally { ctx.restore(); }
      return;
    }
    this.drawItems(ctx, b, lay);
  }

  drawItems(ctx, b, lay) {
    const an = ctx === this.ctx && this.anims?.get(b.id);
    const now = an ? performance.now() : 0;
    for (const [i, it] of lay.items.entries()) {
      let restore = false;
      if (an) {
        const p = Math.max(0, Math.min(1, (now - an.t0 - i * an.per) / an.per));
        if (p <= 0) break; // not written yet (nor anything after it)
        if (p < 1 && an.style === 'fade') { ctx.save(); ctx.globalAlpha = p; restore = true; }
        else if (p < 1 && an.style === 'write') {
          const e = 1 - Math.pow(1 - p, 1.6); // a pen slows down slightly towards the end of a line
          ctx.save(); ctx.beginPath(); ctx.rect(b.x + it.x - 2, b.y + it.y - 4, (it.w + 4) * e, it.h + 8); ctx.clip(); restore = true;
        }
      }
      try { this.drawItem(ctx, b, it); } finally { if (restore) ctx.restore(); }
    }
  }

  drawItem(ctx, b, it) {
    {
      if (it.img) {
        try { ctx.drawImage(it.img, b.x + it.x, b.y + it.y, it.w, it.h); } catch {}
      } else {
        ctx.fillStyle = it.color || b.color;
        ctx.font = `${it.bold ? '650 ' : ''}${it.fontPx}px ${it.serif ? `Georgia, 'Times New Roman', serif` : FONT}`;
        ctx.textBaseline = 'top';
        ctx.fillText(it.text, b.x + it.x, b.y + it.y + it.fontPx * 0.1);
        const extra = (b.strokePx || 0) - it.fontPx * 0.075; // thicker than the font's own lines: outline the letters too
        if (extra > 0.2) { ctx.strokeStyle = b.color; ctx.lineWidth = extra; ctx.lineJoin = 'round'; ctx.strokeText(it.text, b.x + it.x, b.y + it.y + it.fontPx * 0.1); }
      }
    }
  }
}
