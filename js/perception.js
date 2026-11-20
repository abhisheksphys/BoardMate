// Continuous perception, built to be cheap:
// - looks only after you pause (Live: watchIdleSec, Quiet live: quietIdleSec), at least every watchMaxWaitSec while you keep writing;
// - sends only the changed region (plus a little context above it) and its text notes, not the whole page;
// - uses the fast model; suspected errors are re-checked by the main model (not the most expensive one);
// - pauses when the daily budget is reached.
import { settings } from './settings.js';
import { on, emit, union } from './bus.js';
import { claude, textOf, parseJSON, imageBlock } from './claude.js';
import { overBudget, fmt } from './costs.js';
import { textIn } from './pdfbg.js';
import { DEEP, extraAreasAllowed, mapOf, mapForPrompt, applyMap, recentConversation, remarksOf, addRemark, dismissedOf, noteDismissed } from './awareness.js';

const WATCH_SYSTEM = `You watch a scientist's handwritten whiteboard page like a knowledgeable colleague standing beside them: you follow the work as a whole, not just the pen. You get an image of the region that just changed (with a little context above it), your notes on the page's equations, your map of the page, the recent conversation, and remarks you already made. Reply with ONE JSON object and nothing else:
{"notebook_upsert":[{"key":"short-id","latex":"...","description":"a few words","x":0,"y":0}],
 "notebook_remove":[],
 "map":{"goal":null,"areas":[{"id":"a1","name":"...","purpose":"...","uses":["a0"],"x0":0,"y0":0,"x1":0,"y1":0}],"remove":[],"open":null},
 "look_also":[],
 "issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"one short sentence","urgency":"now|pause|ask"}],
 "comment":null,
 "comment_urgency":"now|pause|ask",
 "spoken":null,
 "board_requests":[{"text":"...","x0":0,"y0":0,"x1":0,"y1":0}]}
Rules:
- notebook_upsert: equations or expressions visible in the image that are new or changed. Reuse an existing key when it is the same equation. x,y = left end of the equation in pixels of THIS image. notebook_remove: keys of notes whose equation was erased in this region.
- map (both modes): your picture of the whole page. Areas are parts of the work with a purpose (the setup, a derivation, a side calculation, a figure, a result). Add areas that appear, update ones that changed (box x0,y0,x1,y1 in pixels of image 1 when the area is in it; leave the box out otherwise), "uses" = ids of areas this one builds on. goal = what the user seems to be working towards (or null if unchanged). open = the list of unresolved points or doubts on the page, or null if unchanged. Send only what changed; {} when nothing did. At most about 12 areas.
- look_also (LIVE only): ids of map areas that are NOT in image 1 and that you must SEE before you can judge the new work (e.g. the new line uses a result, definition or sign convention from there and your notes don't settle it). You will be shown them and asked once more; still give your best answer now. Usually [].
- QUIET mode: issues [] and comment null (keep the notes and the map current).
- LIVE mode: check the newest work against the earlier lines, the areas it uses, your notes and the goal. Flag real mistakes (algebra, signs, indices, factors, dimensions, misapplied identities, inconsistency with another area) as "error", doubtful steps as "warn". Use "ok" sparingly. Put each mark just right of its line (pixels in this image).
- urgency, like a colleague choosing when to speak: "now" = an error the following lines will build on, or something the user clearly needs before going on; "pause" = doubtful steps, a better route, a consistency remark: can wait until they stop writing; "ask" = minor, only worth saying if they ask. Don't repeat a remark already made (listed), and never raise again anything like a remark the user dismissed.
- comment: one or two sentences only when worth saying; otherwise null. spoken: the same for speech, math in words, or null.
- board_requests (both modes): an instruction or question the user has handwritten FOR THE ASSISTANT in the new writing, e.g. "Write down the Lagrangian of the Standard Model", "derive this", "what comes next?", "Claude: check line 3". text = the words as written (fix obvious spelling); x0,y0,x1,y1 = the box around those words in pixels of THIS image. Only when the sentence looks finished. Not requests: titles, headings, notes to self, and problem statements the user is solving on the page themselves (e.g. "Q2. Show that ..." followed by their own working). Usually [].
- Marks the user draws are pointing, like a gesture: a "?" written next to something (alone, not part of maths) is a question about it: add a board_request with text like "The user put a ? next to <what>: explain or check it", box around the ? and its target. In LIVE mode, a result the user just circled or boxed is something they care about: check it with extra care. An arrow from one thing to another means they are connected.
- Never comment on neatness. Blue typeset blocks were written by the assistant. Be brief.`;

