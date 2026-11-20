// Sessions: each one has its own pages, Claude conversation, notes, PDFs and spending.
// Everything saves automatically. When you leave a session, the fast model names it and writes a short
// summary (for search) and a "where you left off" recap (shown when you return).
// Also: subjects, pinning, search (incl. "ask Claude to find it"), branching, trash, backup/restore,
// and per-session PDF materials.
import { idb } from './storage.js';
import { settings, setSettings } from './settings.js';
import { on, emit, uid, escapeHtml } from './bus.js';
import { claude, textOf, parseJSON } from './claude.js';
import { fmt } from './costs.js';
import { makePopover } from './inktools.js';
import { addPdf, listBooks, removeBook, copySessionBooks, dropSessionBooks } from './library.js';

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
  }

  // ---------- startup ----------
  async init() {
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
    on('cost', ({ cost, purpose }) => {
      if (this.meta && purpose !== 'title' && purpose !== 'find') { this.meta.cost = (this.meta.cost || 0) + cost; this.saveSoon(); }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.leave({ staying: true });
    });
    this.bindUI();
  }

  // ---------- data ----------
  async allMetas() {
    const all = ((await idb.all('sessions')) || []).filter(Boolean);
    // the in-memory copy of the open session is the freshest
    return all.map((m) => (this.meta && m.id === this.meta.id ? this.meta : m));
  }

  async create({ pages = [], chat = [], exchanges = [], title = 'Untitled session', titleAuto = true, subject = '', parent = null, dirty = false, notesFrom } = {}) {
    const id = uid();
    const now = Date.now();
    const meta = { id, title, titleAuto, subject, pinned: false, created: now, updated: now, deletedAt: null, cost: 0, thumb: null, summary: '', recap: '', searchText: '', parent, dirty };
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
    if (!this.currentId || !this.meta) return;
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
      const resp = await claude({ model: settings.models.fast, system: SUMMARY_SYSTEM, messages: [{ role: 'user', content }], max_tokens: 400, purpose: 'title' });
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
    this.chat = data.chat || [];
    this.snap = data.snap || null;
    this.agent.stop();
    this.agent.exchanges = data.exchanges || [];
    this.agent.lastAskAt = Date.now();
    this.board.load(data.pages || []);
    this.panel.clear();
    for (const m of this.chat) this.panel.add(m.role, m.md, { noLog: true, actions: m.role === 'assistant' ? this.agent.answerActions(m.md) : undefined });
    if (meta.recap) this.panel.add('recap', `**Where you left off:** ${meta.recap}`, { noLog: true });
    else if (!this.chat.length) {
      this.panel.add('info', 'A fresh session. Write on the page, then ask about it: type below, hold the mic, or tap a button. Select a region with ⬚ to point at something.', { noLog: true });
    }
    this.loading = false;
    this.contentChanged = false;
    try { await idb.set('kv', 'currentSession', id); } catch {}
    this.renderTitle();
    this.renderMaterials();
    emit('session', meta);
    if (!initial) this.closeDrawer();
  }

  async newSession(subject = '') {
    const id = await this.create({ subject: subject || (this.filter.startsWith('subject:') ? this.filter.slice(8) : '') });
    await this.open(id, { initial: !this.currentId });
  }

  async branch(id) {
    if (id === this.currentId) await this.save({ snapshot: true });
    const meta = await idb.get('sessions', id);
    const data = await idb.get('sessionData', id);
    if (!meta || !data) return;
    const copy = structuredClone(data);
    const newId = await this.create({
      pages: copy.pages, chat: copy.chat, exchanges: copy.exchanges,
      title: `${meta.title} (branch)`, titleAuto: false, subject: meta.subject, parent: id, notesFrom: { snap: copy.snap },
    });
    const m = await idb.get('sessions', newId);
    Object.assign(m, { summary: meta.summary, recap: meta.recap, thumb: meta.thumb, searchText: meta.searchText });
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
    const withPdfs = confirm('Include your PDFs in the backup?\n\nOK = include them (bigger file)\nCancel = sessions and settings only');
    await this.save({ snapshot: true });
    const sessions = [];
    for (const m of (await idb.all('sessions')) || []) sessions.push({ meta: m, data: await idb.get('sessionData', m.id) });
    const books = withPdfs ? ((await idb.all('library')) || []).map((b) => ({ ...b, data: abToB64(b.data) })) : [];
    const s = structuredClone(settings);
    delete s.apiKey;
    if (s.github) delete s.github.token;
    const blob = new Blob([JSON.stringify({ app: 'live-board', version: 1, exported: new Date().toISOString(), settings: s, sessions, books })], { type: 'application/json' });
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
    try { j = JSON.parse(await file.text()); } catch { return this.panel.add('error', "That file isn't a Live Board backup."); }
    if (j?.app !== 'live-board' || !Array.isArray(j.sessions)) return this.panel.add('error', "That file isn't a Live Board backup.");
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
    this.panel.add('info', `Restored: ${added} new session(s), ${updated} updated${pdfs ? `, ${pdfs} PDF(s)` : ''}. Sessions newer here were kept.`, { noLog: true });
    // if the open session was replaced by a newer copy, reload it
    const cur = await idb.get('sessions', this.currentId);
    if (cur && this.meta && cur.updated > this.meta.updated) await this.open(cur.id, { initial: true });
    this.renderDrawer();
  }

  // ---------- UI ----------
  bindUI() {
    $('#sessionsBtn').addEventListener('click', () => this.toggleDrawer());
    $('#sessionTitle').addEventListener('click', () => this.toggleDrawer());
    $('#drawerClose').addEventListener('click', () => this.closeDrawer());
    $('#newSession').addEventListener('click', () => this.newSession());
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
    $('#askFind').hidden = !this.query || !settings.apiKey || this.filter === 'trash';
    $('#askFind').textContent = this.found ? 'Show normal search results' : `Ask Claude to find "${this.query.slice(0, 40)}"`;

    const why = Object.fromEntries((this.found || []).map((f) => [f.id, f.why]));
    $('#sessionList').innerHTML = list.map((m) => {
      const cur = m.id === this.currentId;
      const metaLine = this.filter === 'trash'
        ? `deleted ${ago(m.deletedAt)} · removed for good after ${TRASH_DAYS} days`
        : [m.subject, ago(m.updated), fmt(m.cost || 0)].filter(Boolean).map(escapeHtml).join(' · ');
      const actions = this.filter === 'trash'
        ? `<button type="button" data-act="restore">Restore</button><button type="button" data-act="purge" class="danger">Delete for good</button>`
        : `<button type="button" data-act="rename">Rename</button><button type="button" data-act="subject">Subject</button><button type="button" data-act="pin">${m.pinned ? 'Unpin' : 'Pin'}</button><button type="button" data-act="branch">Branch</button><button type="button" data-act="trash" class="danger">Delete</button>`;
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
    }).join('') || `<div class="muted s-empty">${this.filter === 'trash' ? 'Trash is empty.' : words.length ? 'No sessions match.' : 'No sessions here yet.'}</div>`;
  }

  async onListClick(e) {
    const item = e.target.closest('.s-item');
    if (!item) return;
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
      const resp = await claude({ model: settings.models.fast, system: FIND_SYSTEM, messages: [{ role: 'user', content: `Request: ${this.query}\nSessions: ${JSON.stringify(list)}\nReturn the JSON only.` }], max_tokens: 400, purpose: 'find' });
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
