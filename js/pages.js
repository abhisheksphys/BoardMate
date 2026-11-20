// Page navigation: the floating page number (with Back and a bookmark star) and the Pages overview —
// thumbnails of every page to jump to, search across pages (Claude's notes, its blocks, page names),
// starred pages, go to page N, and page operations (insert, duplicate, rename, delete, drag to reorder).
import { on } from './bus.js';
import { pageText as pdfPageText } from './pdfbg.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Search works on words and on maths: "∇·B", "\nabla \cdot \mathbf{B}" and "nabla cdot B" all match each other.
const SYM = { '∇': 'nabla', '·': 'cdot', '×': 'times', '∂': 'partial', 'ρ': 'rho', 'ε': 'epsilon', 'ϵ': 'epsilon', 'μ': 'mu', 'φ': 'phi', 'ϕ': 'phi', 'ψ': 'psi', 'θ': 'theta', 'λ': 'lambda', 'ω': 'omega', 'Ω': 'omega', 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'Δ': 'delta', 'σ': 'sigma', 'τ': 'tau', 'π': 'pi', 'ħ': 'hbar', '∫': 'int', '∮': 'oint', '∑': 'sum', '√': 'sqrt', '∞': 'infty', '≈': 'approx', '→': 'to', '²': '^2', '³': '^3', '₀': '_0' };
export function normSearch(s) {
  return String(s || '').toLowerCase()
    .replace(/./gu, (c) => (SYM[c] ? ` ${SYM[c]} ` : c))
    .replace(/\\(mathbf|mathrm|boldsymbol|bm|vec|left|right|quad|qquad|,|;|!)/g, ' ')
    .replace(/varepsilon/g, 'epsilon').replace(/varphi/g, 'phi')
    .replace(/[\\{}$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageText(p, printed = '') {
  return [
    p.name,
    printed,
    ...(p.notebook || []).map((e) => `${e.latex} ${e.description || ''}`),
    ...(p.blocks || []).filter((b) => b.lines?.length).map((b) => b.lines.join(' ')),
  ].join(' \n ');
}

// does the page match? returns a short reason (what matched) or null
export function pageMatch(p, query, printed = '') {
  const q = normSearch(query);
  if (!q) return '';
  const text = normSearch(pageText(p, printed));
  const squash = (s) => s.replace(/\s+/g, '');
  const hit = squash(text).includes(squash(q)) || q.split(' ').filter((w) => w.length > 1).every((w) => text.includes(w));
  if (!hit) return null;
  if (printed && !squash(normSearch(pageText({ ...p, name: '' }))).includes(squash(q))) {
    // found in the printed PDF text: show the line it is on
    const line = printed.split('\n').find((l) => { const t = normSearch(l); return squash(t).includes(squash(q)) || q.split(' ').some((w) => w.length > 2 && t.includes(w)); });
    if (line && !(p.notebook || []).length) return `“${line.trim().slice(0, 70)}”`;
  }
  const notes = (p.notebook || []).find((e) => { const t = normSearch(`${e.latex} ${e.description || ''}`); return squash(t).includes(squash(q)) || q.split(' ').some((w) => w.length > 1 && t.includes(w)); });
  return notes ? notes.description || notes.latex : p.name;
}

export class PageNav {
  constructor({ board, panel }) {
    this.board = board;
    this.panel = panel;
    this.dlg = $('#pagesDlg');
    this.query = '';
    this.starredOnly = false;
    this.menuFor = null;
    this.printed = new Map();
    on('page', () => this.updateBadge());
    on('session', () => setTimeout(() => this.updateBadge(), 0));
    $('#pageBadgeBtn').addEventListener('click', () => this.open());
    $('#pageStarBtn').addEventListener('click', () => { this.board.toggleStar(); this.updateBadge(); });
    $('#pageBackBtn').addEventListener('click', () => this.board.goBack());
    this.bindDialog();
  }

  // ---------- floating cluster, bottom left: [← back] [☆] [3 / 12] ----------
  updateBadge() {
    const b = this.board;
    if (!b.page) return;
    $('#pageBadge').hidden = !(b.layout || b.pages.length > 1);
    $('#pageNow').textContent = b.pi + 1;
    $('#pageCount').textContent = b.pages.length;
    const star = $('#pageStarBtn');
    star.classList.toggle('on', !!b.page.starred);
    star.textContent = b.page.starred ? '★' : '☆';
    star.title = b.page.starred ? 'Starred: tap to remove the bookmark' : 'Bookmark this page';
    // Back: to the page before your last jump
    const stack = b.backStack || [];
    let target = -1;
    for (let k = stack.length - 1; k >= 0 && target < 0; k--) { const i = b.pages.findIndex((p) => p.id === stack[k]); if (i >= 0 && i !== b.pi) target = i; }
    $('#pageBackBtn').hidden = target < 0;
    if (target >= 0) $('#pageBackBtn').textContent = `← Page ${target + 1}`;
    if (this.dlg.open) this.render();
  }

  // ---------- the Pages overview ----------
  open() {
    this.menuFor = null;
    $('#pgGoto').value = '';
    $('#pgGotoOf').textContent = `of ${this.board.pages.length}`;
    this.dlg.showModal();
    this.render();
  }

  close() { this.dlg.close(); }

  go(i) {
    this.close();
    this.board.jumpTo(i);
  }

  visible() {
    const b = this.board;
    if (this.query) this.loadPrinted();
    return b.pages.map((p, i) => ({ p, i, why: pageMatch(p, this.query, p.bg ? this.printed.get(`${p.bg.pdf}|${p.bg.page}`) || '' : '') }))
      .filter((x) => x.why !== null && (!this.starredOnly || x.p.starred));
  }

  // PDF notebooks: search also looks in the printed text of the PDF pages (read once, in the background)
  async loadPrinted() {
    if (this.printedRun) return;
    const todo = this.board.pages.filter((p) => p.bg && !this.printed.has(`${p.bg.pdf}|${p.bg.page}`));
    if (!todo.length) return;
    this.printedRun = true;
    try {
      for (const [k, p] of todo.entries()) {
        try { this.printed.set(`${p.bg.pdf}|${p.bg.page}`, (await pdfPageText(p.bg)).text); } catch { this.printed.set(`${p.bg.pdf}|${p.bg.page}`, ''); }
        if (k % 20 === 19 && this.dlg.open && this.query) this.render();
      }
    } finally { this.printedRun = false; }
    if (this.dlg.open && this.query) this.render();
  }

  render() {
    const b = this.board;
    const list = this.visible();
    const starred = b.pages.filter((p) => p.starred).length;
    $('#pgStarChip').textContent = `★ Starred${starred ? ` (${starred})` : ''}`;
    $('#pgStarChip').classList.toggle('active', this.starredOnly);
    $('#pgAllChip').classList.toggle('active', !this.starredOnly);
    $('#pgCount').textContent = this.query || this.starredOnly ? `${list.length} of ${b.pages.length} pages` : `${b.pages.length} page${b.pages.length === 1 ? '' : 's'}`;
    const grid = $('#pgGrid');
    grid.classList.toggle('notebook', !!b.layout);
    grid.innerHTML = list.map(({ p, i, why }) => `
      <div class="pg-tile${i === b.pi ? ' current' : ''}" data-i="${i}">
        <button type="button" class="pg-thumb" data-go="${i}" aria-label="Go to page ${i + 1}"><img alt="" data-thumb="${i}"></button>${p.bg ? `<span class="pg-pdf">PDF p.${p.bg.page}</span>` : ''}
        <div class="pg-foot">
          <span class="pg-num">${i + 1}</span>
          <span class="pg-name">${esc(p.name)}${why && why !== p.name ? `<small>${esc(String(why).slice(0, 60))}</small>` : ''}</span>
          <button type="button" class="pg-star${p.starred ? ' on' : ''}" data-star="${i}" aria-label="${p.starred ? 'Remove bookmark' : 'Bookmark'}">${p.starred ? '★' : '☆'}</button>
          <button type="button" class="pg-more" data-more="${i}" aria-label="Page options">⋯</button>
          <span class="pg-grip" data-grip="${i}" title="Drag to move" aria-label="Drag to move">⠿</span>
        </div>
        <div class="pg-menu"${this.menuFor === i ? '' : ' hidden'}>
          <button type="button" data-act="insert" data-i="${i}">Insert blank page after</button>
          <button type="button" data-act="dup" data-i="${i}">Duplicate</button>
          <button type="button" data-act="rename" data-i="${i}">Rename</button>
          <button type="button" data-act="delete" data-i="${i}" class="danger">Delete</button>
        </div>
      </div>`).join('') || `<div class="pg-empty">${this.starredOnly && !this.query ? 'No starred pages yet: tap ☆ on a page to bookmark it.' : 'No page matches. Search looks in Claude\'s notes on each page, its typeset blocks, page names and the printed text of PDF pages; pages Claude hasn\'t looked at yet have no notes.'}</div>`;
    this.fillThumbs(list.map((x) => x.i));
  }

  // thumbnails one by one, so the sheet opens at once even in a long notebook
  async fillThumbs(indices) {
    const run = (this.thumbRun = (this.thumbRun || 0) + 1);
    for (const i of indices) {
      if (run !== this.thumbRun || !this.dlg.open) return;
      const url = await this.board.thumbnail(i);
      const img = this.dlg.querySelector(`img[data-thumb="${i}"]`);
      if (img && url) img.src = url;
      await new Promise((r) => requestAnimationFrame(r));
    }
  }

  async act(act, i) {
    const b = this.board;
    this.menuFor = null;
    if (act === 'insert') b.insertPage(i + 1);
    else if (act === 'dup') b.duplicatePage(i);
    else if (act === 'rename') {
      const name = prompt('Page name', b.pages[i].name);
      if (name && name.trim()) { b.pages[i].name = name.trim(); b.pages[i].customName = true; b.saveSoon(); }
    } else if (act === 'delete') {
      const p = b.pages[i];
      const empty = !p.strokes.length && !p.blocks.length;
      if (!empty && !confirm(`Delete "${p.name}" and everything on it? This can't be undone.`)) return this.render();
      b.deletePage(i);
    }
    this.render();
    this.updateBadge();
  }

  bindDialog() {
    const d = this.dlg;
    $('#pgClose').addEventListener('click', () => this.close());
    $('#pgSearch').addEventListener('input', (e) => { this.query = e.target.value; this.render(); });
    $('#pgAllChip').addEventListener('click', () => { this.starredOnly = false; this.render(); });
    $('#pgStarChip').addEventListener('click', () => { this.starredOnly = true; this.render(); });
    $('#pgAdd').addEventListener('click', () => { this.board.insertPage(this.board.pages.length); this.render(); this.updateBadge(); });
    $('#pgGotoForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = $('#pgGoto').value, n = Math.round(Number(raw));
      if (!(n >= 1 && n <= this.board.pages.length)) { $('#pgGotoOf').textContent = `no page ${raw || '?'} (1–${this.board.pages.length})`; return; }
      this.go(n - 1);
    });
    d.addEventListener('click', (e) => {
      if (e.target === d) return this.close();
      const t = e.target.closest('[data-go],[data-star],[data-more],[data-act]');
      if (!t) { if (this.menuFor !== null && !e.target.closest('.pg-menu')) { this.menuFor = null; this.render(); } return; }
      if (t.dataset.go !== undefined) return this.go(Number(t.dataset.go));
      if (t.dataset.star !== undefined) { this.board.toggleStar(Number(t.dataset.star)); return this.render(); }
      if (t.dataset.more !== undefined) { const i = Number(t.dataset.more); this.menuFor = this.menuFor === i ? null : i; return this.render(); }
      if (t.dataset.act) return this.act(t.dataset.act, Number(t.dataset.i));
    });
    // drag a page by its grip to move it
    d.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('[data-grip]');
      if (!grip) return;
      e.preventDefault();
      const from = Number(grip.dataset.grip);
      const tile = grip.closest('.pg-tile');
      tile.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch {}
      let to = from;
      const move = (ev) => {
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pg-tile');
        d.querySelectorAll('.pg-tile').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
        if (!under || under === tile) { to = from; return; }
        const r = under.getBoundingClientRect(), j = Number(under.dataset.i);
        const after = ev.clientX > r.left + r.width / 2;
        under.classList.add(after ? 'drop-after' : 'drop-before');
        to = after ? j + 1 : j;
        if (to > from) to -= 1; // the dragged page leaves its old place first
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        tile.classList.remove('dragging');
        if (to !== from && !this.query && !this.starredOnly) this.board.movePage(from, to);
        this.render();
        this.updateBadge();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }
}
