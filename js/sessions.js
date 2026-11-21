// Sessions: each one has its own pages, Claude conversation, notes, PDFs and spending.
// Everything saves automatically. When you leave a session, the fast model names it and writes a short
// summary (for search) and a "where you left off" recap (shown when you return).
// Also: subjects, pinning, search (incl. "ask Claude to find it"), branching, trash, backup/restore,
// and per-session PDF materials.
import { idb } from './storage.js';
import { settings, setSettings, WRITING_KEYS, WRITE_PRESETS } from './settings.js';
import { on, emit, uid, escapeHtml } from './bus.js';
import { claude, textOf, parseJSON } from './claude.js';
import { fmt } from './costs.js';
import { makePopover } from './inktools.js';
import { addPdf, listBooks, removeBook, copySessionBooks, dropSessionBooks, addNotebookPdf } from './library.js';
import { rememberDoc, pageSizes } from './pdfbg.js';

const $ = (s) => document.querySelector(s);
const DAY = 86400000;
const TRASH_DAYS = 30;
const CHAT_KEEP = 200;

const SUMMARY_SYSTEM = `You label work sessions from a scientist's handwriting whiteboard app. From the page image, the notes and the recent chat, reply with ONE JSON object only:
{"title":"at most 7 words, specific, e.g. Faraday's law from Maxwell's equations",
 "summary":"1-2 sentences: what was worked on and key results (used for search)",
 "recap":"1-2 sentences to the user: where they left off and what was next or unresolved"}`;

const FIND_SYSTEM = `You help a scientist find one of their past work sessions. Given the request and a list of sessions (id, title, subject, summary, notes), reply with ONE JSON object only:
{"matches":[{"id":"...","why":"a few words"}]}
Best match first, at most 5. Match on meaning: "curl of B" matches notes with \\nabla \\times \\mathbf{B}. Empty list if nothing fits.`;

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

const abToB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64ToAb = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

export class Sessions {
  constructor({ board, panel, agent }) {
    this.board = board;
    this.panel = panel;
    this.agent = agent;
    this.currentId = null;
    this.meta = null;
    this.chat = [];
    this.snap = null;
    this.filter = 'all';
    this.query = '';
    this.found = null; // results of "ask Claude to find"
    this.openMenu = null;
    // Folders (nest as deep as you like): kv 'folders' = [{ id, name, parent }]; a session's meta.folder is its
    // folder's id (null or a folder that no longer exists = the top level, where every older session lives).
    this.folders = [];
    this.folder = null; // the folder the drawer is showing (and where new sessions go)
  }

  // ---------- startup ----------
  async init() {
    this.bindUI(); // buttons respond even while saved sessions are still loading
    try { this.folders = (await idb.get('kv', 'folders')) || []; } catch { this.folders = []; }
    await this.purgeTrash();
    let metas = await this.allMetas();
    if (!metas.length) {
      // First run after the sessions update: your existing work becomes the first session.
      let old = null;
      try { old = await idb.get('pages', 'all'); } catch {}
      const hasWork = Array.isArray(old) && old.some((p) => p.strokes?.length || p.blocks?.length);
      await this.create({ pages: hasWork ? old : [], title: hasWork ? 'My first session' : 'Untitled session', titleAuto: true, dirty: hasWork });
      metas = await this.allMetas();
    }
    const live = metas.filter((m) => !m.deletedAt).sort((a, b) => b.updated - a.updated);
    let saved = null;
    try { saved = await idb.get('kv', 'currentSession'); } catch {}
    const target = live.find((m) => m.id === saved) || live[0];
    if (target) await this.open(target.id, { initial: true });
    else await this.newSession();

    this.panel.onLog = (role, md) => this.log(role, md);
    on('changed', () => this.markChanged());
    on('save', () => this.saveSoon());
    // a panel message you dismissed is also dropped from the saved chat, so it doesn't come back next time
    on('panel-dismiss', ({ role, md }) => {
      for (let i = this.chat.length - 1; i >= 0; i--) if (this.chat[i].role === role && this.chat[i].md === md) { this.chat.splice(i, 1); this.markChanged(); break; }
    });
    on('cost', ({ cost, purpose }) => {
      if (this.meta && purpose !== 'title' && purpose !== 'find') { this.meta.cost = (this.meta.cost || 0) + cost; this.saveSoon(); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.leave({ staying: true });
    });
  }

  // ---------- data ----------
  async allMetas() {
    const all = ((await idb.all('sessions')) || []).filter(Boolean);
    // the in-memory copy of the open session is the freshest
    return all.map((m) => (this.meta && m.id === this.meta.id ? this.meta : m));
  }

  async create({ pages = [], chat = [], exchanges = [], title = 'Untitled session', titleAuto = true, subject = '', parent = null, dirty = false, notesFrom, layout = null, folder } = {}) {
    const id = uid();
    const now = Date.now();
    // layout: null = freeform (endless page); { size, orient, scroll, paper } = notebook. The type is fixed at creation.
    // a new session goes into the folder the drawer is showing, unless told otherwise
    const meta = { id, title, titleAuto, subject, pinned: false, created: now, updated: now, deletedAt: null, cost: 0, thumb: null, summary: '', recap: '', searchText: '', parent, dirty, layout, folder: folder !== undefined ? folder : this.folderOk(this.folder) };
    await idb.set('sessions', id, meta);
    await idb.set('sessionData', id, { pages, chat, exchanges, snap: notesFrom?.snap || null });
    return id;
  }

  isEmpty() {
    return !this.board.pages.some((p) => p.strokes.length || p.blocks.length) && !this.chat.length;
  }

  notebook() {
    return this.board.pages.flatMap((p) => (p.notebook || []).map((e) => ({ latex: e.latex, description: e.description })));
  }

  searchTextFor(meta, chat, notebook) {
    const chatText = (chat || []).slice(-60).map((m) => m.md).join(' ').slice(-6000);
    const notes = (notebook || []).map((e) => `${e.latex} ${e.description || ''}`).join(' ');
    return [meta.title, meta.subject, meta.summary, notes, chatText].join(' ').toLowerCase();
  }

  log(role, md) {
    if (!this.meta || this.loading) return;
    this.chat.push({ role, md, t: Date.now() });
    if (this.chat.length > CHAT_KEEP) this.chat = this.chat.slice(-CHAT_KEEP);
    this.markChanged();
  }

  markChanged() {
    if (!this.meta || this.loading) return;
    this.meta.updated = Date.now();
    this.meta.dirty = true;
    this.contentChanged = true;
    this.saveSoon();
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 1000);
  }

