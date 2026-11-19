// Your own PDF library: stored in the browser, text-indexed per page, searchable, and viewable page by page.
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

export async function addPdf(file, onProgress) {
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
  const id = file.name.replace(/\.pdf$/i, '');
  await idb.set('library', id, { id, name: file.name, data: buf, pages, added: Date.now() });
  return { id, pages: doc.numPages };
}

export async function listBooks() {
  const all = (await idb.all('library')) || [];
  return all.map((b) => ({ id: b.id, name: b.name, pages: b.pages.length }));
}

export async function removeBook(id) {
  await idb.del('library', id);
}

export async function searchLibrary(query, k = 6) {
  const books = (await idb.all('library')) || [];
  const terms = String(query).toLowerCase().split(/[\s,.;:()\[\]{}"'!?]+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits = [];
  for (const b of books) {
    b.pages.forEach((txt, i) => {
      const low = txt.toLowerCase();
      let score = 0, first = -1, matched = 0;
      for (const t of terms) {
        let c = 0, idx = low.indexOf(t);
        if (idx >= 0) { matched++; if (first < 0 || idx < first) first = idx; }
        while (idx >= 0 && c < 50) { c++; idx = low.indexOf(t, idx + t.length); }
        if (c) score += 1 + Math.log(c);
      }
      if (score) hits.push({ book: b.id, page: i + 1, score: +(score * (matched / terms.length)).toFixed(2), snippet: txt.slice(Math.max(0, first - 150), first + 250) });
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

async function findBook(ref) {
  const exact = await idb.get('library', ref);
  if (exact) return exact;
  const all = (await idb.all('library')) || [];
  const q = String(ref).toLowerCase();
  return all.find((b) => b.id.toLowerCase().includes(q) || q.includes(b.id.toLowerCase())) || null;
}

export async function renderPage(bookRef, pageNum, scale = 1.6) {
  const b = await findBook(bookRef);
  if (!b) throw new Error('Book not found: ' + bookRef);
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
