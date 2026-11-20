// Export the open session: a PDF of the pages as written (ink, Claude's blocks, pictures, paper), or a
// LaTeX document that Claude types up from the pages (download as .tex or open in Overleaf to compile).
// Files are handed over with buttons in the panel, because iPad only saves or shares from a tap.
import { settings } from './settings.js';
import { claude, textOf } from './claude.js';
import { priceOf, fmt } from './costs.js';
import { idb } from './storage.js';

const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
const A4 = { w: 210, h: 297 }; // mm

let jspdfLoading;
function loadJsPDF() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  jspdfLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSPDF;
    s.onload = () => (window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('PDF library did not load')));
    s.onerror = () => { jspdfLoading = null; reject(new Error('Could not load the PDF library (are you online?)')); };
    document.head.append(s);
  });
  return jspdfLoading;
}

const PDFLIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
let pdflibLoading;
function loadPdfLib() {
  if (window.PDFLib?.PDFDocument) return Promise.resolve(window.PDFLib);
  pdflibLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFLIB;
    s.onload = () => (window.PDFLib?.PDFDocument ? resolve(window.PDFLib) : reject(new Error('PDF library did not load')));
    s.onerror = () => { pdflibLoading = null; reject(new Error('Could not load the PDF library (are you online?)')); };
    document.head.append(s);
  });
  return pdflibLoading;
}

const safeName = (t) => String(t || 'Live Board').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Live Board';

// Runs fn with page i as the board's page (without showing it), its blocks laid out, then switches back.
async function withPage(board, i, fn) {
  const keep = board.pi;
  board.pi = i;
  try {
    await Promise.all(board.page.blocks.map((b) => (board.layouts.has(b.id) ? null : board.layoutBlock(b))));
    return await fn(board.page);
  } finally {
    board.pi = keep;
    board.prepareBlocks();
  }
}

// Only your ink and Claude's blocks (no PDF page, no paper) on a transparent background, the size of the page: PNG bytes.
async function inkLayer(board, widthPx = 1800) {
  const s = board.pageSize();
  const scale = widthPx / s.w;
  const W = Math.round(s.w * scale), H = Math.round(s.h * scale);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const paint = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    board.skipBg = true;
    try { board.drawContent(ctx, { z: scale, ox: 0, oy: 0 }, 1, { x: 0, y: 0, w: s.w, h: s.h }, false); }
    finally { board.skipBg = false; }
  };
  paint();
  let url;
  try { url = cv.toDataURL('image/png'); }
  catch { board.noImageBlocks = true; paint(); board.noImageBlocks = false; url = cv.toDataURL('image/png'); }
  cv.width = cv.height = 0;
  return url;
}

const PAPER_MM = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Square: [210, 210] };

// A notebook page as one image of the whole sheet, and its size in mm.
function notebookPage(board, widthPx = 1600) {
  const s = board.pageSize();
  const scale = widthPx / s.w;
  const W = Math.round(s.w * scale), H = Math.round(s.h * scale);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const paint = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    board.drawContent(ctx, { z: scale, ox: 0, oy: 0 }, 1, { x: 0, y: 0, w: s.w, h: s.h }, true);
  };
  paint();
  let url;
  try { url = cv.toDataURL('image/jpeg', 0.9); }
  catch { board.noImageBlocks = true; paint(); board.noImageBlocks = false; url = cv.toDataURL('image/jpeg', 0.9); }
  let [mw, mh] = PAPER_MM[board.layout.size] || PAPER_MM.A4;
  if (board.layout.orient === 'landscape') [mw, mh] = [mh, mw];
  return { url, mw, mh };
}

