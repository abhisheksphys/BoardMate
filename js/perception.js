// Continuous perception, built to be cheap:
// - looks only after you pause (Live: watchIdleSec, Quiet live: quietIdleSec), at least every watchMaxWaitSec while you keep writing;
// - sends only the changed region (plus a little context above it) and its text notes, not the whole page;
// - uses the fast model; suspected errors are re-checked by the main model (not the most expensive one);
// - pauses when the daily budget is reached.
import { settings } from './settings.js';
import { on, union } from './bus.js';
import { claude, textOf, parseJSON, imageBlock } from './claude.js';
import { overBudget, fmt } from './costs.js';

const WATCH_SYSTEM = `You silently watch a scientist's handwritten whiteboard page. You get an image of the region that just changed (with a little context above it) and your notes about the rest of the page. Reply with ONE JSON object and nothing else:
{"notebook_upsert":[{"key":"short-id","latex":"...","description":"a few words","x":0,"y":0}],
 "notebook_remove":[],
 "issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"one short sentence"}],
 "comment":null,
 "spoken":null,
 "board_requests":[{"text":"...","x0":0,"y0":0,"x1":0,"y1":0}]}
Rules:
- notebook_upsert: equations or expressions visible in the image that are new or changed. Reuse an existing key when it is the same equation. x,y = left end of the equation in pixels of THIS image. notebook_remove: keys of notes whose equation was erased in this region.
- QUIET mode: issues [] and comment null.
- LIVE mode: check the newest work against the earlier lines and your notes. Flag real mistakes (algebra, signs, indices, factors, dimensions, misapplied identities) as "error", doubtful steps as "warn". Use "ok" sparingly. Put each mark just right of its line (pixels in this image).
- comment: one or two sentences only when worth saying now; otherwise null. spoken: the same for speech, math in words, or null.
- board_requests (both modes): an instruction or question the user has handwritten FOR THE ASSISTANT in the new writing, e.g. "Write down the Lagrangian of the Standard Model", "derive this", "what comes next?", "Claude: check line 3". text = the words as written (fix obvious spelling); x0,y0,x1,y1 = the box around those words in pixels of THIS image. Only when the sentence looks finished. Not requests: titles, headings, notes to self, and problem statements the user is solving on the page themselves (e.g. "Q2. Show that ..." followed by their own working). Usually [].
- Never comment on neatness. Blue typeset blocks were written by the assistant. Be brief.`;

const VERIFY_SYSTEM = `You double-check suspected mistakes on a scientist's handwritten page. Given the image, the notes about the rest of the page, and the suspected issues, keep only real issues (fix their notes if needed). Reply with ONE JSON object:
{"issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"..."}],"comment":null or "...","spoken":null or "..."}`;

// LaTeX that came through JSON with single backslashes: "\nabla" arrives as a newline + "abla", "\frac"
// as a form feed + "rac", and so on. Put the backslashes back.
const fixLatex = (s) => String(s || '').replace(/\n(?=[a-zA-Z])/g, '\\n').replace(/\t(?=[a-zA-Z])/g, '\\t').replace(/\r(?=[a-zA-Z])/g, '\\r').replace(/\f/g, '\\f').replace(/\x08/g, '\\b');

export class Perception {
  constructor({ board, panel, voice, agent }) {
    this.board = board;
    this.panel = panel;
    this.voice = voice;
    this.agent = agent;
    this.events = [];
    window.liveWatcher = this;
    this.pending = null;
    this.firstPendingAt = 0;
    this.running = false;
    on('settled', (bb) => this.onSettled(bb));
    on('page', () => { this.pending = null; clearTimeout(this.timer); });
  }