  async save({ snapshot = false } = {}) {
    clearTimeout(this.saveTimer);
    if (!this.currentId || !this.meta || !this.board.page) return;
    const id = this.currentId, meta = this.meta;
    if (this.contentChanged || snapshot) {
      const empty = this.isEmpty();
      meta.thumb = empty ? null : this.board.snapshot({ maxDim: 240, maxScale: 0.6 }).b64;
      if (snapshot) this.snap = empty ? null : this.board.snapshot({ maxDim: 900, maxScale: 1 }).b64;
      meta.searchText = this.searchTextFor(meta, this.chat, this.notebook());
      this.contentChanged = false;
    }
    try {
      await idb.set('sessionData', id, { pages: this.board.pages, chat: this.chat, exchanges: this.agent.exchanges.slice(-Math.max(2, settings.maxHistory * 2)), snap: this.snap });
      await idb.set('sessions', id, meta);
    } catch (e) {
      this.panel.status('Could not save: ' + e.message);
    }
    this.renderTitle();
    this.renderDrawer();
  }

  // Saves the open session and, if it changed, asks the fast model for a title, summary and recap.
  async leave({ staying = false } = {}) {
    if (!this.meta) return;
    await this.save({ snapshot: true });
    const meta = this.meta;
    if (meta.dirty && settings.apiKey && !this.isEmpty()) {
      this.summarize(meta.id, { snap: this.snap, chat: this.chat.slice(-12), notebook: this.notebook(), title: meta.title });
    }
    if (!staying) this.agent.stop();
  }

