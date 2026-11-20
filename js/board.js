// The ink board: Pencil/pressure strokes, eraser, select/move, pan/zoom, pages, undo,
// typeset AI blocks, margin marks, and image snapshots for Claude.
import { emit, uid, union, sleep } from './bus.js';
import { settings } from './settings.js';
import { texToImage, lineToTex } from './mathrender.js';
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

export function strokeBBox(s) {
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

  get page() { return this.pages[this.pi]; }

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
    this.backStack = (this.backStack || []).filter((id) => this.pages.some((p) => p.id === id));
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

  // A jump (overview, page number, search, Claude) remembers where you were, for the Back button.
  // Swiping to the next page is not a jump.
  jumpTo(i, { remember = true } = {}) {
    if (!this.pages[i] || i === this.pi) return;
    if (remember) { (this.backStack ||= []).push(this.page.id); if (this.backStack.length > 20) this.backStack.shift(); }
    if (this.layout && Math.abs(i - this.pi) === 1 && !remember) this.flipTo(i - this.pi);
    else this.goto(i);
  }

  goBack() {
    while (this.backStack?.length) {
      const i = this.pages.findIndex((p) => p.id === this.backStack.pop());
      if (i >= 0 && i !== this.pi) { this.goto(i); return true; }
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
    const keep = this.pi;
    this.pi = i;
    try {
      await Promise.all(this.page.blocks.map((b) => (this.layouts.has(b.id) ? null : this.layoutBlock(b))));
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
    } finally {
      this.pi = keep;
    }
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
    await this.bgReady(this.pages[i]);
    const keep = this.pi;
    this.pi = i;
    try {
      await Promise.all(this.page.blocks.map((b) => (this.layouts.has(b.id) ? null : this.layoutBlock(b))));
      return { snap: this.snapshot(opts), page: this.page };
    } finally {
      this.pi = keep;
    }
  }

  // Keeps something Claude wrote (or a picture) on the page; writing that no longer fits continues on the next page.
  async keepOnPage(b) {
    if (!this.layout || !b) return null;
    const s = this.pageSize(), m = PAGE_INSET;
    if ((b.w || 0) > s.w - 2 * m) await this.scaleBlock(b.id, (s.w - 2 * m) / b.w);
    b.x = clamp(b.x, m, Math.max(m, s.w - m - (b.w || 0)));
    b.y = Math.max(m, b.y);
    if (b.y + (b.h || 0) <= s.h - m || b.kind === 'image' || (b.h || 0) > s.h - 2 * m) {
      b.y = Math.min(b.y, Math.max(m, s.h - m - (b.h || 0)));
      this.render();
      this.saveSoon();
      return null;
    }
    const from = this.pi;
    this.page.blocks.splice(this.page.blocks.indexOf(b), 1);
    this.render();
    // continues on the next page; never on top of a PDF page's print: then a blank page is put in after this one
    if (from + 1 >= this.pages.length) this.newPage();
    else if (this.pages[from + 1].bg) { const np = this.newPage(); this.pages.pop(); this.pages.splice(from + 1, 0, np); this.renumber(); emit('changed'); }
    const next = this.pages[from + 1];
    let bottom = m;
    for (const st of next.strokes) { const bb = strokeBBox(st); bottom = Math.max(bottom, bb.y + bb.h + 20); }
    for (const x of next.blocks) bottom = Math.max(bottom, x.y + (x.h || 0) + 20);
    b.y = bottom;
    next.blocks.push(b);
    this.goto(from + 1);
    this.markDirty({ x: b.x, y: b.y, w: b.w || 0, h: b.h || 0 });
    this.saveSoon();
    return { page: from + 1 };
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
      if (a && this.page.blocks.includes(a) && this.hitHandle(a, w, e.pointerType === 'touch')) {
        // drag the corner handle to resize (keeps proportions); Claude's blocks get a new letter size on release
        this.drawing = { ...base, resize: a, from: { x: a.x, y: a.y, w: a.w, h: a.h, fontPx: a.fontPx, strokePx: a.strokePx }, start: w };
      } else {
        const b = this.hitBlock(w, e.pointerType === 'touch');
        this.activeBlock = b;
        if (b) this.drawing = { ...base, move: b, from: { x: b.x, y: b.y }, start: w };
        else this.drawing = { ...base, sel: { x0: w.x, y0: w.y } };
      }
    } else if (this.tool === 'lasso') {
      this.drawing = { ...base, lasso: [[w.x, w.y]] };
    }
    this.renderLive();
  }

  hitHandle(b, w, finger = false) {
    const r = (finger ? 34 : 24) / this.page.view.z; // a fingertip needs a bigger target than the Pencil
    return Math.hypot(w.x - (b.x + b.w), w.y - (b.y + b.h)) < r;
  }

  grabbable(e) {
    const p = this.evtPos(e);
    const w = this.toWorld(p.sx, p.sy);
    const a = this.activeBlock;
    return (a && this.page.blocks.includes(a) && this.hitHandle(a, w, true)) || !!this.hitBlock(w, true);
  }

  deleteActiveBlock() {
    const b = this.activeBlock;
    if (!b || !this.page.blocks.includes(b)) return false;
    this.page.blocks = this.page.blocks.filter((x) => x !== b);
    this.pushUndo({ remove: { blocks: [b] } });
    this.activeBlock = null;
    this.markDirty({ x: b.x, y: b.y, w: b.w || 1, h: b.h || 1 });
    this.render();
    this.saveSoon();
    return true;
  }

  onMove(e) {
    if (this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.evtPos(e));
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
      else if (d.resize) {
        const fw = d.from.w || 100, fh = d.from.h || 30;
        // the handle follows the Pencil diagonally: use whichever direction was dragged more
        const k = Math.max((fw + (w.x - d.start.x)) / fw, (fh + (w.y - d.start.y)) / fh);
        const min = Math.max(30 / this.page.view.z / fw, d.resize.kind === 'image' ? 0 : 8 / (d.from.fontPx || 22));
        const max = d.resize.kind === 'image' ? 20 : 160 / (d.from.fontPx || 22);
        d.k = Math.min(max, Math.max(min, k));
        d.resize.w = fw * d.k;
        d.resize.h = fh * d.k;
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
      if (this.touches.size) { if (this.slide) { this.slide = 0; this.pullAdd = false; this.render(); } this.startGesture(); }
      else {
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
      if (d.move.x !== d.from.x || d.move.y !== d.from.y) {
        this.pushUndo({ move: { id: d.move.id, from: d.from, to: { x: d.move.x, y: d.move.y } } });
        this.markDirty({ x: d.move.x, y: d.move.y, w: d.move.w || 1, h: d.move.h || 1 });
      }
    } else if (d.resize) {
      const b = d.resize;
      if (d.k && Math.abs(d.k - 1) > 0.01) {
        if (b.kind !== 'image') {
          // Claude's text and maths: typeset again at the new size (stays sharp), not stretched
          b.fontPx = (d.from.fontPx || 22) * d.k;
          if (d.from.strokePx) b.strokePx = d.from.strokePx * d.k;
          this.layouts.delete(b.id);
          this.layoutBlock(b).then(() => { this.render(); this.saveSoon(); });
        }
        this.pushUndo({ move: { id: b.id, from: d.from, to: { x: b.x, y: b.y, w: b.w, h: b.h, fontPx: b.fontPx, strokePx: b.strokePx } } });
        this.markDirty({ x: b.x, y: b.y, w: b.w, h: b.h });
      } else Object.assign(b, { w: d.from.w, h: d.from.h });
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

  // ---------- change tracking ----------
  markDirty(bb) {
    this.dirty = union(this.dirty, bb);
    emit('changed');
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      const d = this.dirty;
      this.dirty = null;
      if (d) emit('settled', d);
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
        const before = b.fontPx;
        Object.assign(b, reverse ? op.move.from : op.move.to);
        if (b.kind !== 'image' && b.fontPx !== before) { this.layouts.delete(b.id); this.layoutBlock(b); }
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
    const s = settings;
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
    this.afterHistory();
  }

  redo() {
    const op = this.redoStack.pop();
    if (!op) return;
    this.applyOp(op, false);
    this.undoStack.push(op);
    this.afterHistory();
  }

  afterHistory() {
    const bb = this.contentBounds();
    if (bb) this.markDirty(bb);
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

  hitMark(w) {
    if (!settings.showMarks) return null;
    const r = 14 / this.page.view.z;
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

    // Claude's typeset blocks and margin marks go whole when touched.
    for (const b of [...P.blocks]) {
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
    const gap = fontPx * 0.45;
    const items = [];
    let y = 0, w = 0;
    for (const line of b.lines) {
      const L = lineToTex(line);
      let im = null;
      if (!L.plain) im = await texToImage(L.tex, { color: b.color, display: L.display, fontPx, strokePx: b.strokePx || 0 });
      if (im?.error) im = null; // broken LaTeX: shown as text (never as a solid block)
      if (im) {
        items.push({ img: im.img, x: 0, y, w: im.w, h: im.h });
        y += im.h + gap;
        w = Math.max(w, im.w);
      } else {
        const text = L.plain ? L.text : String(line);
        this.ctx.font = `${fontPx}px ${FONT}`;
        const tw = this.ctx.measureText(text).width;
        items.push({ text, x: 0, y, w: tw, h: fontPx * 1.3, fontPx });
        y += fontPx * 1.3 + gap;
        w = Math.max(w, tw);
      }
    }
    const lay = { items, w, h: Math.max(fontPx, y - gap) };
    b.w = lay.w;
    b.h = lay.h;
    this.layouts.set(b.id, lay);
    this.render();
    return lay;
  }

  prepareBlocks() {
    for (const b of this.page.blocks) if (!this.layouts.has(b.id)) this.layoutBlock(b);
  }

  async addBlock({ lines = [], x, y, kind = 'math', src, w, h, fontPx = 22, color, strokePx = 0 }, { animateMs = 0, signal, author = 'ai' } = {}) {
    const b = { id: uid(), kind, x, y, lines: [], color: color || settings.aiColor, fontPx, strokePx, author, src, w, h };
    this.page.blocks.push(b);
    if (kind === 'math' && animateMs > 0 && lines.length > 1) {
      for (const ln of lines) {
        if (signal?.aborted) break;
        b.lines.push(ln);
        await this.layoutBlock(b);
        this.ensureVisible({ x: b.x, y: b.y, w: b.w, h: b.h });
        await sleep(animateMs);
      }
    } else {
      b.lines = [...lines];
      await this.layoutBlock(b);
    }
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
      const scale = Math.min(1, 520 / w, (s.w - 2 * PAGE_INSET) / w);
      const b = await this.addBlock({ kind: 'image', src, x: PAGE_INSET, y: cb ? cb.y + cb.h + 30 : PAGE_INSET, w: w * scale, h: h * scale });
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
  snapshot({ region = null, maxDim = 1400, maxScale = 2, pad = 30 } = {}) {
    let bb = region || this.contentBounds() || (this.layout ? this.pageRect() : this.visibleWorld());
    if (this.layout && !region) {
      // what is on the page (writing off the page's edge is not part of it)
      const pr = this.pageRect();
      const x0 = Math.max(bb.x, 0), y0 = Math.max(bb.y, 0), x1 = Math.min(bb.x + bb.w, pr.w), y1 = Math.min(bb.y + bb.h, pr.h);
      bb = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : pr;
    }
    bb = { x: bb.x - pad, y: bb.y - pad, w: bb.w + 2 * pad, h: bb.h + 2 * pad };
    let scale = Math.min(maxScale, maxDim / Math.max(bb.w, bb.h));
    if (!region && scale < 0.5) {
      const vis = this.visibleWorld();
      bb = { x: vis.x, y: vis.y, w: vis.w, h: vis.h };
      scale = Math.min(maxScale, maxDim / Math.max(bb.w, bb.h));
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
    return { b64: data.split(',')[1], dataUrl: data, media_type: 'image/jpeg', bounds: bb, scale, width: W, height: H };
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
    if (ab) {
      const pad = 4 / view.z;
      ctx.save();
      ctx.strokeStyle = '#1a5fd0';
      ctx.lineWidth = 1.5 / view.z;
      ctx.strokeRect(ab.x - pad, ab.y - pad, (ab.w || 100) + 2 * pad, (ab.h || 30) + 2 * pad);
      if (this.tool === 'select') { // the resize handle (images and Claude's blocks)
        const hr = 7 / view.z;
        ctx.beginPath();
        ctx.arc(ab.x + ab.w, ab.y + ab.h, hr, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2 / view.z;
        ctx.stroke();
      }
      ctx.restore();
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
    const lay = this.layouts.get(b.id);
    if (b.kind !== 'image') {
      ctx.fillStyle = b.color + '55';
      ctx.fillRect(b.x - 9, b.y, 2.5, b.h || 24);
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
    for (const it of lay.items) {
      if (it.img) {
        try { ctx.drawImage(it.img, b.x + it.x, b.y + it.y, it.w, it.h); } catch {}
      } else {
        ctx.fillStyle = b.color;
        ctx.font = `${it.fontPx}px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.fillText(it.text, b.x + it.x, b.y + it.y + it.fontPx * 0.1);
        const extra = (b.strokePx || 0) - it.fontPx * 0.075; // thicker than the font's own lines: outline the letters too
        if (extra > 0.2) { ctx.strokeStyle = b.color; ctx.lineWidth = extra; ctx.lineJoin = 'round'; ctx.strokeText(it.text, b.x + it.x, b.y + it.y + it.fontPx * 0.1); }
      }
    }
  }
}
