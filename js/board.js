// The ink board: Pencil/pressure strokes, eraser, select/move, pan/zoom, pages, undo,
// typeset AI blocks, margin marks, and image snapshots for Claude.
import { emit, uid, union, sleep } from './bus.js';
import { settings } from './settings.js';
import { texToImage, lineToTex } from './mathrender.js';

const FONT = '-apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif';
const r1 = (v) => Math.round(v * 10) / 10;
const dist = (a, b) => Math.hypot(a.sx - b.sx, a.sy - b.sy);
const mid = (a, b) => ({ sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const normRect = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });

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
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.bindInput();
  }

  get page() { return this.pages[this.pi]; }

  newPage(name) {
    const p = { id: uid(), name: name || `Page ${this.pages.length + 1}`, strokes: [], blocks: [], marks: [], notebook: [], view: { ox: 40, oy: 40, z: 1 } };
    this.pages.push(p);
    return p;
  }

  load(pages) {
    this.pages = Array.isArray(pages) ? pages : [];
    if (!this.pages.length) this.newPage();
    for (const p of this.pages) { p.notebook ||= []; p.marks ||= []; p.blocks ||= []; p.view ||= { ox: 40, oy: 40, z: 1 }; }
    this.goto(0);
  }

  goto(i) {
    if (i < 0 || i >= this.pages.length) return;
    this.pi = i;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.activeBlock = null;
    this.prepareBlocks();
    this.render();
    emit('page', { page: this.page, index: i, count: this.pages.length });
  }

  addPage() { this.newPage(); this.goto(this.pages.length - 1); this.saveSoon(); }

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
    if (this.page) this.render();
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
    this.render();
  }

  ensureVisible(rect) {
    const vis = this.visibleWorld();
    const inside = rect.x >= vis.x && rect.y >= vis.y && rect.x + rect.w <= vis.x + vis.w && rect.y + rect.h <= vis.y + vis.h;
    if (inside) return;
    const v = this.page.view;
    v.ox = this.w * 0.15 - rect.x * v.z;
    v.oy = this.h * 0.2 - rect.y * v.z;
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
    c.addEventListener('pointerleave', () => { if (!this.drawing && this.eraserCursor) { this.eraserCursor = null; this.renderLive(); } });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { sx, sy } = this.evtPos(e);
      if (e.ctrlKey || e.metaKey) this.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.01));
      else { this.page.view.ox -= e.deltaX; this.page.view.oy -= e.deltaY; this.render(); }
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
      if (a && a.kind === 'image' && this.page.blocks.includes(a) && this.hitHandle(a, w, e.pointerType === 'touch')) {
        // drag the corner handle to resize (keeps the image's proportions)
        this.drawing = { ...base, resize: a, from: { x: a.x, y: a.y, w: a.w, h: a.h }, start: w };
      } else {
        const b = this.hitBlock(w);
        this.activeBlock = b;
        if (b) this.drawing = { ...base, move: b, from: { x: b.x, y: b.y }, start: w };
        else this.drawing = { ...base, sel: { x0: w.x, y0: w.y } };
      }
    }
    this.renderLive();
  }

  hitHandle(b, w, finger = false) {
    const r = (finger ? 30 : 18) / this.page.view.z; // a fingertip needs a bigger target than the Pencil
    return Math.hypot(w.x - (b.x + b.w), w.y - (b.y + b.h)) < r;
  }

  grabbable(e) {
    const p = this.evtPos(e);
    const w = this.toWorld(p.sx, p.sy);
    const a = this.activeBlock;
    return (a && a.kind === 'image' && this.page.blocks.includes(a) && this.hitHandle(a, w, true)) || !!this.hitBlock(w);
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
        const nw = Math.max(30 / this.page.view.z, d.from.w + (w.x - d.start.x));
        d.resize.w = nw;
        d.resize.h = (nw * d.from.h) / d.from.w;
      }
      else if (d.sel) { d.sel.x1 = w.x; d.sel.y1 = w.y; }
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
      this.touches.delete(e.pointerId);
      this.gesture = null;
      if (this.touches.size) this.startGesture();
      else this.saveSoon();
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
      if (b.w !== d.from.w) {
        this.pushUndo({ move: { id: b.id, from: d.from, to: { x: b.x, y: b.y, w: b.w, h: b.h } } });
        this.markDirty({ x: b.x, y: b.y, w: b.w, h: b.h });
      }
    } else if (d.sel) {
      const s = d.sel;
      const big = s.x1 !== undefined && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) > 8 / this.page.view.z;
      this.selection = big ? normRect(s.x0, s.y0, s.x1, s.y1) : null;
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
    if (pts.length === 1) this.gesture = { kind: 'pan', p0: pts[0], o0: { x: v.ox, y: v.oy } };
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
    if (g.kind === 'pan' && pts.length === 1) {
      v.ox = g.o0.x + pts[0].sx - g.p0.sx;
      v.oy = g.o0.y + pts[0].sy - g.p0.sy;
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
      if (b) Object.assign(b, reverse ? op.move.from : op.move.to);
    }
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
  hitBlock(w) {
    for (let i = this.page.blocks.length - 1; i >= 0; i--) {
      const b = this.page.blocks[i];
      const pad = 6;
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
      if (!L.plain) im = await texToImage(L.tex, { color: b.color, display: L.display, fontPx });
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

  async addBlock({ lines = [], x, y, kind = 'math', src, w, h }, { animateMs = 0, signal, author = 'ai' } = {}) {
    const b = { id: uid(), kind, x, y, lines: [], color: settings.aiColor, fontPx: 22, author, src, w, h };
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

  pinImage(src, w, h) {
    const scale = Math.min(1, 520 / w);
    const cb = this.contentBounds();
    const vis = this.visibleWorld();
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
    let bb = region || this.contentBounds() || this.visibleWorld();
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
      if (this.needFull) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.c.width, this.c.height);
        this.drawContent(this.ctx, v, this.dpr, null, true);
      } else {
        if (this.pendingRegion) this.redrawRegion(this.pendingRegion);
        if (this.pendingStrokes.length) {
          this.ctx.setTransform(this.dpr * v.z, 0, 0, this.dpr * v.z, this.dpr * v.ox, this.dpr * v.oy);
          for (const s of this.pendingStrokes) drawStroke(this.ctx, s);
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
    const rr = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
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
    if (grid) this.drawGrid(ctx, view, vis);
    for (const b of this.page.blocks) if (meets({ x: b.x - 12, y: b.y, w: (b.w || 200) + 12, h: b.h || 40 })) this.drawBlock(ctx, b);
    for (const s of this.page.strokes) if (meets(strokeBBox(s))) drawStroke(ctx, s);
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
      if (ab.kind === 'image') {
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
    const sel = this.drawing?.sel?.x1 !== undefined ? normRect(this.drawing.sel.x0, this.drawing.sel.y0, this.drawing.sel.x1, this.drawing.sel.y1) : this.selection;
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

  drawGrid(ctx, view, vis) {
    if (view.z < 0.45) return;
    const step = 40;
    ctx.fillStyle = '#d9dce1';
    const r = 1.1 / view.z;
    for (let x = Math.floor(vis.x / step) * step; x < vis.x + vis.w; x += step)
      for (let y = Math.floor(vis.y / step) * step; y < vis.y + vis.h; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
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
    for (const it of lay.items) {
      if (it.img) {
        try { ctx.drawImage(it.img, b.x + it.x, b.y + it.y, it.w, it.h); } catch {}
      } else {
        ctx.fillStyle = b.color;
        ctx.font = `${it.fontPx}px ${FONT}`;
        ctx.textBaseline = 'top';
        ctx.fillText(it.text, b.x + it.x, b.y + it.y + it.fontPx * 0.1);
      }
    }
  }
}