// A page as A4-shaped JPEG slices at print resolution (one canvas per slice: iPad limits canvas size).
function pageSlices(board, widthPx = 1600) {
  const cb = board.contentBounds();
  if (!cb) return [];
  const pad = 40;
  const bb = { x: cb.x - pad, y: cb.y - pad, w: cb.w + 2 * pad, h: cb.h + 2 * pad };
  const scale = Math.min(3, widthPx / bb.w);
  const W = Math.round(bb.w * scale), H = Math.round(bb.h * scale);
  const sliceH = Math.round((W * A4.h) / A4.w);
  const out = [];
  for (let top = 0; top < H; top += sliceH) {
    const h = Math.min(sliceH, H - top);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = h;
    const ctx = cv.getContext('2d');
    const view = { z: scale, ox: -bb.x * scale, oy: -bb.y * scale - top };
    const paint = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, h);
      board.drawContent(ctx, view, 1, null, true); // with the page's paper
    };
    paint();
    let url;
    try { url = cv.toDataURL('image/jpeg', 0.9); }
    catch { board.noImageBlocks = true; paint(); board.noImageBlocks = false; url = cv.toDataURL('image/jpeg', 0.9); }
    out.push({ url, w: W, h });
  }
  return out;
}

function fileButtons(panel, file, extra = []) {
  const url = URL.createObjectURL(file);
  const save = {
    label: `Save ${file.name.split('.').pop().toUpperCase()}`,
    run: async () => {
      // iPad: the share sheet ("Save to Files", Mail, AirDrop…); elsewhere a normal download
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
    },
  };
  return [save, ...extra];
}

export class Exporter {
  constructor({ board, panel, sessions }) {
    this.board = board;
    this.panel = panel;
    this.sessions = sessions;
  }

  title() { return this.sessions?.meta?.title || 'Live Board'; }