const PAUSE_MS = 7000; // "at a pause" = this long without writing
const STEP_IDLE_MS = 20000; // Deep: step back after this long without changes…
const STEP_GAP_MS = 90000; // …at most this often

const LOOK_AGAIN = 'Images 2 and after are the parts of the page you asked to see (names given). With them, give your final JSON for the new work in image 1 (all coordinates still in pixels of image 1). Do not ask for more areas (look_also: []).';

// Deep awareness: in a pause, one look at the whole page by the strong model, like a colleague stepping back.
const STEP_SYSTEM = `You are a knowledgeable colleague watching a scientist work on a handwritten whiteboard page. They have paused; you step back and look at the whole page. You get the whole page as an image, your notes, your map of the page, the recent conversation, and remarks already made. Reply with ONE JSON object:
{"map":{"goal":null,"areas":[{"id":"a1","name":"...","purpose":"...","uses":[],"x0":0,"y0":0,"x1":0,"y1":0}],"remove":[],"open":null},
 "issues":[{"x":0,"y":0,"kind":"error|warn","note":"one short sentence","urgency":"now|pause|ask"}],
 "comment":null,"comment_urgency":"pause"}
- map: bring your picture of the page up to date (boxes in pixels of this image; reuse ids; remove areas that are gone).
- issues (only in LIVE mode, else []): only big-picture problems a line-by-line check misses: parts of the page that contradict each other, a change in one place that breaks what was built on it elsewhere, a result that doesn't fit the goal or a limit/symmetry/dimension check, a step that will lead them astray. Not small slips already marked, not remarks already made or dismissed. Usually []. Put each mark just right of the line it concerns.
- comment: one or two sentences about the overall direction only if genuinely useful, else null.
- Never comment on neatness. Blue typeset blocks were written by the assistant.`;

const VERIFY_SYSTEM = `You double-check suspected mistakes on a scientist's handwritten page. Given the image, the notes about the rest of the page, and the suspected issues, keep only real issues (fix their notes if needed). Reply with ONE JSON object:
{"issues":[{"x":0,"y":0,"kind":"error|warn|ok","note":"..."}],"comment":null or "...","spoken":null or "..."}`;

// LaTeX that came through JSON with single backslashes: "\nabla" arrives as a newline + "abla", "\frac"
// as a form feed + "rac", and so on. Put the backslashes back.
const fixLatex = (s) => String(s || '').replace(/\n(?=[a-zA-Z])/g, '\\n').replace(/\t(?=[a-zA-Z])/g, '\\t').replace(/\r(?=[a-zA-Z])/g, '\\r').replace(/\f/g, '\\f').replace(/\x08/g, '\\b');

// Changed areas waiting for a look: a change joins an area when it is near it (roughly within a few lines),
// otherwise it starts a new one; never more than two areas (the two closest are joined).
const NEAR_X = 260, NEAR_Y = 180;
function addChange(list, bb) {
  let areas = [...(list || []), bb];
  const near = (a, b) => a.x - NEAR_X < b.x + b.w && b.x - NEAR_X < a.x + a.w && a.y - NEAR_Y < b.y + b.h && b.y - NEAR_Y < a.y + a.h;
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < areas.length && !merged; i++)
      for (let j = i + 1; j < areas.length && !merged; j++)
        if (near(areas[i], areas[j])) { areas[i] = union(areas[i], areas[j]); areas.splice(j, 1); merged = true; }
  }
  while (areas.length > 2) {
    let best = null;
    for (let i = 0; i < areas.length; i++)
      for (let j = i + 1; j < areas.length; j++) {
        const u = union(areas[i], areas[j]), grow = u.w * u.h - areas[i].w * areas[i].h - areas[j].w * areas[j].h;
        if (!best || grow < best.grow) best = { i, j, u, grow };
      }
    areas[best.i] = best.u;
    areas.splice(best.j, 1);
  }
  return areas;
}

