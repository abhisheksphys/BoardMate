// PDF library: stored in the browser, text-indexed per page, searchable, viewable page by page.
// Two scopes: the shared library (added in Settings, visible in every session) and session materials
// (added from the 📎 button, visible only in the sessions they belong to). One stored copy can serve both.
import { idb } from './storage.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsPromise = null;

function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      const s = document.createElement('script');
      s.src = PDFJS + 'pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsPromise = null; reject(new Error('Could not load pdf.js')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

// Books saved before sessions existed have no scope fields: they are shared.
const isGlobal = (b) => b.global !== false;
const visibleIn = (b, sessionId) => isGlobal(b) || (sessionId && (b.sessions || []).includes(sessionId));

// sessionId given = add to that session only; omitted = add to the shared library.
export async function addPdf(file, onProgress, { sessionId = null } = {}) {
  const base = file.name.replace(/\.pdf$/i, '');
  const same = await idb.get('library', base);
  if (same && same.data?.byteLength === file.size) {
    // already stored: just widen its scope
    if (sessionId) same.sessions = [...new Set([...(same.sessions || []), sessionId])];
    else same.global = true;
    await idb.set('library', base, same);
    return { id: base, pages: same.pages.length, reused: true };
  }
  const id = same ? `${base} (${Math.random().toString(36).slice(2, 6)})` : base;
  const lib = await pdfjs();
  const buf = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buf.slice(0) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    pages.push(tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' '));
    onProgress?.(i, doc.numPages);
  }
  await idb.set('library', id, { id, name: file.name, data: buf, pages, added: Date.now(), global: !sessionId, sessions: sessionId ? [sessionId] : [] });
  return { id, pages: doc.numPages };
}

// Books visible in a session (shared + its own). only: 'global' | 'session' to narrow.
export async function listBooks(sessionId = null, { only } = {}) {
  const all = (await idb.all('library')) || [];
  return all
    .filter((b) => visibleIn(b, sessionId))
    .map((b) => ({ id: b.id, name: b.name, pages: b.pages.length, scope: isGlobal(b) ? 'global' : 'session', inSession: !!sessionId && (b.sessions || []).includes(sessionId) }))
    .filter((b) => (only === 'global' ? b.scope === 'global' : only === 'session' ? b.inSession : true));
}

// With sessionId: take it out of that session. Without: take it out of the shared library.
// The stored file is deleted once nothing uses it.
export async function removeBook(id, sessionId = null) {
  const b = await idb.get('library', id);
  if (!b) return;
  if (sessionId) b.sessions = (b.sessions || []).filter((s) => s !== sessionId);
  else b.global = false;
  if (!isGlobal(b) && !(b.sessions || []).length) await idb.del('library', id);
  else await idb.set('library', id, b);
}

export async function copySessionBooks(fromId, toId) {
  for (const b of (await idb.all('library')) || []) {
    if ((b.sessions || []).includes(fromId)) {
      b.sessions = [...b.sessions, toId];
      await idb.set('library', b.id, b);
    }
  }
}

export async function dropSessionBooks(sessionId) {
  for (const b of (await idb.all('library')) || []) {
    if ((b.sessions || []).includes(sessionId)) await removeBook(b.id, sessionId);
  }
}

export async function searchLibrary(query, k = 6, sessionId = null) {
  const books = ((await idb.all('library')) || []).filter((b) => visibleIn(b, sessionId));
  const terms = String(query).toLowerCase().split(/[\s,.;:()\[\]{}"'!?]+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits = [];
  for (const b of books) {
    const scope = isGlobal(b) ? 'shared library' : 'this session';
    b.pages.forEach((txt, i) => {
      const low = txt.toLowerCase();
      let score = 0, first = -1, matched = 0;
      for (const t of terms) {
        let c = 0, idx = low.indexOf(t);
        if (idx >= 0) { matched++; if (first < 0 || idx < first) first = idx; }
        while (idx >= 0 && c < 50) { c++; idx = low.indexOf(t, idx + t.length); }
        if (c) score += 1 + Math.log(c);
      }
      if (score) hits.push({ book: b.id, scope, page: i + 1, score: +(score * (matched / terms.length)).toFixed(2), snippet: txt.slice(Math.max(0, first - 150), first + 250) });
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

async function findBook(ref, sessionId) {
  const exact = await idb.get('library', ref);
  if (exact && visibleIn(exact, sessionId)) return exact;
  const all = ((await idb.all('library')) || []).filter((b) => visibleIn(b, sessionId));
  const q = String(ref).toLowerCase();
  return all.find((b) => b.id.toLowerCase().includes(q) || q.includes(b.id.toLowerCase())) || null;
}

export async function renderPage(bookRef, pageNum, scale = 1.35, sessionId = null) {
  const b = await findBook(bookRef, sessionId);
  if (!b) throw new Error('Book not found in the shared library or this session: ' + bookRef);
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: b.data.slice(0) }).promise;
  const n = Math.min(Math.max(1, Math.round(pageNum) || 1), doc.numPages);
  const pg = await doc.getPage(n);
  const vp = pg.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = vp.width;
  cv.height = vp.height;
  await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  return { dataUrl: cv.toDataURL('image/jpeg', 0.85), w: vp.width, h: vp.height, book: b.id, page: n };
}