  pagesWithContent() {
    const b = this.board;
    return b.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.strokes.length || p.blocks.length);
  }

  // ---------- PDF of the pages as written ----------
  async pdf() {
    const notebook = !!this.board.layout;
    // a notebook exports every page (blank ones too), each at its paper size
    const pages = notebook ? this.board.pages.map((p, i) => ({ p, i })) : this.pagesWithContent();
    if (!pages.length) return this.panel.add('info', 'This session has nothing on its pages yet.');
    this.panel.status('Making the PDF…');
    try {
      if (notebook && this.board.pages.some((p) => p.bg)) return await this.pdfOnOriginal(pages);
      const JsPDF = await loadJsPDF();
      if (notebook) {
        let doc;
        for (const { i } of pages) {
          const pg = await withPage(this.board, i, () => notebookPage(this.board));
          const fmt = [pg.mw, pg.mh], orient = pg.mw > pg.mh ? 'l' : 'p';
          if (!doc) doc = new JsPDF({ unit: 'mm', format: fmt, orientation: orient, compress: true });
          else doc.addPage(fmt, orient);
          doc.addImage(pg.url, 'JPEG', 0, 0, pg.mw, pg.mh, undefined, 'FAST');
        }
        const file = new File([doc.output('blob')], `${safeName(this.title())}.pdf`, { type: 'application/pdf' });
        this.panel.add('info', `PDF ready: ${pages.length} page(s) of "${this.title()}" (${this.board.layout.size}).`, { actions: fileButtons(this.panel, file), noLog: true });
        return { ok: true, pages: pages.length };
      }
      const doc = new JsPDF({ unit: 'mm', format: 'a4', compress: true });
      let first = true;
      for (const { i } of pages) {
        const slices = await withPage(this.board, i, () => pageSlices(this.board));
        for (const s of slices) {
          if (!first) doc.addPage();
          first = false;
          doc.addImage(s.url, 'JPEG', 0, 0, A4.w, (A4.w * s.h) / s.w, undefined, 'FAST');
        }
      }
      const file = new File([doc.output('blob')], `${safeName(this.title())}.pdf`, { type: 'application/pdf' });
      this.panel.add('info', `PDF ready: ${pages.length} page(s) of "${this.title()}", as written.`, { actions: fileButtons(this.panel, file), noLog: true });
      return { ok: true, pages: pages.length };
    } catch (e) {
      this.panel.add('error', 'Could not make the PDF: ' + (e.message || e));
      return { ok: false, error: e.message };
    } finally {
      this.panel.status('');
    }
  }

  // ---------- PDF notebook: your writing flattened onto the ORIGINAL PDF pages ----------
  // Each PDF page is copied as it is (text stays text, same size), with a transparent picture of your ink and
  // Claude's blocks drawn on top; blank pages you added are new pages at their own size, in place. The PDF stored
  // in the app is never changed: this makes a new file.
  async pdfOnOriginal(pages) {
    const b = this.board;
    const PDFLib = await loadPdfLib();
    const { PDFDocument, degrees } = PDFLib;
    const out = await PDFDocument.create();
    const sources = new Map(); // pdf id -> PDFDocument or null (could not be read: then pages are pictures)
    let pictures = 0;
    for (const [k, { p, i }] of pages.entries()) {
      this.panel.status(`Making the PDF: page ${k + 1} of ${pages.length}…`);
      const hasInk = p.strokes.length || p.blocks.length;
      if (p.bg) {
        if (!sources.has(p.bg.pdf)) {
          let src = null;
          try {
            const rec = await idb.get('library', p.bg.pdf);
            if (rec?.data) src = await PDFDocument.load(rec.data.slice(0), { ignoreEncryption: true, updateMetadata: false });
          } catch { src = null; }
          sources.set(p.bg.pdf, src);
        }
        const src = sources.get(p.bg.pdf);
        if (src && p.bg.page <= src.getPageCount()) {
          const [page] = await out.copyPages(src, [p.bg.page - 1]);
          out.addPage(page);
          if (hasInk) {
            const png = await withPage(b, i, () => inkLayer(b));
            const img = await out.embedPng(png);
            const cb = page.getCropBox();
            const rot = ((page.getRotation().angle % 360) + 360) % 360;
            // the picture is upright as you see the page; a rotated PDF page needs it drawn turned the other way
            const place = {
              0: { x: cb.x, y: cb.y, width: cb.width, height: cb.height, rotate: degrees(0) },
              90: { x: cb.x + cb.width, y: cb.y, width: cb.height, height: cb.width, rotate: degrees(90) },
              180: { x: cb.x + cb.width, y: cb.y + cb.height, width: cb.width, height: cb.height, rotate: degrees(180) },
              270: { x: cb.x, y: cb.y + cb.height, width: cb.height, height: cb.width, rotate: degrees(270) },
            }[rot] || { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
            page.drawImage(img, place);
          }
          continue;
        }
        // the original could not be read for copying (e.g. encrypted): the page as a picture, same size
        await b.bgReady(p, 2000);
        pictures++;
      }
      const s = b.pageSize(p);
      const jpg = await withPage(b, i, () => notebookPage(b, 1800).url);
      const page = out.addPage([(s.w * 72) / 96, (s.h * 72) / 96]);
      const img = await out.embedJpg(jpg);
      page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    out.setTitle(this.title());
    out.setCreator('Live Board');
    const bytes = await out.save();
    const file = new File([bytes], `${safeName(this.title())}.pdf`, { type: 'application/pdf' });
    const blanks = pages.filter(({ p }) => !p.bg).length;
    this.panel.add('info', `PDF ready: ${pages.length} page(s) of "${this.title()}": your writing on the original PDF pages${blanks ? `, with ${blanks} added blank page(s) in place` : ''}.${pictures ? ` ${pictures} page(s) could not be copied from the original PDF (it may be protected) and are pictures instead.` : ''}`, { actions: fileButtons(this.panel, file), noLog: true });
    return { ok: true, pages: pages.length };
  }

  // ---------- LaTeX typed up by Claude ----------
  estimate(n) {
    const p = priceOf(settings.models.main);
    return fmt((n * (2500 * p.in + 3500 * p.out)) / 1e6);
  }

  async latex({ confirmFirst = true } = {}) {
    const pages = this.pagesWithContent();
    if (!pages.length) return this.panel.add('info', 'This session has nothing on its pages yet.');
    if (!settings.apiKey) return this.panel.add('error', 'Add your Anthropic API key in Settings first.');
    if (confirmFirst && !confirm(`Claude (${settings.models.main}) will type up ${pages.length} page(s) as LaTeX.\nEstimated cost: about ${this.estimate(pages.length)}.\n\nGo ahead?`)) return { ok: false, error: 'cancelled' };
    const bodies = [];
    try {
      for (const [k, { i }] of pages.entries()) {
        this.panel.status(`Claude is typing up page ${k + 1} of ${pages.length}…`);
        await this.board.bgReady(this.board.pages[i], 1600);
        const content = await withPage(this.board, i, (page) => {
          const snap = this.board.snapshot({ maxDim: 1600, maxScale: 2 });
          const mine = page.blocks.filter((b) => b.kind !== 'image' && b.lines?.length).map((b) => b.lines.join('\n'));
          const notes = (page.notebook || []).map((e) => `${e.latex}${e.description ? `   % ${e.description}` : ''}`);
          return [
            { type: 'image', source: { type: 'base64', media_type: snap.media_type, data: snap.b64 } },
            { type: 'text', text: `Page "${page.name}".${page.bg ? ' This page is a printed PDF page with the user\'s handwriting on top: type up only the handwriting (and the blue blocks), not the print; mention the printed item it refers to only if needed for sense.' : ''}${mine.length ? `\nBlue typeset blocks on this page (exact LaTeX, written by the assistant):\n${mine.join('\n---\n')}` : ''}${notes.length ? `\nEarlier transcription notes for this page (may be incomplete):\n${notes.join('\n')}` : ''}\n\nType this page up.` },
          ];
        });
        const resp = await claude({ model: settings.models.main, system: TEX_SYSTEM, messages: [{ role: 'user', content }], max_tokens: 16000, purpose: 'export' });
        let body = textOf(resp).trim().replace(/^```(?:latex|tex)?\s*/i, '').replace(/```\s*$/, '').trim();
        body = body.replace(/\\documentclass[\s\S]*?\\begin\{document\}/, '').replace(/\\end\{document\}/, '').trim();
        bodies.push(`\\section*{${texEscape(this.board.pages[i].name)}}\n${body}`);
      }
    } catch (e) {
      this.panel.status('');
      this.panel.add('error', 'Could not finish the LaTeX: ' + (e.message || e));
      return { ok: false, error: e.message };
    }
    this.panel.status('');
    const tex = `\\documentclass[11pt]{article}
\\usepackage[a4paper,margin=2.2cm]{geometry}
\\usepackage{amsmath,amssymb,amsfonts,mathtools,bm}
\\usepackage{graphicx}
\\title{${texEscape(this.title())}}
\\date{${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}}
\\begin{document}
\\maketitle

${bodies.join('\n\n')}

\\end{document}
`;
    const file = new File([tex], `${safeName(this.title())}.tex`, { type: 'application/x-tex' });
    const overleaf = { label: 'Open in Overleaf', run: () => openInOverleaf(tex) };
    this.panel.add('info', `LaTeX ready: ${pages.length} page(s), typed up by Claude. Check it against your pages: handwriting can be misread. "Open in Overleaf" compiles it into a typeset PDF (free Overleaf account).`, { actions: fileButtons(this.panel, file, [overleaf]), noLog: true });
    return { ok: true, pages: pages.length };
  }
}

const texEscape = (s) => String(s).replace(/[\\{}$&#%_^~]/g, (c) => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }[c] || '\\' + c));

// Overleaf's "open as new project" endpoint: a form POST with the LaTeX as `snip`.
function openInOverleaf(tex) {
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = 'https://www.overleaf.com/docs';
  f.target = '_blank';
  const i = document.createElement('input');
  i.type = 'hidden';
  i.name = 'snip';
  i.value = tex;
  f.append(i);
  document.body.append(f);
  f.submit();
  f.remove();
}

const TEX_SYSTEM = `You type up one page of a scientist's handwritten whiteboard as LaTeX.
- Output ONLY the LaTeX body for this page: no preamble, no \\begin{document}, no code fences, no commentary.
- Reproduce what is on the page faithfully, in reading order: the user's equations, derivation steps and words, and the blue typeset blocks (use their exact LaTeX).
- Use align* / equation* for displayed math; keep the user's notation (vectors as \\mathbf or \\vec as written, partials, indices). Fix nothing silently: if something is unreadable, write \\textbf{[?]} there; if the user crossed something out, leave it out.
- Only these packages are loaded: amsmath, amssymb, amsfonts, mathtools, bm, graphicx. Do not use other packages or custom macros.
- For a drawing, plot or pasted picture, write a short placeholder: \\fbox{\\parbox{0.9\\linewidth}{Figure: <one-line description>}}.
- Margin marks (small circled symbols) and the paper's dots or lines are not content.`;