export class Perception {
  constructor({ board, panel, voice, agent }) {
    this.board = board;
    this.panel = panel;
    this.voice = voice;
    this.agent = agent;
    this.events = [];
    this.verified = new Map(); // line content -> the strong model's verdict on a suspected error there
    window.liveWatcher = this;
    this.pending = null;
    this.stepped = new Map(); // page id -> what the page looked like at its last step back
    this.firstPendingAt = 0;
    this.running = false;
    on('settled', ({ bb, parts }) => this.onSettled(bb, parts));
    on('page', () => { this.pending = null; clearTimeout(this.timer); this.held = []; clearTimeout(this.pauseTimer); clearTimeout(this.stepTimer); });
    // any change: held remarks wait for the next pause; Deep awareness plans a step-back look
    on('changed', () => { if (this.held?.length) this.armPause(); this.armStepBack(); });
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
      `state: looking=${!!this.running} waiting=${!!this.pending?.length} claudeAnswering=${!!this.agent.busy} notesOnThisPage=${this.board.page.notebook.length}`,
      '',
      ...this.events.map((e) => `${e.t}  ${e.msg}${e.n > 1 ? `   (×${e.n}, last ${e.t2})` : ''}`),
    ].join('\n');
  }

  onSettled(bb, parts) {
    if (settings.attention === 'demand') return this.log('page changed: not looking (mode is On demand)');
    if (!settings.apiKey) return this.log('page changed: not looking (no API key)');
    if (!this.pending?.length) this.firstPendingAt = Date.now();
    for (const p of parts?.length ? parts : [bb]) this.pending = addChange(this.pending, p);
    this.leftover = false;
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

  // what a colleague would also have in mind: the page map, the conversation, what was already said or dismissed
  contextText(crop) {
    const page = this.board.page;
    const said = remarksOf(page).slice(-8).map((r) => r.text);
    const dis = dismissedOf(page);
    return `Map of the page: ${mapForPrompt(this.board, page, crop)}\nRecent conversation in the panel:\n${recentConversation(this.agent.sessions)}\nRemarks already made or held: ${said.length ? JSON.stringify(said) : 'none'}\nRemarks the user dismissed (never raise these or anything like them again): ${dis.length ? JSON.stringify(dis) : 'none'}`;
  }

  notesText() {
    return JSON.stringify(this.board.page.notebook.slice(-30).map((e) => ({ key: e.key, latex: e.latex, description: e.description })));
  }

  async run() {
    if (!this.pending?.length || settings.attention === 'demand') return;
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
    // Changes far apart (a fix near the top, then more at the bottom) are looked at separately, each sharp,
    // instead of one big mostly-empty picture; at most two areas.
    const dirty = this.pending.shift();
    this.leftover = this.pending.length > 0;
    if (!this.pending.length) this.pending = null;
    else this.log(`changes in ${this.pending.length + 1} separate areas: looking at each`);
    this.running = true;
    const b = this.board;
    const pageId = b.page.id;
    const live = settings.attention === 'live';
    try {
      // The changed region plus some context above and around it.
      const region = { x: dirty.x - 60, y: dirty.y - 140, w: dirty.w + 120, h: dirty.h + 170 };
      // A PDF page: the print under and around the new writing is in the picture, and its text goes along too.
      let printed = '';
      if (b.page.bg) {
        await b.bgReady(b.page, 1500);
        try { printed = (await textIn(b.page.bg, region)).slice(0, 2500); } catch {}
      }
      const crop = b.snapshot({ region, maxDim: Math.min(900, settings.imageMaxPx || 900), maxScale: 2, pad: 0 });
      const content = [imageBlock(crop)];
      // First look at a page: also a small overview so the notes start complete.
      if (!b.page.notebook.length) content.push(imageBlock(b.snapshot({ maxDim: 700, maxScale: 1 })));
      content.push({
        type: 'text',
        text: `${content.length > 1 ? 'Image 2 is a small overview of the whole page (for notes only; give coordinates in image 1). ' : ''}${b.page.bg ? `This page is a printed PDF page the user writes on: the print is context (e.g. the problem being worked); check and note only the user's handwriting. ${printed ? `Printed text in image 1 (exact):\n${printed}\n` : ''}` : ''}Notes about the page so far: ${this.notesText()}\n${this.contextText(crop)}\nMode: ${live ? 'LIVE' : 'QUIET'}\nReturn the JSON only.`,
      });
      const effort = !live && settings.quietLowEffort ? 'low' : undefined;
      this.log(`looking (${live ? 'Live' : 'Quiet live'}${effort ? ', low effort' : ''}): changed area ${Math.round(dirty.w)}×${Math.round(dirty.h)}${content.length > 2 ? ' + page overview' : ''}`);
      this.panel.status('Claude is looking at your writing…');
      const t0 = Date.now();
      const resp = await claude({
        model: settings.models.fast,
        system: WATCH_SYSTEM,
        messages: [{ role: 'user', content }],
        max_tokens: 4000, // room for the model's own reasoning as well as the JSON (only what is used is paid for)
        purpose: 'watch',
        effort,
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
      const mapped = applyMap(b, b.page, j.map, crop);
      b.saveSoon();

      // Claude asked to see other parts of the page before judging (Normal: at most 1, Deep: up to 3)
      const want = live && Array.isArray(j.look_also) ? j.look_also.map(String) : [];
      if (want.length) {
        const areas = mapOf(b.page).areas.filter((a) => want.includes(a.id)).slice(0, extraAreasAllowed());
        if (areas.length && !overBudget()) {
          this.log(`asked to see ${areas.map((a) => `"${a.name}"`).join(', ')} before judging: looking again with ${areas.length === 1 ? 'it' : 'them'}`);
          const extra = areas.map((a) => imageBlock(b.snapshot({ region: { x: a.x - 20, y: a.y - 20, w: a.w + 40, h: a.h + 40 }, maxDim: 700, maxScale: 1.5, pad: 0 })));
          const resp2 = await claude({
            model: settings.models.fast,
            system: WATCH_SYSTEM,
            messages: [{ role: 'user', content: [content[0], ...extra, { type: 'text', text: `${content[content.length - 1].text}\n\n${LOOK_AGAIN} Areas shown: ${areas.map((a, i) => `image ${i + 2} = ${a.id} "${a.name}"`).join(', ')}.` }] }],
            max_tokens: 4000,
            purpose: 'watch',
          });
          const j2 = parseJSON(textOf(resp2));
          if (j2 && b.page.id === pageId) {
            for (const k of ['issues', 'comment', 'comment_urgency', 'spoken']) if (k in j2) j[k] = j2[k];
            if (Array.isArray(j2.board_requests) && j2.board_requests.length) j.board_requests = j2.board_requests;
            applyMap(b, b.page, j2.map, crop);
          }
        }
      }

      const reqs = Array.isArray(j.board_requests) ? j.board_requests : [];
      this.log(`reply after ${secs} s: ${(j.notebook_upsert || []).length} note(s) updated, ${mapped ? 'map updated, ' : ''}${(j.issues || []).length} mark(s), comment ${j.comment ? 'yes' : 'no'}, ${reqs.length} board request(s)${reqs.length ? ': ' + reqs.map((r) => `"${r.text}"`).join(', ') : ''}${resp.stop_reason === 'max_tokens' ? ' (reply was cut off)' : ''}`);
      for (const r of reqs) this.takeRequest(r, crop, region);

      if (!live) return;
      let issues = Array.isArray(j.issues) ? j.issues : [];
      let comment = j.comment || null;
      let spoken = j.spoken || null;
      if (settings.escalate && issues.some((i) => i.kind === 'error')) {
        // Each suspected error belongs to a line, identified by its content (its LaTeX in the notes).
        // A suspicion on a line the strong model has already judged, unchanged since, reuses that verdict;
        // any new or edited line is double-checked as before.
        const keyOf = (i) => {
          if (!Number.isFinite(i.x) || !Number.isFinite(i.y)) return null;
          const w = b.imageToWorld(crop, i.x, i.y);
          let best = null, bd = Infinity;
          for (const e of b.page.notebook) if (Number.isFinite(e.y) && Math.abs(e.y - w.y) < bd) { bd = Math.abs(e.y - w.y); best = e; }
          return best && bd < 50 ? `${pageId}|${best.latex.replace(/\s+/g, '')}` : null;
        };
        const errs = issues.filter((i) => i.kind === 'error');
        const keys = errs.map(keyOf);
        if (keys.every((k) => k && this.verified.has(k))) {
          const others = issues.filter((i) => i.kind !== 'error');
          issues = [...others, ...errs.flatMap((i, n) => { const v = this.verified.get(keys[n]); return v.keep ? [{ ...i, kind: v.kind, note: v.note }] : []; })];
          if (!others.length) { comment = null; spoken = null; } // the comment on these was already given
          this.log(`suspected error(s) on line(s) already double-checked and unchanged: reused the verdict (no extra call)`);
        } else {
          const v = await this.verify(crop, issues);
          if (v) {
            const before = issues;
            issues = Array.isArray(v.issues) ? v.issues : issues;
            // the double-check doesn't decide timing: keep the urgency of the nearest original remark
            for (const i of issues) if (!i.urgency) { let best = null, bd = Infinity; for (const o of before) { const d = Math.hypot((o.x || 0) - (i.x || 0), (o.y || 0) - (i.y || 0)); if (d < bd) { bd = d; best = o; } } if (best?.urgency && bd < 80) i.urgency = best.urgency; }
            comment = v.comment ?? comment;
            spoken = v.spoken ?? spoken;
            const kept = issues.filter((i) => i.kind === 'error' || i.kind === 'warn');
            errs.forEach((i, n) => {
              if (!keys[n]) return;
              const k = kept.find((q) => keyOf(q) === keys[n]);
              this.verified.set(keys[n], k ? { keep: true, kind: k.kind, note: k.note } : { keep: false });
            });
            if (this.verified.size > 300) this.verified.delete(this.verified.keys().next().value);
            this.log(`double-checked ${errs.length} suspected error(s) with the strong model: ${kept.length} kept`);
          }
        }
      }
      if (b.page.id !== pageId) return;
      // Replace this region's marks only; marks elsewhere on the page stay.
      const inRegion = (m) => m.x >= region.x && m.x <= region.x + region.w && m.y >= region.y && m.y <= region.y + region.h;
      const keep = b.page.marks.filter((m) => m.src === 'watch' && !inRegion(m));
      const fresh = issues.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y)).map((i) => ({ ...b.imageToWorld(crop, i.x, i.y), kind: i.kind || 'note', note: i.note || '', urgency: i.urgency }));
      b.replaceMarks('watch', [...keep.map(({ id, src, ...m }) => m), ...fresh]);
      // What to say, and when: "now" at once, "pause" when you stop writing, "ask" kept for when you ask.
      // Every new ✗ / ! gets words (not only the optional comment); nothing already said is repeated.
      this.deliver({ pageId, comment, commentUrgency: j.comment_urgency, spoken, marks: fresh });
    } catch (e) {
      this.log('error: ' + (e.message || e));
      this.panel.status('Watcher: ' + (e.message || e));
      setTimeout(() => this.panel.status(''), 5000);
    } finally {
      if (!this.agent.busy) this.panel.status(''); // clear "looking…" unless an answer's own status is showing
      this.running = false;
      if (this.pending?.length) {
        if (this.leftover) { clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 400); } // the other area, right away
        else this.schedule();
      }
    }
  }

  // ---- Deep awareness: step back in a pause and look at the whole page (strong model) ----
  armStepBack() {
    clearTimeout(this.stepTimer);
    if (!DEEP() || settings.attention === 'demand' || !settings.apiKey) return;
    this.stepTimer = setTimeout(() => this.stepBack(), STEP_IDLE_MS);
  }

  pageStamp(page) {
    const last = page.strokes[page.strokes.length - 1];
    return `${page.id}|${page.strokes.length}|${last?.id || ''}|${page.blocks.length}`;
  }

  async stepBack() {
    const b = this.board, page = b.page;
    if (!DEEP() || settings.attention === 'demand' || !settings.apiKey) return;
    if (this.running || this.agent.busy || this.pending?.length) { this.stepTimer = setTimeout(() => this.stepBack(), 4000); return; }
    const stamp = this.pageStamp(page);
    if (this.stepped.get(page.id) === stamp) return; // nothing new since the last step back on this page
    if (!page.strokes.length || page.strokes.length < 6) return; // too little on the page to need it
    if (Date.now() - (this.lastStep || 0) < STEP_GAP_MS) { this.stepTimer = setTimeout(() => this.stepBack(), STEP_GAP_MS - (Date.now() - this.lastStep) + 500); return; }
    if (overBudget()) return this.log('step back: skipped (daily budget used up)');
    this.running = true;
    this.lastStep = Date.now();
    this.stepped.set(page.id, stamp);
    const live = settings.attention === 'live';
    const pageId = page.id;
    try {
      if (page.bg) await b.bgReady(page, 1200);
      const snap = b.snapshot({ maxDim: 1000, maxScale: 1, pad: 20 });
      this.log(`stepping back: a look at the whole page (${settings.models.main}, Deep awareness)`);
      this.panel.status('Claude is looking over the whole page…');
      const resp = await claude({
        model: settings.models.main,
        system: STEP_SYSTEM,
        messages: [{ role: 'user', content: [imageBlock(snap), { type: 'text', text: `Notes: ${this.notesText()}\n${this.contextText(snap)}\nMode: ${live ? 'LIVE' : 'QUIET'}\nReturn the JSON only.` }] }],
        max_tokens: 6000,
        purpose: 'stepback',
      });
      const j = parseJSON(textOf(resp));
      if (!j) return this.log('step back: could not read the reply');
      if (b.page.id !== pageId) return;
      const mapped = applyMap(b, b.page, j.map, snap);
      const issues = live && Array.isArray(j.issues) ? j.issues.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y) && (i.kind === 'error' || i.kind === 'warn')) : [];
      const marks = issues.map((i) => ({ ...b.imageToWorld(snap, i.x, i.y), kind: i.kind, note: i.note || '', urgency: i.urgency === 'ask' ? 'ask' : 'now' })); // it is a pause already
      if (marks.length) b.replaceMarks('watch', [...b.page.marks.filter((m) => m.src === 'watch').map(({ id, src, ...m }) => m), ...marks]);
      this.log(`step back: ${mapped ? 'map updated' : 'map unchanged'}, ${marks.length} big-picture remark(s)${j.comment ? ' + comment' : ''}`);
      if (live) this.deliver({ pageId, comment: j.comment, commentUrgency: j.comment_urgency === 'ask' ? 'ask' : 'now', marks, header: marks.length || j.comment ? 'Looking over the whole page: ' : '' });
      b.saveSoon();
    } catch (e) {
      this.log('step back: error: ' + (e.message || e));
    } finally {
      if (!this.agent.busy) this.panel.status('');
      this.running = false;
      if (this.pending?.length) this.schedule();
    }
  }

  // ---- remarks and their timing ----
  deliver({ pageId, comment, commentUrgency, spoken, marks, header = '' }) {
    const b = this.board;
    if (b.page.id !== pageId) return;
    const said = (this.announced ||= new Set());
    const keyOf = (m) => `${pageId}|${Math.round(m.y / 40)}|${String(m.note).toLowerCase().replace(/\W+/g, '').slice(0, 60)}`;
    const news = marks.filter((m) => (m.kind === 'error' || m.kind === 'warn') && m.note && !said.has(keyOf(m)));
    news.forEach((m) => said.add(keyOf(m)));
    if (said.size > 500) said.delete(said.values().next().value);
    const urg = (u, dflt) => (['now', 'pause', 'ask'].includes(u) ? u : dflt);
    const items = news.map((m) => ({ text: `${m.kind === 'error' ? '✗' : '!'} ${m.note}`, note: m.note, mark: m, urgency: urg(m.urgency, m.kind === 'error' ? 'now' : 'pause') }));
    if (comment) items.unshift({ text: String(comment), urgency: urg(commentUrgency, 'pause'), comment: true });
    if (!items.length) {
      if (marks.some((m) => m.kind === 'error' || m.kind === 'warn')) this.log('marks already explained in the panel earlier: not repeated');
      return;
    }
    const page = b.page;
    for (const it of items.filter((x) => x.urgency === 'ask')) addRemark(page, { text: it.text, urgency: 'ask', delivered: false });
    const now = items.filter((x) => x.urgency === 'now');
    const later = items.filter((x) => x.urgency === 'pause');
    if (now.length) this.post(now, { header, spoken: now.some((x) => x.comment) ? spoken : null });
    if (later.length) {
      if (this.heldPage !== pageId) this.held = [];
      this.heldPage = pageId;
      (this.held ||= []).push(...later);
      for (const it of later) addRemark(page, { text: it.text, urgency: 'pause', delivered: false, held: true });
      this.armPause();
    }
    const asked = items.length - now.length - later.length;
    this.log(`remarks: ${now.length} now${later.length ? `, ${later.length} held for a pause` : ''}${asked ? `, ${asked} kept for when asked` : ''}`);
    b.saveSoon();
  }

  // held remarks come out once you have stopped writing for a few seconds
  armPause() {
    clearTimeout(this.pauseTimer);
    if (!this.held?.length) return;
    this.pauseTimer = setTimeout(() => this.flushHeld(), PAUSE_MS);
  }

  flushHeld() {
    const b = this.board;
    if (!this.held?.length || this.heldPage !== b.page.id) { this.held = []; return; }
    if (this.running || this.agent.busy) { this.pauseTimer = setTimeout(() => this.flushHeld(), 2000); return; }
    const items = this.held;
    this.held = [];
    for (const r of remarksOf(b.page)) if (r.held) delete r.held;
    this.post(items, { header: 'While you paused: ' });
    this.log(`pause: ${items.length} held remark(s) said`);
  }

  post(items, { header = '', spoken = null } = {}) {
    const b = this.board, page = b.page;
    const marks = items.filter((x) => x.mark).map((x) => x.mark);
    const text = header + items.map((x) => x.text).join('\n\n');
    for (const it of items) {
      const r = remarksOf(page).find((x) => x.text === it.text && !x.delivered);
      if (r) r.delivered = true; else addRemark(page, { text: it.text, urgency: it.urgency, delivered: true });
    }
    const liveMark = (m) => page.marks.find((x) => x.src === 'watch' && Math.abs(x.x - m.x) < 1 && Math.abs(x.y - m.y) < 1);
    this.panel.add('commentary', text, {
      actions: [
        ...(marks.length ? [{ label: marks.length > 1 ? 'Write the fixes on the page' : 'Write the fix on the page', run: () => marks.forEach((m) => { const lm = liveMark(m); if (lm) this.agent.explainMark(lm); }) }] : []),
        // Dismiss: the message goes away (also from the saved chat), its marks too, and Claude won't raise it again
        { label: 'Dismiss', run: (btn) => {
          const notes = new Set(marks.map((m) => m.note));
          const gone = new Set(page.marks.filter((x) => x.src === 'watch' && notes.has(x.note)));
          if (gone.size) { page.marks = page.marks.filter((x) => !gone.has(x)); b.render(); }
          noteDismissed(page, items.map((x) => x.note || x.text));
          b.saveSoon();
          btn?.closest('.msg')?.remove();
          emit('panel-dismiss', { role: 'commentary', md: text });
        } },
      ],
    });
    if (settings.liveSpeak && settings.voiceOut && !this.agent.busy) this.voice.speak(spoken || text.replace(/\$+/g, '').replace(/[✗!] /g, ''));
    b.saveSoon();
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
        'If the result is something to write (an explanation, a derivation, equations, a list), write it on the board with write_on_canvas ' +
        'using anchor "below_selection", as fully as the request needs (headings, explanations and every step, not terse fragments), and keep your panel reply to one short line. Otherwise answer in the panel.',
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
        max_tokens: 4000, // room for the strong model's reasoning; only what is used is paid for
        purpose: 'verify',
      });
      return parseJSON(textOf(resp));
    } catch {
      return null;
    }
  }
}