  // ---- activity log (Settings → Watching log) ----
  log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    const last = this.events[this.events.length - 1];
    if (last && last.msg === msg) { last.n++; last.t2 = t; return; }
    this.events.push({ t, msg, n: 1 });
    if (this.events.length > 300) this.events.splice(0, 60);
  }

  report() {
    const s = settings;
    return [
      'Live Board watching log',
      `when: ${new Date().toString()}`,
      `settings: mode=${s.attention} liveLookAfter=${s.watchIdleSec}s quietLookAfter=${s.quietIdleSec}s lookAtLeastEvery=${s.watchMaxWaitSec}s boardRequests=${s.boardRequests} escalate=${s.escalate} model=${s.models.fast} apiKey=${s.apiKey ? 'set' : 'MISSING'}`,
      `state: looking=${!!this.running} waiting=${!!this.pending} claudeAnswering=${!!this.agent.busy} notesOnThisPage=${this.board.page.notebook.length}`,
      '',
      ...this.events.map((e) => `${e.t}  ${e.msg}${e.n > 1 ? `   (×${e.n}, last ${e.t2})` : ''}`),
    ].join('\n');
  }

  onSettled(bb) {
    if (settings.attention === 'demand') return this.log('page changed: not looking (mode is On demand)');
    if (!settings.apiKey) return this.log('page changed: not looking (no API key)');
    if (!this.pending) this.firstPendingAt = Date.now();
    this.pending = union(this.pending, bb);
    const idle = settings.attention === 'live' ? settings.watchIdleSec : settings.quietIdleSec;
    this.log(`page changed: will look after ${idle} s without new changes`);
    this.schedule();
  }

  schedule(extraMs = 0) {
    clearTimeout(this.timer);
    const idle = (settings.attention === 'live' ? settings.watchIdleSec : settings.quietIdleSec) * 1000;
    const overdue = Date.now() - this.firstPendingAt > settings.watchMaxWaitSec * 1000;
    this.timer = setTimeout(() => this.run(), (overdue ? 300 : idle) + extraMs);
  }

  notesText() {
    return JSON.stringify(this.board.page.notebook.slice(-30).map((e) => ({ key: e.key, latex: e.latex, description: e.description })));
  }

  async run() {
    if (!this.pending || settings.attention === 'demand') return;
    if (this.running || this.agent.busy) { this.log(this.running ? 'waiting: previous look still running' : 'waiting: Claude is answering a question'); return this.schedule(1500); }
    if (overBudget()) {
      if (!this.budgetNoted) {
        this.budgetNoted = true;
        this.panel.add('info', `Today's budget (${fmt(settings.dailyBudgetUSD)}) is used up, so live watching is paused until tomorrow. You can still ask questions.`);
        this.log('not looking: daily budget used up');
      }
      this.pending = null;
      return;
    }
    const dirty = this.pending;
    this.pending = null;
    this.running = true;
    const b = this.board;
    const pageId = b.page.id;
    const live = settings.attention === 'live';
    try {
      // The changed region plus some context above and around it.
      const region = { x: dirty.x - 60, y: dirty.y - 140, w: dirty.w + 120, h: dirty.h + 170 };
      const crop = b.snapshot({ region, maxDim: Math.min(900, settings.imageMaxPx || 900), maxScale: 2, pad: 0 });
      const content = [imageBlock(crop)];
      // First look at a page: also a small overview so the notes start complete.
      if (!b.page.notebook.length) content.push(imageBlock(b.snapshot({ maxDim: 700, maxScale: 1 })));
      content.push({
        type: 'text',
        text: `${content.length > 1 ? 'Image 2 is a small overview of the whole page (for notes only; give coordinates in image 1). ' : ''}Notes about the page so far: ${this.notesText()}\nMode: ${live ? 'LIVE' : 'QUIET'}\nReturn the JSON only.`,
      });
      this.log(`looking (${live ? 'Live' : 'Quiet live'}): changed area ${Math.round(dirty.w)}×${Math.round(dirty.h)}${content.length > 2 ? ' + page overview' : ''}`);
      this.panel.status('Claude is looking at your writing…');
      const t0 = Date.now();
      const resp = await claude({
        model: settings.models.fast,
        system: WATCH_SYSTEM,
        messages: [{ role: 'user', content }],
        max_tokens: 4000, // room for the model's own reasoning as well as the JSON (only what is used is paid for)
        purpose: 'watch',
      });
      const raw = textOf(resp);
      const j = parseJSON(raw);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (!j) {
        this.log(`could not read Claude's reply after ${secs} s (stop: ${resp.stop_reason}): ${raw.slice(0, 300) || '(no text)'}`);
        if (!this.failNoted) { this.failNoted = true; this.panel.add('info', 'Live watching could not read one of Claude\'s looks at the page. Details: Settings → Watching log.'); }
        return;
      }
      if (b.page.id !== pageId) return this.log('reply arrived after you switched pages: ignored');

      const nb = b.page.notebook;
      for (const k of j.notebook_remove || []) {
        const i = nb.findIndex((e) => e.key === k);
        if (i >= 0) nb.splice(i, 1);
      }
      for (const e of j.notebook_upsert || []) {
        if (!e || !e.latex) continue;
        const w = Number.isFinite(e.x) && Number.isFinite(e.y) ? b.imageToWorld(crop, e.x, e.y) : {};
        const latex = fixLatex(e.latex);
        const entry = { key: String(e.key || latex.slice(0, 20)), latex, description: e.description || '', x: w.x, y: w.y };
        const i = nb.findIndex((x) => x.key === entry.key);
        if (i >= 0) nb[i] = entry; else nb.push(entry);
      }
      b.saveSoon();

      const reqs = Array.isArray(j.board_requests) ? j.board_requests : [];
      this.log(`reply after ${secs} s: ${(j.notebook_upsert || []).length} note(s) updated, ${(j.issues || []).length} mark(s), comment ${j.comment ? 'yes' : 'no'}, ${reqs.length} board request(s)${reqs.length ? ': ' + reqs.map((r) => `"${r.text}"`).join(', ') : ''}${resp.stop_reason === 'max_tokens' ? ' (reply was cut off)' : ''}`);
      for (const r of reqs) this.takeRequest(r, crop, region);

      if (!live) return;
      let issues = Array.isArray(j.issues) ? j.issues : [];
      let comment = j.comment || null;
      let spoken = j.spoken || null;
      if (settings.escalate && issues.some((i) => i.kind === 'error')) {
        const v = await this.verify(crop, issues);
        if (v) {
          issues = Array.isArray(v.issues) ? v.issues : issues;
          comment = v.comment ?? comment;
          spoken = v.spoken ?? spoken;
        }
      }
      if (b.page.id !== pageId) return;
      // Replace this region's marks only; marks elsewhere on the page stay.
      const inRegion = (m) => m.x >= region.x && m.x <= region.x + region.w && m.y >= region.y && m.y <= region.y + region.h;
      const keep = b.page.marks.filter((m) => m.src === 'watch' && !inRegion(m));
      const fresh = issues.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y)).map((i) => ({ ...b.imageToWorld(crop, i.x, i.y), kind: i.kind || 'note', note: i.note || '' }));
      b.replaceMarks('watch', [...keep.map(({ id, src, ...m }) => m), ...fresh]);
      if (comment) {
        this.panel.add('commentary', comment);
        if (settings.liveSpeak && settings.voiceOut && !this.agent.busy) this.voice.speak(spoken || comment.replace(/\$+/g, ''));
      }
    } catch (e) {
      this.log('error: ' + (e.message || e));
      this.panel.status('Watcher: ' + (e.message || e));
      setTimeout(() => this.panel.status(''), 5000);
    } finally {
      if (!this.agent.busy) this.panel.status(''); // clear "looking…" unless an answer's own status is showing
      this.running = false;
      if (this.pending) this.schedule();
    }
  }

  // A request handwritten on the board: run it like a typed question, pointing at the handwriting
  // (as a selection), once. Requests already handled on this page are remembered so they never repeat.
  takeRequest(r, crop, region) {
    if (!settings.boardRequests || !r || !String(r.text || '').trim()) return;
    const b = this.board;
    const text = String(r.text).trim();
    let rect;
    if ([r.x0, r.y0, r.x1, r.y1].every(Number.isFinite)) {
      const a = b.imageToWorld(crop, Math.min(r.x0, r.x1), Math.min(r.y0, r.y1));
      const c = b.imageToWorld(crop, Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
      rect = { x: a.x - 10, y: a.y - 10, w: c.x - a.x + 20, h: c.y - a.y + 20 };
    } else rect = { ...region };
    const handled = (b.page.handledRequests ||= []);
    const words = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean));
    const similar = (t1, t2) => { const A = words(t1), B = words(t2); let n = 0; for (const w of A) if (B.has(w)) n++; return n >= 0.6 * Math.min(A.size, B.size); };
    const overlaps = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    if (handled.some((h) => overlaps(h, rect) && similar(h.text, text))) return this.log(`board request "${text}": already done, skipped`);
    handled.push({ text, ...rect });
    if (handled.length > 100) handled.splice(0, handled.length - 100);
    b.saveSoon();
    this.panel.add('user', `✍ From the board: ${text}`);
    this.log(`board request "${text}": running it`);
    this.agent.ask(
      `I wrote this request on the board (it is inside the selection rectangle): "${text}". Do what it asks. ` +
        'If the result is something to write (equations, a derivation, a list), write it on the board with write_on_canvas ' +
        'using anchor "below_selection", and keep your panel reply to one short line. Otherwise answer in the panel.',
      { selection: rect, origin: 'board request' },
    );
  }

  async verify(crop, issues) {
    try {
      const resp = await claude({
        model: settings.models.main,
        system: VERIFY_SYSTEM,
        messages: [{
          role: 'user',
          content: [imageBlock(crop), { type: 'text', text: `Notes about the rest of the page: ${this.notesText()}\nSuspected issues (pixels in the image): ${JSON.stringify(issues)}\nReturn the JSON only.` }],
        }],
        max_tokens: 800,
        purpose: 'verify',
      });
      return parseJSON(textOf(resp));
    } catch {
      return null;
    }
  }
}
