// Continuous perception: whenever your writing settles, a fast model looks at the page.
// Quiet live = keep the notebook current; Live = also check new work and comment; On demand = nothing.
import { settings } from './settings.js';
import { on, union } from './bus.js';
import { claude, textOf, parseJSON, imageBlock } from './claude.js';

const WATCH_SYSTEM = `You silently watch a scientist's handwritten whiteboard page. Reply with ONE JSON object and nothing else:
{"notebook":[{"key":"short-id","latex":"...","description":"a few words","x":0,"y":0}],
 "issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"one short sentence"}],
 "comment":null,
 "spoken":null}
Rules:
- notebook: every equation or expression on the page, in reading order. Reuse existing keys for the same equations. x,y = left end of the equation, in pixels of image 1.
- QUIET mode: issues = [], comment = null.
- LIVE mode: check the new work (image 2) against what came before. Flag real mistakes (algebra, signs, indices, factors, dimensions, misapplied identities) as "error", doubtful steps as "warn". Use "ok" sparingly, only to confirm a tricky step. Put each mark just to the right of its line (pixels in image 1).
- comment: one or two sentences only when worth saying now (a mistake, a useful connection, a missing condition); otherwise null. "spoken": the same comment phrased for speech, math in words, or null.
- Never comment on neatness or handwriting. Blue typeset blocks were written by the assistant.`;

const VERIFY_SYSTEM = `You double-check suspected mistakes on a scientist's handwritten page. Given the page images and a list of suspected issues, keep only the issues that are real, fix their notes if needed, and reply with ONE JSON object:
{"issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"..."}],"comment":null or "...","spoken":null or "..."}`;

export class Perception {
  constructor({ board, panel, voice, agent }) {
    this.board = board;
    this.panel = panel;
    this.voice = voice;
    this.agent = agent;
    this.pending = null;
    this.running = false;
    this.lastRun = 0;
    on('settled', (bb) => this.onSettled(bb));
    on('page', () => { this.pending = null; });
  }

  onSettled(bb) {
    if (settings.attention === 'demand' || !settings.apiKey) return;
    this.pending = union(this.pending, bb);
    this.schedule();
  }

  schedule(extra = 0) {
    clearTimeout(this.timer);
    const wait = Math.max(0, this.lastRun + settings.watchIntervalSec * 1000 - Date.now()) + extra;
    this.timer = setTimeout(() => this.run(), wait);
  }

  async run() {
    if (!this.pending || settings.attention === 'demand') return;
    if (this.running || this.agent.busy) return this.schedule(1500);
    const dirty = this.pending;
    this.pending = null;
    this.running = true;
    this.lastRun = Date.now();
    const b = this.board;
    const pageId = b.page.id;
    const live = settings.attention === 'live';
    try {
      const snap = b.snapshot();
      const crop = b.snapshot({ region: dirty, maxDim: 1000, maxScale: 3, pad: 20 });
      const nb = b.page.notebook.map((e) => ({ key: e.key, latex: e.latex, description: e.description }));
      const text = `Image 1: the whole page (${snap.width}x${snap.height}px). Image 2: the region that just changed, at ${JSON.stringify(b.rectToImage(snap, dirty))} in image 1.
Current notebook: ${JSON.stringify(nb)}
Mode: ${live ? 'LIVE' : 'QUIET'}
Return the JSON only.`;
      const resp = await claude({
        model: settings.models.watch,
        system: WATCH_SYSTEM,
        messages: [{ role: 'user', content: [imageBlock(snap), imageBlock(crop), { type: 'text', text }] }],
        max_tokens: 2500,
      });
      const j = parseJSON(textOf(resp));
      if (!j || b.page.id !== pageId) return;

      if (Array.isArray(j.notebook)) {
        b.page.notebook = j.notebook
          .filter((e) => e && e.latex)
          .map((e) => {
            const w = Number.isFinite(e.x) && Number.isFinite(e.y) ? b.imageToWorld(snap, e.x, e.y) : {};
            return { key: String(e.key || e.latex.slice(0, 20)), latex: e.latex, description: e.description || '', x: w.x, y: w.y };
          });
        b.saveSoon();
      }

      if (!live) return;
      let issues = Array.isArray(j.issues) ? j.issues : [];
      let comment = j.comment || null;
      let spoken = j.spoken || null;
      if (settings.escalate && issues.some((i) => i.kind === 'error')) {
        const v = await this.verify(snap, crop, issues);
        if (v) {
          issues = Array.isArray(v.issues) ? v.issues : issues;
          comment = v.comment ?? comment;
          spoken = v.spoken ?? spoken;
        }
      }
      if (b.page.id !== pageId) return;
      b.replaceMarks(
        'watch',
        issues.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y)).map((i) => ({ ...b.imageToWorld(snap, i.x, i.y), kind: i.kind || 'note', note: i.note || '' })),
      );
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

  async verify(snap, crop, issues) {
    try {
      const resp = await claude({
        model: settings.models.deep,
        system: VERIFY_SYSTEM,
        messages: [{
          role: 'user',
          content: [imageBlock(snap), imageBlock(crop), { type: 'text', text: `Suspected issues (pixels in image 1): ${JSON.stringify(issues)}\nReturn the JSON only.` }],
        }],
        max_tokens: 2000,
      });
      return parseJSON(textOf(resp));
    } catch {
      return null;
    }
  }
}
