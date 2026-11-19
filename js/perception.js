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
 "spoken":null}
Rules:
- notebook_upsert: equations or expressions visible in the image that are new or changed. Reuse an existing key when it is the same equation. x,y = left end of the equation in pixels of THIS image. notebook_remove: keys of notes whose equation was erased in this region.
- QUIET mode: issues [] and comment null.
- LIVE mode: check the newest work against the earlier lines and your notes. Flag real mistakes (algebra, signs, indices, factors, dimensions, misapplied identities) as "error", doubtful steps as "warn". Use "ok" sparingly. Put each mark just right of its line (pixels in this image).
- comment: one or two sentences only when worth saying now; otherwise null. spoken: the same for speech, math in words, or null.
- Never comment on neatness. Blue typeset blocks were written by the assistant. Be brief.`;

const VERIFY_SYSTEM = `You double-check suspected mistakes on a scientist's handwritten page. Given the image, the notes about the rest of the page, and the suspected issues, keep only real issues (fix their notes if needed). Reply with ONE JSON object:
{"issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"..."}],"comment":null or "...","spoken":null or "..."}`;

export class Perception {
  constructor({ board, panel, voice, agent }) {
    this.board = board;
    this.panel = panel;
    this.voice = voice;
    this.agent = agent;
    this.pending = null;
    this.firstPendingAt = 0;
    this.running = false;
    on('settled', (bb) => this.onSettled(bb));
    on('page', () => { this.pending = null; clearTimeout(this.timer); });
  }

  onSettled(bb) {
    if (settings.attention === 'demand' || !settings.apiKey) return;
    if (!this.pending) this.firstPendingAt = Date.now();
    this.pending = union(this.pending, bb);
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
    if (this.running || this.agent.busy) return this.schedule(1500);
    if (overBudget()) {
      if (!this.budgetNoted) {
        this.budgetNoted = true;
        this.panel.add('info', `Today's budget (${fmt(settings.dailyBudgetUSD)}) is used up, so live watching is paused until tomorrow. You can still ask questions.`);
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
      const resp = await claude({
        model: settings.models.fast,
        system: WATCH_SYSTEM,
        messages: [{ role: 'user', content }],
        max_tokens: 1200,
        purpose: 'watch',
      });
      const j = parseJSON(textOf(resp));
      if (!j || b.page.id !== pageId) return;

      const nb = b.page.notebook;
      for (const k of j.notebook_remove || []) {
        const i = nb.findIndex((e) => e.key === k);
        if (i >= 0) nb.splice(i, 1);
      }
      for (const e of j.notebook_upsert || []) {
        if (!e || !e.latex) continue;
        const w = Number.isFinite(e.x) && Number.isFinite(e.y) ? b.imageToWorld(crop, e.x, e.y) : {};
        const entry = { key: String(e.key || e.latex.slice(0, 20)), latex: e.latex, description: e.description || '', x: w.x, y: w.y };
        const i = nb.findIndex((x) => x.key === entry.key);
        if (i >= 0) nb[i] = entry; else nb.push(entry);
      }
      b.saveSoon();

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
      this.panel.status('Watcher: ' + (e.message || e));
      setTimeout(() => this.panel.status(''), 5000);
    } finally {
      this.running = false;
      if (this.pending) this.schedule();
    }
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