  async summarize(id, { snap, chat, notebook, title }) {
    try {
      const chatText = chat.map((m) => `${m.role}: ${String(m.md).slice(0, 400)}`).join('\n');
      const content = [];
      if (snap) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: snap } });
      content.push({ type: 'text', text: `Current title: ${title}\nNotes (equations on the page): ${JSON.stringify(notebook.slice(-30))}\nRecent chat:\n${chatText || '(none)'}\n\nReturn the JSON only.` });
      const resp = await claude({ model: settings.models.fast, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content }], max_tokens: 3000, purpose: 'title' });
      const j = parseJSON(textOf(resp)) || {};
      const apply = (m) => {
        if (m.titleAuto && j.title) m.title = String(j.title).slice(0, 80);
        if (j.summary) m.summary = String(j.summary).slice(0, 400);
        if (j.recap) m.recap = String(j.recap).slice(0, 400);
        m.dirty = false;
        m.cost = (m.cost || 0) + (resp._cost || 0);
        m.searchText = this.searchTextFor(m, chat, notebook);
      };
      if (id === this.currentId) { apply(this.meta); await this.save(); }
      else {
        const m = await idb.get('sessions', id);
        if (!m) return;
        apply(m);
        await idb.set('sessions', id, m);
        this.renderDrawer();
      }
    } catch {
      /* naming is best-effort; it retries next time you leave the session */
    }
  }

  // ---------- open / new / branch / delete ----------
  async open(id, { initial = false } = {}) {
    if (!initial && id === this.currentId) return this.closeDrawer();
    if (!initial) await this.leave();
    const meta = await idb.get('sessions', id);
    if (!meta) return;
    const data = (await idb.get('sessionData', id)) || { pages: [], chat: [], exchanges: [] };
    this.loading = true;
    this.currentId = id;
    this.meta = meta;
    this.folder = this.folderOk(meta.folder); // the drawer shows where this session lives
    this.chat = data.chat || [];
    this.snap = data.snap || null;
    this.agent.stop();
    this.agent.exchanges = data.exchanges || [];
    this.agent.lastAskAt = Date.now();
    this.board.setLayout(meta.layout || null);
    this.board.setSessionWriting(meta.writing || null, { relayout: false }); // Claude's writing: this session's own, if set
    this.board.sessionPaper = meta.layout ? null : meta.paper || null; // freeform: this session's paper for new pages
    this.board.load(data.pages || []);
    this.panel.clear();
    for (const m of this.chat) this.panel.add(m.role, m.md, { noLog: true, actions: m.role === 'assistant' ? this.agent.answerActions(m.md) : undefined });
    if (meta.recap) this.panel.add('recap', `**Where you left off:** ${meta.recap}`, { noLog: true });
    else if (!this.chat.length) {
      this.panel.add('info', 'A fresh session. Write on the page, then ask about it: type below, tap the mic and talk, or tap a button. Select a region with ⬚ to point at something.', { noLog: true });
    }
    this.loading = false;
    this.contentChanged = false;
    try { await idb.set('kv', 'currentSession', id); } catch {}
    this.renderTitle();
    this.renderMaterials();
    emit('session', meta);
    if (!initial) this.closeDrawer();
  }

  async newSession(subject = '', { layout = null } = {}) {
    const id = await this.create({ subject: subject || (this.filter.startsWith('subject:') ? this.filter.slice(8) : ''), layout });
    await this.open(id, { initial: !this.currentId });
  }

  // Notebook from PDF: one notebook page per PDF page, the PDF page as its background. The PDF is stored once
  // (library store, kind 'notebook', hidden from the reference library) and never changed; pages only point to it.
  async newPdfNotebook(file, { paper = 'ruled', scroll = 'vertical' } = {}) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return this.panel.add('error', `${file.name} is not a PDF.`);
    const layout = { size: 'A4', orient: 'portrait', paper, scroll };
    const title = file.name.replace(/\.pdf$/i, '').slice(0, 80) || 'PDF notebook';
    const sid = await this.create({ title, titleAuto: false, layout });
    try {
      this.panel.status(`Opening ${file.name}…`);
      const { id, doc, numPages } = await addNotebookPdf(file, sid);
      rememberDoc(id, doc);
      const sizes = await pageSizes(doc, (i, n) => this.panel.status(`Reading ${file.name}: page ${i} of ${n}…`));
      const pages = sizes.map((sz, i) => ({ id: uid(), name: `Page ${i + 1}`, paper, strokes: [], blocks: [], marks: [], notebook: [], view: { ox: 40, oy: 40, z: 1 }, bg: { pdf: id, page: i + 1, w: sz.w, h: sz.h } }));
      const meta = await idb.get('sessions', sid);
      meta.layout = { ...layout, pdf: { id, name: file.name, pages: numPages } };
      await idb.set('sessions', sid, meta);
      await idb.set('sessionData', sid, { pages, chat: [], exchanges: [], snap: null });
      this.panel.status('');
      await this.open(sid, { initial: !this.currentId });
      this.panel.add('info', `${file.name}: ${numPages} page${numPages === 1 ? '' : 's'}. Write on any page; add a blank page between pages from the page number (bottom left) → ⋯ → Insert blank page after, or pull past the last page.`, { noLog: true });
    } catch (e) {
      this.panel.status('');
      await idb.del('sessions', sid).catch(() => {});
      await idb.del('sessionData', sid).catch(() => {});
      await dropSessionBooks(sid).catch(() => {});
      this.panel.add('error', `Could not open ${file.name} as a notebook: ${/password/i.test(e?.message || '') ? 'it is password-protected.' : e?.message || e}`);
    }
  }

  // The "New session" button: choose freeform or notebook (and the notebook's page setup).
  chooseNewSession() {
    const d = $('#newSessionDlg');
    this.nsType = null;
    d.querySelectorAll('.type-card').forEach((c) => c.classList.remove('on'));
    $('#nsOptions').hidden = true;
    $('#nsCreate').disabled = true;
    $('#nsCreate').textContent = 'Create';
    d.showModal();
  }

  // ---------- Page setup (toolbar icon next to the title, or ⋯ → Page setup) ----------
  // Freeform: the paper. Notebook: also page size, orientation and scrolling. Every choice applies at once.
  openPageSetup() {
    const d = $('#pageSetupDlg');
    const lay = this.meta?.layout;
    const set = (name, v) => d.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    d.querySelector('.ps-notebook').hidden = !lay;
    $('#psKind').textContent = lay ? '· notebook' : '· freeform';
    if (lay) { set('size', lay.size); set('orient', lay.orient); set('scroll', lay.scroll); }
    set('paper', this.board.paperOf());
    set('scope', 'page');
    this.fillWriting();
    $('#psHint').textContent = lay?.pdf
      ? 'PDF notebook: pages from the PDF keep their own size and have no paper; page size, orientation and paper apply to the blank pages you add.'
      : lay
      ? 'Changes show right away. A smaller page can hide writing near its edges (it is kept, just outside the page).'
      : 'Changes show right away. Claude’s writing: your defaults from Settings → Board, or this session’s own size, stroke, colour and style.';
    d.showModal();
  }

  // Page setup → Claude's writing in this session
  fillWriting() {
    const d = $('#pageSetupDlg'), w = this.meta?.writing;
    const set = (name, v) => d.querySelectorAll(`.seg[data-name="${name}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    set('wmode', w ? 'custom' : 'default');
    $('#psWriting').hidden = !w;
    if (!w) return;
    set('wstyle', w.writeStyle);
    $('#psSizeMode').value = w.aiSizeMode;
    const sizeKey = { mimic: 'aiSizeScale', manual: 'aiSizeManual', fixed: 'aiSizeFixed' }[w.aiSizeMode] || 'aiSizeScale';
    $('#psSizeVal').value = w[sizeKey];
    $('#psSizeVal').step = w.aiSizeMode === 'fixed' ? '1' : '0.05';
    $('#psSizeVal').title = w.aiSizeMode === 'fixed' ? 'points (12 = printed text)' : 'in units of your handwriting (1 = same)';
    $('#psWeightMode').value = w.aiWeightMode;
    $('#psWeightVal').value = w.aiWeightManual;
    $('#psWeightVal').hidden = w.aiWeightMode !== 'manual';
    $('#psColorMode').value = w.aiColorMode;
    $('#psColor').value = /^#[0-9a-f]{6}$/i.test(w.aiColor) ? w.aiColor : '#1a5fd0';
    $('#psColor').hidden = w.aiColorMode !== 'manual';
    $('#psMargin').value = String(w.writeMargin ?? settings.writeMargin);
    $('#psMarginV').value = String(w.writeMarginV ?? settings.writeMarginV);
    $('#psBlockPad').value = w.blockPadding ?? settings.blockPadding;
    $('#psBlockGap').value = w.blockGap ?? settings.blockGap;
  }

  async writingInput(id) {
    const w = this.meta?.writing;
    if (!w) return;
    const num = (el) => { const n = parseFloat(el.value); return Number.isFinite(n) ? n : undefined; };
    if (id === 'psSizeMode') await this.setWriting({ aiSizeMode: $('#psSizeMode').value });
    else if (id === 'psSizeVal') { const k = { mimic: 'aiSizeScale', manual: 'aiSizeManual', fixed: 'aiSizeFixed' }[w.aiSizeMode]; const n = num($('#psSizeVal')); if (k && n > 0) await this.setWriting({ [k]: n }); }
    else if (id === 'psWeightMode') await this.setWriting({ aiWeightMode: $('#psWeightMode').value });
    else if (id === 'psWeightVal') { const n = num($('#psWeightVal')); if (n >= 0) await this.setWriting({ aiWeightManual: n }); }
    else if (id === 'psColorMode') await this.setWriting({ aiColorMode: $('#psColorMode').value });
    else if (id === 'psColor') await this.setWriting({ aiColor: $('#psColor').value });
    else if (id === 'psMargin') await this.setWriting({ writeMargin: Number($('#psMargin').value) });
    else if (id === 'psMarginV') await this.setWriting({ writeMarginV: Number($('#psMarginV').value) });
    else if (id === 'psBlockPad') await this.setWriting({ blockPadding: $('#psBlockPad').value });
    else if (id === 'psBlockGap') await this.setWriting({ blockGap: $('#psBlockGap').value });
    this.fillWriting();
  }

  async pageSetupChoice(name, v) {
    if (name === 'wmode') { await this.setWriting(v === 'custom' ? (this.meta.writing ? {} : {}) : null); return this.fillWriting(); }
    if (name === 'wstyle') { const P = WRITE_PRESETS[v] || {}; await this.setWriting({ writeStyle: v, writeMargin: P.writeMargin, writeMarginV: P.writeMarginV, blockPadding: P.blockPadding, blockGap: P.blockGap }); return this.fillWriting(); }
    const d = $('#pageSetupDlg');
    const scope = d.querySelector('.seg[data-name="scope"] .on')?.dataset.v || 'page';
    const paper = d.querySelector('.seg[data-name="paper"] .on')?.dataset.v;
    if (['size', 'orient', 'scroll'].includes(name)) return this.setLayout({ [name]: v });
    if (name === 'paper' || (name === 'scope' && paper)) {
      // the paper goes on this page (or every page) and becomes the session's paper for new pages
      if (scope === 'all') { for (const p of this.board.pages) p.paper = paper; this.board.render(); this.board.saveSoon(); }
      else this.board.setPaper(paper);
      if (this.meta.layout) await this.setLayout({ paper });
      else { this.meta.paper = paper; this.board.sessionPaper = paper; await idb.set('sessions', this.meta.id, this.meta); }
    }
  }

  // Claude's writing in this session (Page setup): null = the defaults from Settings; else its own size, stroke,
  // colour and style preset. Takes effect at once (Claude's blocks are laid out again).
  async setWriting(patch) {
    if (!this.meta) return;
    if (patch === null) delete this.meta.writing;
    else {
      const base = this.meta.writing || Object.fromEntries(WRITING_KEYS.map((k) => [k, k === 'writeStyle' ? (WRITE_PRESETS[settings.writeStyle] ? settings.writeStyle : 'comfortable') : settings[k]]));
      this.meta.writing = { ...base, ...Object.fromEntries(Object.entries(patch).filter(([k]) => WRITING_KEYS.includes(k))) };
    }
    this.board.setSessionWriting(this.meta.writing || null);
    await idb.set('sessions', this.meta.id, this.meta);
  }

  // Notebook page setup, changeable any time (Page setup); the session type itself is not.
  async setLayout(patch) {
    if (!this.meta?.layout) return;
    this.meta.layout = { ...this.meta.layout, ...patch };
    this.board.setLayout(this.meta.layout);
    this.board.render();
    await idb.set('sessions', this.meta.id, this.meta);
  }

  async branch(id) {
    if (id === this.currentId) await this.save({ snapshot: true });
    const meta = await idb.get('sessions', id);
    const data = await idb.get('sessionData', id);
    if (!meta || !data) return;
    const copy = structuredClone(data);
    const newId = await this.create({
      pages: copy.pages, chat: copy.chat, exchanges: copy.exchanges,
      title: `${meta.title} (branch)`, titleAuto: false, subject: meta.subject, parent: id, notesFrom: { snap: copy.snap }, layout: meta.layout || null, folder: this.folderOk(meta.folder),
    });
    const m = await idb.get('sessions', newId);
    Object.assign(m, { summary: meta.summary, recap: meta.recap, thumb: meta.thumb, searchText: meta.searchText, writing: meta.writing ? structuredClone(meta.writing) : undefined });
    await idb.set('sessions', newId, m);
    await copySessionBooks(id, newId);
    await this.open(newId);
    this.panel.add('info', `This is a branch of **${escapeHtml(meta.title)}**. Change anything here; the original stays as it was.`, { noLog: true });
  }

  async trash(id) {
    const m = id === this.currentId ? this.meta : await idb.get('sessions', id);
    if (!m) return;
    m.deletedAt = Date.now();
    await idb.set('sessions', id, m);
    if (id === this.currentId) {
      const next = (await this.allMetas()).filter((x) => !x.deletedAt && x.id !== id).sort((a, b) => b.updated - a.updated)[0];
      this.meta = null;
      this.currentId = null;
      if (next) await this.open(next.id, { initial: true });
      else await this.newSession();
    }
    this.renderDrawer();
  }

  async restore(id) {
    const m = await idb.get('sessions', id);
    if (!m) return;
    m.deletedAt = null;
    await idb.set('sessions', id, m);
    this.renderDrawer();
  }

  async purge(id) {
    await idb.del('sessions', id);
    await idb.del('sessionData', id);
    await dropSessionBooks(id);
  }

  async purgeTrash() {
    for (const m of await this.allMetas()) if (m.deletedAt && Date.now() - m.deletedAt > TRASH_DAYS * DAY) await this.purge(m.id);
  }

  async update(id, patch) {
    if (id === this.currentId) { Object.assign(this.meta, patch); await this.save(); return; }
    const m = await idb.get('sessions', id);
    if (!m) return;
    Object.assign(m, patch);
    await idb.set('sessions', id, m);
    this.renderDrawer();
  }

  // ---------- folders ----------
  folderOk(id) { return id && this.folders.some((f) => f.id === id) ? id : null; }
  folderById(id) { return this.folders.find((f) => f.id === id) || null; }

  // [root … folder] for breadcrumbs and "in Physics › EM" labels
  folderPath(id) {
    const out = [];
    for (let f = this.folderById(id), n = 0; f && n < 50; f = this.folderById(f.parent), n++) out.unshift(f);
    return out;
  }

  folderLabel(id) { return this.folderPath(id).map((f) => f.name).join(' › '); }

  // the folder and everything inside it, at any depth
  folderAndBelow(id) {
    const ids = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const f of this.folders) if (f.parent && ids.has(f.parent) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }
    return ids;
  }

  async saveFolders() {
    try { await idb.set('kv', 'folders', this.folders); } catch (e) { this.panel.add('error', 'Could not save folders: ' + e.message, { noLog: true }); }
  }

  async newFolder() {
    const where = this.folderLabel(this.folder);
    const name = prompt(where ? `New folder inside "${where}"` : 'New folder', '');
    if (!name || !name.trim()) return;
    this.folders.push({ id: `f-${uid()}`, name: name.trim().slice(0, 80), parent: this.folderOk(this.folder), created: Date.now() });
    await this.saveFolders();
    this.renderDrawer();
  }

  async renameFolder(id) {
    const f = this.folderById(id);
    if (!f) return;
    const name = prompt('Folder name', f.name);
    if (!name || !name.trim()) return;
    f.name = name.trim().slice(0, 80);
    await this.saveFolders();
  }

  // Deleting a folder never deletes sessions: what was inside moves up one level.
  async deleteFolder(id) {
    const f = this.folderById(id);
    if (!f) return;
    const metas = (await this.allMetas()).filter((m) => m.folder === id);
    const subs = this.folders.filter((x) => x.parent === id);
    const up = this.folderLabel(f.parent) || 'the top level';
    if ((metas.length || subs.length) && !confirm(`Delete the folder "${f.name}"?\n\nNothing is deleted with it: its ${metas.length} session(s) and ${subs.length} folder(s) move to ${up}.`)) return;
    for (const x of subs) x.parent = f.parent || null;
    for (const m of metas) await this.update(m.id, { folder: f.parent || null });
    this.folders = this.folders.filter((x) => x.id !== id);
    if (this.folder === id) this.folder = f.parent || null;
    await this.saveFolders();
  }

  // The "Move to…" sheet: every folder as a tree; pick one (or the top level).
  pickFolder({ title, current, exclude = new Set() }) {
    return new Promise((resolve) => {
      const d = $('#moveDlg');
      $('#moveTitle').textContent = title;
      const rows = [];
      const walk = (parent, depth) => {
        for (const f of this.folders.filter((x) => (x.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
          if (exclude.has(f.id)) continue;
          rows.push(`<button type="button" class="mv-row${f.id === current ? ' here' : ''}" data-to="${f.id}" style="padding-left:${14 + depth * 22}px"${f.id === current ? ' disabled' : ''}><span class="mv-ico">📁</span>${escapeHtml(f.name)}${f.id === current ? ' <small>(here now)</small>' : ''}</button>`);
          walk(f.id, depth + 1);
        }
      };
      walk(null, 1);
      $('#moveList').innerHTML = `<button type="button" class="mv-row${!current ? ' here' : ''}" data-to=""${!current ? ' disabled' : ''}><span class="mv-ico">🗂</span>Sessions (top level)${!current ? ' <small>(here now)</small>' : ''}</button>${rows.join('')}`;
      const done = (v) => { d.removeEventListener('click', onClick); d.removeEventListener('close', onClose); if (d.open) d.close(); resolve(v); };
      const onClick = async (e) => {
        if (e.target === d || e.target.closest('#moveCancel')) return done(undefined);
        if (e.target.closest('#moveNew')) {
          const name = prompt('New folder (at the top level; move it later if you like)', '');
          if (name && name.trim()) {
            const f = { id: `f-${uid()}`, name: name.trim().slice(0, 80), parent: null, created: Date.now() };
            this.folders.push(f);
            await this.saveFolders();
            return done(f.id);
          }
          return;
        }
        const b = e.target.closest('[data-to]');
        if (b && !b.disabled) done(b.dataset.to || null);
      };
      const onClose = () => done(undefined);
      d.addEventListener('click', onClick);
      d.addEventListener('close', onClose);
      d.showModal();
    });
  }

  async moveSession(id) {
    const m = (await this.allMetas()).find((x) => x.id === id);
    if (!m) return;
    const to = await this.pickFolder({ title: `Move "${m.title}" to…`, current: this.folderOk(m.folder) });
    if (to === undefined) return;
    await this.update(id, { folder: to });
    this.renderDrawer();
  }

  async moveFolder(id) {
    const f = this.folderById(id);
    if (!f) return;
    const to = await this.pickFolder({ title: `Move the folder "${f.name}" to…`, current: f.parent || null, exclude: this.folderAndBelow(id) });
    if (to === undefined) return;
    f.parent = to;
    await this.saveFolders();
    this.renderDrawer();
  }

  // ---------- for Claude (tools) ----------
  async listForClaude() {
    return (await this.allMetas())
      .filter((m) => !m.deletedAt)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 60)
      .map((m) => ({ id: m.id, title: m.title, subject: m.subject || undefined, current: m.id === this.currentId || undefined, edited: ago(m.updated), summary: (m.summary || '').slice(0, 200) }));
  }

  async readForClaude(ref) {
    const metas = (await this.allMetas()).filter((m) => !m.deletedAt);
    const q = String(ref).toLowerCase();
    const m = metas.find((x) => x.id === ref) || metas.find((x) => x.title.toLowerCase() === q) || metas.find((x) => x.title.toLowerCase().includes(q) || q.includes(x.title.toLowerCase()));
    if (!m) return null;
    if (m.id === this.currentId) return { info: { note: 'That is the session that is open now.' } };
    const data = (await idb.get('sessionData', m.id)) || {};
    const notes = (data.pages || []).flatMap((p) => (p.notebook || []).map((e) => ({ latex: e.latex, description: e.description })));
    const chat = (data.chat || []).slice(-10).map((x) => `${x.role}: ${String(x.md).slice(0, 500)}`);
    return { snap: data.snap || null, info: { title: m.title, subject: m.subject, summary: m.summary, where_left_off: m.recap, notes, recent_chat: chat } };
  }

  // ---------- backup / restore ----------
  async backup() {
    const withPdfs = confirm('Include your reference PDFs in the backup?\n\nOK = include them (bigger file)\nCancel = sessions and settings only (the PDFs of PDF notebooks are always included: they are the notebooks\' pages)');
    await this.save({ snapshot: true });
    const sessions = [];
    for (const m of (await idb.all('sessions')) || []) sessions.push({ meta: m, data: await idb.get('sessionData', m.id) });
    const books = ((await idb.all('library')) || []).filter((b) => withPdfs || b.kind === 'notebook').map((b) => ({ ...b, data: abToB64(b.data) }));
    const s = structuredClone(settings);
    delete s.apiKey;
    if (s.github) delete s.github.token;
    const blob = new Blob([JSON.stringify({ app: 'live-board', version: 1, exported: new Date().toISOString(), settings: s, sessions, books, folders: this.folders })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `live-board-backup-${new Date().toLocaleDateString('en-CA')}.json`;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    this.panel.add('info', `Backup saved: ${sessions.length} session(s)${books.length ? ` and ${books.length} PDF(s)` : ''}. It does not contain your API key or GitHub token. On iPad it goes to the Downloads folder in Files.`, { noLog: true });
  }

  async restoreFrom(file) {
    let j;
    try { j = JSON.parse(await file.text()); } catch { return this.panel.add('error', "That file isn't a BoardMate backup."); }
    if (j?.app !== 'live-board' || !Array.isArray(j.sessions)) return this.panel.add('error', "That file isn't a BoardMate backup.");
    return this.restoreData(j);
  }

  // Merges a backup (from a file or from GitHub) into what is here; newer sessions here are kept.
  async restoreData(j) {
    await this.save();
    let added = 0, updated = 0;
    for (const { meta, data } of j.sessions) {
      if (!meta?.id) continue;
      const existing = await idb.get('sessions', meta.id);
      if (existing && existing.updated >= meta.updated) continue;
      await idb.set('sessions', meta.id, meta);
      await idb.set('sessionData', meta.id, data || { pages: [], chat: [], exchanges: [] });
      existing ? updated++ : added++;
    }
    // folders: add the ones not here yet (yours keep their names and places)
    let nf = 0;
    for (const f of Array.isArray(j.folders) ? j.folders : []) {
      if (f?.id && !this.folderById(f.id)) { this.folders.push({ id: f.id, name: String(f.name || 'Folder'), parent: f.parent || null, created: f.created || Date.now() }); nf++; }
    }
    if (nf) await this.saveFolders();
    let pdfs = 0;
    for (const b of j.books || []) {
      const have = await idb.get('library', b.id);
      if (have) {
        have.global = have.global !== false || b.global !== false;
        have.sessions = [...new Set([...(have.sessions || []), ...(b.sessions || [])])];
        await idb.set('library', b.id, have);
      } else {
        await idb.set('library', b.id, { ...b, data: b64ToAb(b.data) });
        pdfs++;
      }
    }
    if (j.settings && confirm('Also restore the settings from the backup? (Your API key and GitHub token stay as they are here.)')) {
      const s = structuredClone(j.settings);
      delete s.apiKey;
      if (s.github) delete s.github.token;
      setSettings(s);
    }
    this.panel.add('info', `Restored: ${added} new session(s), ${updated} updated${pdfs ? `, ${pdfs} PDF(s)` : ''}${nf ? `, ${nf} folder(s)` : ''}. Sessions newer here were kept.`, { noLog: true });
    // if the open session was replaced by a newer copy, reload it
    const cur = await idb.get('sessions', this.currentId);
    if (cur && this.meta && cur.updated > this.meta.updated) await this.open(cur.id, { initial: true });
    this.renderDrawer();
  }

  // ---------- UI ----------
  bindUI() {
    $('#sessionsBtn').addEventListener('click', () => this.toggleDrawer());
    $('#sessionTitle').addEventListener('click', () => this.toggleDrawer());
    $('#pageSetupBtn').addEventListener('click', () => this.openPageSetup());
    const ps = $('#pageSetupDlg');
    ps.addEventListener('click', (e) => {
      if (e.target === ps) return ps.close();
      const b = e.target.closest('.seg button');
      if (!b) return;
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      this.pageSetupChoice(b.parentElement.dataset.name, b.dataset.v);
    });
    for (const id of ['#psClose', '#psDone']) $(id).addEventListener('click', () => ps.close());
    ps.addEventListener('change', (e) => { if (e.target.closest('#psWriting')) this.writingInput(e.target.id); });
    $('#drawerClose').addEventListener('click', () => this.closeDrawer());
    $('#newSession').addEventListener('click', () => this.chooseNewSession());
    // New session sheet: pick a type card; Notebook shows its page setup (segmented choices); Create.
    const dlg = $('#newSessionDlg');
    dlg.addEventListener('click', (e) => {
      const card = e.target.closest('.type-card');
      if (card) {
        dlg.querySelectorAll('.type-card').forEach((c) => c.classList.toggle('on', c === card));
        this.nsType = card.dataset.type;
        const pdf = this.nsType === 'pdf';
        $('#nsOptions').hidden = this.nsType === 'free';
        $('#nsOptions').classList.toggle('pdf', pdf);
        $('#nsOptions .seg[data-name="paper"]').previousElementSibling.textContent = pdf ? 'Blank pages' : 'Paper';
        $('#nsHint').textContent = pdf
          ? 'PDF pages keep their own size; blank pages you add between them are A4 with this paper. The PDF itself is never changed: your writing is a separate layer.'
          : 'You can change all of this later in Page setup.';
        $('#nsCreate').disabled = false;
        $('#nsCreate').textContent = pdf ? 'Choose PDF…' : this.nsType === 'note' ? 'Create notebook' : 'Create';
        return;
      }
      const opt = e.target.closest('.seg button');
      if (opt) opt.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === opt));
      if (e.target === dlg) dlg.close(); // tap outside the sheet
    });
    for (const id of ['#nsCancel', '#nsCancel2']) $(id).addEventListener('click', () => dlg.close());
    $('#nsCreate').addEventListener('click', async () => {
      const pick = (name) => dlg.querySelector(`.seg[data-name="${name}"] .on`)?.dataset.v;
      if (this.nsType === 'pdf') return $('#nsPdfFile').click(); // the sheet stays open until a PDF is picked
      dlg.close();
      if (this.nsType !== 'note') return this.newSession();
      const layout = { size: pick('size') || 'A4', orient: pick('orient') || 'portrait', paper: pick('paper') || 'ruled', scroll: pick('scroll') || 'vertical' };
      await this.newSession('', { layout });
      // the first page of a new notebook gets the notebook's paper
      if (this.board.pages[0]) { this.board.pages[0].paper = layout.paper; this.board.render(); }
    });
    $('#nsPdfFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const pick = (name) => dlg.querySelector(`.seg[data-name="${name}"] .on`)?.dataset.v;
      dlg.close();
      await this.newPdfNotebook(f, { paper: pick('paper') || 'ruled', scroll: pick('scroll') || 'vertical' });
    });
    $('#branchCurrent').addEventListener('click', () => this.branch(this.currentId));
    $('#backupBtn').addEventListener('click', () => this.backup());
    $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
    $('#restoreFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) await this.restoreFrom(f);
    });
    $('#sessionSearch').addEventListener('input', (e) => { this.query = e.target.value.trim(); this.found = null; this.renderDrawer(); });
    $('#askFind').addEventListener('click', () => this.askClaudeToFind());
    $('#sessionChips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-filter]');
      if (!c) return;
      this.filter = c.dataset.filter;
      this.renderDrawer();
    });
    $('#sessionList').addEventListener('click', (e) => this.onListClick(e));
    $('#newFolder').addEventListener('click', () => this.newFolder());
    $('#sessionCrumbs').addEventListener('click', (e) => {
      const c = e.target.closest('[data-crumb]');
      if (!c) return;
      this.folder = c.dataset.crumb || null;
      this.openMenu = null;
      this.renderDrawer();
    });

    // Session materials (PDFs for this session only)
    const mat = makePopover($('#matPop'), '#matBtn');
    $('#matBtn').addEventListener('click', (e) => { this.renderMaterials(); mat.toggle(e.currentTarget); });
    $('#matFile').addEventListener('change', async (e) => {
      const prog = $('#matProgress');
      for (const f of e.target.files) {
        try {
          const r = await addPdf(f, (i, n) => { prog.textContent = `Indexing ${f.name}: page ${i} of ${n}`; }, { sessionId: this.currentId });
          prog.textContent = r.reused ? `${f.name} was already stored; it's now part of this session too.` : `Added ${f.name} to this session.`;
        } catch (err) {
          prog.textContent = `Could not add ${f.name}: ${err.message}`;
        }
      }
      e.target.value = '';
      this.renderMaterials();
    });
    $('#matPop').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-unlink]');
      if (b && confirm('Remove this PDF from this session?')) {
        await removeBook(b.dataset.unlink, this.currentId);
        this.renderMaterials();
      }
    });
  }

  toggleDrawer() {
    const d = $('#drawer');
    d.hidden = !d.hidden;
    if (!d.hidden) { this.openMenu = null; this.renderDrawer(); }
  }

  closeDrawer() { $('#drawer').hidden = true; }

  renderTitle() {
    const t = $('#sessionTitle');
    if (t && this.meta) { t.textContent = this.meta.title; t.title = `${this.meta.title} — tap for all sessions`; }
  }

  async renderMaterials() {
    if (!this.currentId) return;
    const books = await listBooks(this.currentId);
    const local = books.filter((b) => b.inSession);
    const shared = books.filter((b) => b.scope === 'global');
    $('#matCount').textContent = local.length ? String(local.length) : '';
    $('#matLocal').innerHTML = local.map((b) => `<div class="mat-item"><span>${escapeHtml(b.name)} · ${b.pages} p</span><button type="button" class="ghost small" data-unlink="${escapeHtml(b.id)}">Remove</button></div>`).join('') || '<div class="muted small">None yet. PDFs added here are used only in this session.</div>';
    $('#matGlobal').innerHTML = shared.map((b) => `<div class="mat-item"><span>${escapeHtml(b.name)} · ${b.pages} p</span></div>`).join('') || '<div class="muted small">Empty. Add shared PDFs in Settings.</div>';
  }

  async renderDrawer() {
    const d = $('#drawer');
    if (!d || d.hidden) return;
    const metas = await this.allMetas();
    const live = metas.filter((m) => !m.deletedAt);
    const trash = metas.filter((m) => m.deletedAt);
    const subjects = [...new Set(live.map((m) => m.subject).filter(Boolean))].sort();
    if (this.filter.startsWith('subject:') && !subjects.includes(this.filter.slice(8))) this.filter = 'all';
    const chip = (f, label) => `<button type="button" class="chip${this.filter === f ? ' active' : ''}" data-filter="${escapeHtml(f)}">${label}</button>`;
    $('#sessionChips').innerHTML = [
      chip('all', 'All'),
      live.some((m) => m.pinned) ? chip('pinned', '📌 Pinned') : '',
      ...subjects.map((s) => chip(`subject:${s}`, escapeHtml(s))),
      trash.length ? chip('trash', `🗑 Trash (${trash.length})`) : '',
    ].join('');

    let list = this.filter === 'trash' ? trash : live;
    if (this.filter === 'pinned') list = list.filter((m) => m.pinned);
    if (this.filter.startsWith('subject:')) list = list.filter((m) => m.subject === this.filter.slice(8));
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (this.found) {
      const order = this.found.map((f) => f.id);
      list = list.filter((m) => order.includes(m.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    } else if (words.length) {
      list = list.filter((m) => { const t = `${m.title} ${m.subject} ${m.searchText || ''}`.toLowerCase(); return words.every((w) => t.includes(w)); });
    }
    if (!this.found) list.sort((a, b) => (this.filter === 'all' ? (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) : 0) || b.updated - a.updated);
    // Folder view: "All" with no search shows one folder at a time (its folders, then its sessions);
    // searching, Pinned, a subject or Trash list sessions from every folder, each with where it lives.
    const browsing = this.filter === 'all' && !words.length && !this.found;
    this.folder = this.folderOk(this.folder);
    if (browsing) list = list.filter((m) => this.folderOk(m.folder) === this.folder);
    const path = this.folderPath(this.folder);
    $('#sessionCrumbs').hidden = !browsing;
    $('#sessionCrumbs').innerHTML = `<button type="button" data-crumb=""${path.length ? '' : ' class="here"'}>Sessions</button>${path.map((f, i) => `<span>›</span><button type="button" data-crumb="${f.id}"${i === path.length - 1 ? ' class="here"' : ''}>${escapeHtml(f.name)}</button>`).join('')}`;
    const subs = browsing ? this.folders.filter((f) => (f.parent || null) === this.folder).sort((a, b) => a.name.localeCompare(b.name)) : [];
    const folderRows = subs.map((f) => {
      const below = this.folderAndBelow(f.id);
      const n = live.filter((m) => below.has(this.folderOk(m.folder))).length;
      const k = this.folders.filter((x) => x.parent === f.id).length;
      return `<div class="s-item s-folder" data-folder="${f.id}">
        <div class="s-row" data-enter>
          <div class="s-thumb s-fico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></div>
          <div class="s-body"><div class="s-title">${escapeHtml(f.name)}</div><div class="s-meta">${n} session${n === 1 ? '' : 's'}${k ? ` · ${k} folder${k === 1 ? '' : 's'}` : ''}</div></div>
          <button type="button" class="s-more" data-fmore aria-label="Folder options">⋯</button>
        </div>
        <div class="s-actions"${this.openMenu === f.id ? '' : ' hidden'}><button type="button" data-fact="rename">Rename</button><button type="button" data-fact="move">Move to…</button><button type="button" data-fact="delete" class="danger">Delete folder</button></div>
      </div>`;
    }).join('');
    $('#askFind').hidden = !this.query || !settings.apiKey || this.filter === 'trash';
    $('#askFind').textContent = this.found ? 'Show normal search results' : `Ask Claude to find "${this.query.slice(0, 40)}"`;

    const why = Object.fromEntries((this.found || []).map((f) => [f.id, f.why]));
    $('#sessionList').innerHTML = folderRows + list.map((m) => {
      const cur = m.id === this.currentId;
      const metaLine = this.filter === 'trash'
        ? `deleted ${ago(m.deletedAt)} · removed for good after ${TRASH_DAYS} days`
        : [browsing ? '' : this.folderOk(m.folder) ? `📁 ${this.folderLabel(m.folder)}` : '', m.subject, ago(m.updated), fmt(m.cost || 0)].filter(Boolean).map(escapeHtml).join(' · ');
      const actions = this.filter === 'trash'
        ? `<button type="button" data-act="restore">Restore</button><button type="button" data-act="purge" class="danger">Delete for good</button>`
        : `<button type="button" data-act="rename">Rename</button><button type="button" data-act="subject">Subject</button><button type="button" data-act="pin">${m.pinned ? 'Unpin' : 'Pin'}</button><button type="button" data-act="move">Move to…</button><button type="button" data-act="setup">Page setup</button><button type="button" data-act="branch">Branch</button><button type="button" data-act="trash" class="danger">Delete</button>`;
      return `<div class="s-item${cur ? ' current' : ''}" data-id="${m.id}">
        <div class="s-row" data-open>
          <div class="s-thumb">${m.thumb ? `<img alt="" src="data:image/jpeg;base64,${m.thumb}">` : ''}</div>
          <div class="s-body">
            <div class="s-title">${m.pinned ? '📌 ' : ''}${escapeHtml(m.title)}${cur ? ' <span class="s-now">open</span>' : ''}</div>
            <div class="s-meta">${metaLine}</div>
            ${why[m.id] ? `<div class="s-why">${escapeHtml(why[m.id])}</div>` : m.summary ? `<div class="s-sum">${escapeHtml(m.summary)}</div>` : ''}
          </div>
          <button type="button" class="s-more" data-more aria-label="More">⋯</button>
        </div>
        <div class="s-actions"${this.openMenu === m.id ? '' : ' hidden'}>${actions}</div>
      </div>`;
    }).join('') + (folderRows || list.length ? '' : `<div class="muted s-empty">${this.filter === 'trash' ? 'Trash is empty.' : words.length ? 'No sessions match.' : this.folder ? 'This folder is empty. Tap + New to start a session here, or move one in with ⋯ → Move to….' : 'No sessions here yet.'}</div>`);
  }

  async onListClick(e) {
    const item = e.target.closest('.s-item');
    if (!item) return;
    if (item.dataset.folder) {
      const fid = item.dataset.folder;
      if (e.target.closest('[data-fmore]')) { this.openMenu = this.openMenu === fid ? null : fid; return this.renderDrawer(); }
      const fact = e.target.closest('[data-fact]')?.dataset.fact;
      if (fact === 'rename') await this.renameFolder(fid);
      else if (fact === 'move') await this.moveFolder(fid);
      else if (fact === 'delete') await this.deleteFolder(fid);
      else if (e.target.closest('[data-enter]')) this.folder = fid;
      this.openMenu = null;
      return this.renderDrawer();
    }
    const id = item.dataset.id;
    if (e.target.closest('[data-more]')) {
      this.openMenu = this.openMenu === id ? null : id;
      return this.renderDrawer();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) {
      if (e.target.closest('[data-open]') && this.filter !== 'trash') await this.open(id);
      return;
    }
    const m = (await this.allMetas()).find((x) => x.id === id);
    if (!m) return;
    if (act === 'rename') {
      const t = prompt('Session title', m.title);
      if (t && t.trim()) await this.update(id, { title: t.trim(), titleAuto: false });
    } else if (act === 'subject') {
      const subjects = [...new Set((await this.allMetas()).map((x) => x.subject).filter(Boolean))];
      const s = prompt(`Subject for this session${subjects.length ? ` (existing: ${subjects.join(', ')})` : ''}. Leave empty for none.`, m.subject || '');
      if (s !== null) await this.update(id, { subject: s.trim() });
    } else if (act === 'pin') await this.update(id, { pinned: !m.pinned });
    else if (act === 'branch') await this.branch(id);
    else if (act === 'move') await this.moveSession(id);
    else if (act === 'setup') { if (id !== this.currentId) await this.open(id); else this.closeDrawer(); this.openPageSetup(); }
    else if (act === 'trash') {
      if (confirm(`Move "${m.title}" to the trash? You can restore it for ${TRASH_DAYS} days.`)) await this.trash(id);
    } else if (act === 'restore') await this.restore(id);
    else if (act === 'purge') {
      if (confirm(`Delete "${m.title}" for good? This can't be undone.`)) { await this.purge(id); this.renderDrawer(); }
    }
    this.openMenu = null;
    this.renderDrawer();
  }

  async askClaudeToFind() {
    if (this.found) { this.found = null; return this.renderDrawer(); }
    const btn = $('#askFind');
    btn.disabled = true;
    btn.textContent = 'Looking…';
    try {
      const list = (await this.allMetas()).filter((m) => !m.deletedAt).slice(0, 80).map((m) => ({
        id: m.id, title: m.title, subject: m.subject || undefined, summary: m.summary || undefined, notes: (m.searchText || '').slice(0, 500),
      }));
      const resp = await claude({ model: settings.models.fast, system: FIND_SYSTEM, messages: [{ role: 'user', content: `Request: ${this.query}\nSessions: ${JSON.stringify(list)}\nReturn the JSON only.` }], max_tokens: 3000, purpose: 'find' });
      const j = parseJSON(textOf(resp));
      this.found = Array.isArray(j?.matches) ? j.matches.filter((x) => x && x.id) : [];
    } catch (e) {
      this.panel.add('error', 'Search failed: ' + e.message, { noLog: true });
    } finally {
      btn.disabled = false;
      this.renderDrawer();
    }
  }
}
