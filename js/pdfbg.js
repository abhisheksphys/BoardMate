// Backgrounds of PDF notebook pages: PDF.js renders a page only when it is needed (the page you are on, its
// neighbours, a thumbnail, a picture for Claude), into a small cache that is limited by total size, and
// again sharper when you zoom in. The original PDF is never changed: your ink stays a separate layer.
// Page sizes are in board units: 96 per inch (PDF points × 96/72), so an A4 PDF page = a blank A4 page.
import { idb } from './storage.js';
import { pdfjs } from './library.js';

export const PT = 96 / 72; // board units per PDF point

const docs = new Map(); // pdf id -> Promise<PDFDocumentProxy>
const bitmaps = new Map(); // `${id}|${n}` -> { canvas, width, used }
const pending = new Map(); // `${id}|${n}|${width}` -> Promise
const texts = new Map(); // `${id}|${n}` -> Promise<{ text, items }>
const MAX_PIXELS = 26e6; // all cached backgrounds together (about 100 MB): iPad Safari limits canvas memory

export function getDoc(id) {
  if (!docs.has(id)) {
    docs.set(id, (async () => {
      const rec = await idb.get('library', id);
      if (!rec?.data) throw new Error('The PDF of this notebook is missing from this browser.');
      const lib = await pdfjs();
      return lib.getDocument({ data: rec.data.slice(0) }).promise;
    })());
    docs.get(id).catch(() => docs.delete(id));
  }
  return docs.get(id);
}

export async function pdfName(id) { return (await idb.get('library', id))?.name || 'PDF'; }

// The best background already rendered for a page (any sharpness), or null.
export function cachedBg(bg) {
  const hit = bitmaps.get(`${bg.pdf}|${bg.page}`);
  if (hit) hit.used = performance.now();
  return hit?.canvas || null;
}

const bucket = (px) => (px <= 700 ? 700 : px <= 1200 ? 1200 : px <= 1800 ? 1800 : 2400);

// Is a sharper render worth asking for at this on-screen width (pixels)? (false while one is already on its way)
export function bgNeedsBetter(bg, px) {
  const key = `${bg.pdf}|${bg.page}`, want = bucket(px);
  const have = bitmaps.get(key);
  if (have && have.width >= want) return false;
  if (failed.has(key)) return false;
  return !pending.has(`${key}|${want}`);
}
const failed = new Set();

// Render a page at (at least) `pxWidth` pixels wide; resolves to the canvas. Sharper copies replace blurrier ones.
export function renderBg(bg, pxWidth) {
  const key = `${bg.pdf}|${bg.page}`;
  const want = bucket(pxWidth);
  const have = bitmaps.get(key);
  if (have && have.width >= want) { have.used = performance.now(); return Promise.resolve(have.canvas); }
  const pk = `${key}|${want}`;
  if (pending.has(pk)) return pending.get(pk);
  const p = (async () => {
    const doc = await getDoc(bg.pdf);
    const page = await doc.getPage(bg.page);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: want / base.width });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const old = bitmaps.get(key);
    if (!old || old.width < cv.width) bitmaps.set(key, { canvas: cv, width: cv.width, used: performance.now() });
    trim();
    return bitmaps.get(key).canvas;
  })();
  pending.set(pk, p);
  p.then(() => pending.delete(pk), () => { pending.delete(pk); failed.add(key); });
  return p;
}

function trim() {
  let total = 0;
  for (const v of bitmaps.values()) total += v.canvas.width * v.canvas.height;
  if (total <= MAX_PIXELS) return;
  const old = [...bitmaps.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [k, v] of old) {
    if (total <= MAX_PIXELS * 0.75) break;
    total -= v.canvas.width * v.canvas.height;
    v.canvas.width = v.canvas.height = 0; // free the memory now (Safari)
    bitmaps.delete(k);
  }
}

// A small, separate picture for thumbnails (does not push the sharp page backgrounds out of the cache).
const thumbs = new Map();
export async function thumbBg(bg, width = 220) {
  const key = `${bg.pdf}|${bg.page}|${width}`;
  if (thumbs.has(key)) return thumbs.get(key);
  const p = (async () => {
    const doc = await getDoc(bg.pdf);
    const page = await doc.getPage(bg.page);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / base.width });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    return cv;
  })();
  thumbs.set(key, p);
  if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value);
  return p;
}

// The page's own text (what PDF.js extracts), with each line's box in board units, for Claude: exact
// small print, cheaper than a sharper picture. Maths in PDFs often extracts badly, so the image still goes too.
export function pageText(bg) {
  const key = `${bg.pdf}|${bg.page}`;
  if (!texts.has(key)) {
    texts.set(key, (async () => {
      const doc = await getDoc(bg.pdf);
      const page = await doc.getPage(bg.page);
      const vp = page.getViewport({ scale: PT });
      const tc = await page.getTextContent();
      // group into lines by baseline
      const lines = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        const h = Math.abs(it.transform[3]) * PT || 10;
        const w = (it.width || 0) * PT;
        const line = lines.find((l) => Math.abs(l.y - y) < h * 0.5);
        if (line) { line.parts.push({ x, s: it.str }); line.x0 = Math.min(line.x0, x); line.x1 = Math.max(line.x1, x + w); line.h = Math.max(line.h, h); }
        else lines.push({ y, h, x0: x, x1: x + w, parts: [{ x, s: it.str }] });
      }
      lines.sort((a, b) => a.y - b.y);
      const items = lines.map((l) => ({ text: l.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim(), x: l.x0, y: l.y - l.h, w: l.x1 - l.x0, h: l.h * 1.2 }));
      return { text: items.map((i) => i.text).join('\n'), items };
    })());
    texts.get(key).catch(() => texts.delete(key));
  }
  return texts.get(key);
}

// Only the printed lines inside a region (board units), e.g. around what you just wrote.
export async function textIn(bg, r) {
  const { items } = await pageText(bg);
  return items.filter((i) => i.x < r.x + r.w && i.x + i.w > r.x && i.y < r.y + r.h && i.y + i.h > r.y).map((i) => i.text).join('\n');
}

// Already-extracted text for a page (no work), for searching pages.
export const knownText = (bg) => (texts.has(`${bg.pdf}|${bg.page}`) ? texts.get(`${bg.pdf}|${bg.page}`) : null);

// Each page's size in board units (fast: no rendering).
export async function pageSizes(doc, onProgress) {
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: PT });
    out.push({ w: Math.round(vp.width * 10) / 10, h: Math.round(vp.height * 10) / 10 });
    if (i % 10 === 0) onProgress?.(i, doc.numPages);
  }
  return out;
}

export function rememberDoc(id, doc) { docs.set(id, Promise.resolve(doc)); }
