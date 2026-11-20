// The main assistant: every question (typed, spoken or from an action button) goes to Claude
// together with the latest image of the page, your selection, and its notebook. No command parsing.
//
// Cost design: the fast model answers first and hands off to a stronger one only when needed;
// tools + instructions + past conversation are prompt-cached; old turns are compacted (no images,
// short tool outputs) so the cached prefix stays stable; history is trimmed in chunks.
import { settings } from './settings.js';
import { claude, textOf, imageBlock } from './claude.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { fmt, overBudget } from './costs.js';

const MAX_STEPS = 14;
const TIER_NAMES = { fast: 'Haiku', main: 'Sonnet', deep: 'Opus' };
const nextTier = (t) => (t === 'fast' ? 'main' : 'deep');

function systemPrompt() {
  const s = settings;
  const custom = s.customInstructions?.length ? `\nStanding instructions from the user:\n- ${s.customInstructions.join('\n- ')}\n` : '';
  return `You are the live assistant inside "Live Board", a handwriting whiteboard the user writes on with an Apple Pencil. The user is a scientist. You see their page as images, hear them through speech-to-text, and read their typed messages.

Understanding the board
- Read the page images directly, the way you would read a photo of notes or a book page. The user refers to things freely ("the one that looks like Maxwell's equation", "my second line", "what I just crossed out", "this" while something is selected). Work out what they mean from the image; ask only if it is genuinely ambiguous.
- Blue typeset blocks with a thin bar on their left are things you wrote earlier. Small circled symbols are margin marks.
- Pictures on the page (figures, photos, screenshots, book pages) were pasted by the user; read them as part of the page.
- A dashed blue rectangle (and the second image, when present) is the user's current selection: "this" usually means it.
- If something is too small or messy to read, call get_region for a sharper view.
- Speech-to-text garbles math words ("curls" for curl, "dell" for del, "partial tea" for partial t); interpret charitably.

Answering
- Put full answers in your text reply, shown in the side panel. Use Markdown with LaTeX: $...$ inline, $$...$$ display.
- For any symbolic computation (curl, divergence, expanding, simplifying, solving, integrating, series, checking equalities) use the cas tool rather than doing the algebra in your head; then explain.
- When the user asks you to write, continue, fill in, or put something on the board, use write_on_canvas${s.allowBoardWrite ? '' : ' (currently turned off: say so and answer in the panel)'}. Place it next to what it relates to. Keep board content short: equations and brief labels.
- Text you write on the board is automatically sized to match the user's handwriting where it goes. If they ask for it bigger or smaller, use size_scale (new writing) or resize_board_block (something already written).
- Use annotate to flag a specific spot (an error, a check, a note).
- ${s.voiceOut ? 'Voice replies are ON: call speak with a short natural spoken version of your answer (1-3 sentences, no LaTeX, math in words), then give the full written answer.' : 'Voice replies are OFF: do not call speak unless asked.'}
- Use search_library and show_page for the user's PDFs (the shared library plus this session's own materials).
- Work is organised in sessions. To bring something from another session ("the boundary conditions from yesterday"), call list_sessions, then read_session, then write it here.
- Keep your notebook (notebook_update) current with the equations you read: LaTeX, short description, position. It is your memory of the page.
- Be concise and precise. The user is an expert; skip basics and preamble. Shorter answers also cost less.

Choosing the right model
- Several models share this conversation. If you are the fast model and the question needs careful multi-step reasoning (a long derivation, a proof, subtle physics, judging whether tricky work is correct) or you are not confident, call hand_off with level "main"; for the hardest problems use "deep". Do not hand off for reading the page, routine algebra (use cas), definitions, or short explanations.

Changing the app itself
- Settings change through update_settings. Apply it when the user asks ("from now on…", "move the panel to the left"). If you only think a change would help, suggest it and wait for a yes.
- save_action creates a reusable one-tap button for something they ask often.
- For features or fixes that need code, call propose_code_change with a clear request; the user approves the pull request before anything changes. Call ship_change or roll_back only when the user explicitly asks; they still confirm with a button.
- Call log_friction when something went wrong or you could not do what was asked.

Current state: attention=${s.attention}, voiceOut=${s.voiceOut}, boardWriting=${s.allowBoardWrite}, panel=${s.panelPosition}.${custom}`;
}

// Old turns: drop images and shorten long tool outputs. Done once per turn, so the cached prefix stays identical afterwards.
function compactBlock(b) {
  if (b.type === 'image') return { type: 'text', text: '[earlier image omitted]' };
  if (b.type === 'text' && b.text.includes('<board_context>')) {
    return { type: 'text', text: b.text.replace(/<board_context>[\s\S]*?<\/board_context>/, '<board_context>[omitted]</board_context>') };
  }
  if (b.type === 'tool_result') {
    let c = b.content;
    if (Array.isArray(c)) c = c.map(compactBlock);
    else if (typeof c === 'string' && c.length > 800) c = c.slice(0, 800) + ' …[truncated]';
    return { ...b, content: c };
  }
  return b;
}
// Claude's reasoning ("thinking") blocks are signed against the exact conversation before them. Once an
// earlier turn is shortened (images dropped, history trimmed) they no longer match and the API rejects the
// request, so they are removed from finished turns. Only the turn in progress needs them.
const isThinking = (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking');
function dropThinking(ex) {
  return ex.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some(isThinking)) return m;
    const content = m.content.filter((b) => !isThinking(b));
    return { ...m, content: content.length ? content : [{ type: 'text', text: '(no reply text)' }] };
  });
}
const compactExchange = (ex) => dropThinking(ex).map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map(compactBlock) : m.content }));

export class Agent {
  constructor({ board, panel, voice, changes }) {
    this.board = board;
    this.panel = panel;
    this.voice = voice;
    this.changes = changes;
    this.exchanges = [];
    this.queue = [];
    this.busy = false;
    this.lastSnap = null;
    this.abort = null;
    this.lastAskAt = 0;
    this.tier = 'fast';
  }

  reset() {
    this.exchanges = [];
  }

  stop() {
    this.abort?.abort();
    this.queue = [];
    this.voice.cancelSpeech();
    this.board.setLocked(false);
  }

  // Returns { messages, historyEnd } — historyEnd = index of the last message before the current turn.
  messages() {
    const out = [];
    let historyEnd = -1;
    const last = this.exchanges.length - 1;
    this.exchanges.forEach((ex, i) => {
      // finished turns never carry reasoning blocks (also cleans histories saved by older versions)
      for (const m of i === last ? ex : dropThinking(ex)) {
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && m.role === 'user') prev.content = [...prev.content, ...m.content];
        else out.push({ role: m.role, content: Array.isArray(m.content) ? m.content.slice() : m.content });
      }
      if (i === this.exchanges.length - 2) historyEnd = out.length - 1;
    });
    return { messages: out, historyEnd };
  }

  buildTurn(text, { selection, origin }) {
    const b = this.board;
    const max = settings.imageMaxPx || 1100;
    // With a selection, the selection carries the detail, so the full page can be smaller.
    const snap = b.snapshot({ maxDim: selection ? Math.min(800, max) : max, maxScale: 1.5 });
    this.lastSnap = snap;
    const content = [imageBlock(snap)];
    if (selection) content.push(imageBlock(b.snapshot({ region: selection, maxDim: max, maxScale: 2.5, pad: 12 })));
    const page = b.page;
    const ctx = {
      page: page.name,
      session: this.sessions?.meta ? { title: this.sessions.meta.title, summary: this.sessions.meta.summary || undefined } : undefined,
      image: { width: snap.width, height: snap.height, note: 'All x,y for tools are pixels in the FIRST image.' },
      selection: selection ? b.rectToImage(snap, selection) : null,
      your_board_blocks: page.blocks.filter((x) => x.kind !== 'image').map((x) => ({ id: x.id, at: b.rectToImage(snap, { x: x.x, y: x.y, w: x.w || 0, h: x.h || 0 }), lines: x.lines })),
      notebook: page.notebook.slice(-40).map((e) => ({ key: e.key, latex: e.latex, description: e.description, at: Number.isFinite(e.x) ? b.worldToImage(snap, e.x, e.y) : null })),
      input: origin,
    };
    content.push({ type: 'text', text: `<board_context>${JSON.stringify(ctx)}</board_context>\n\n${text}` });
    return content;
  }

  async ask(text, opts = {}) {
    if (!text?.trim()) return;
    if (this.busy) {
      this.queue.push([text, opts]);
      this.panel.status('Queued — finishing the current answer first');
      return;
    }
    this.busy = true;
    this.spokeThisTurn = false;
    this.turnSelection = opts.selection || null; // where this question points (a board request uses its own)
    this.abort = new AbortController();

    // Fresh conversation after a long break (its cache has expired anyway); trim history in chunks.
    if (Date.now() - this.lastAskAt > settings.idleResetMin * 60000) this.exchanges = [];
    const maxH = Math.max(1, settings.maxHistory);
    if (this.exchanges.length >= maxH) this.exchanges = this.exchanges.slice(-Math.ceil(maxH / 2));
    this.lastAskAt = Date.now();

    if (overBudget() && !this.warnedBudget) {
      this.warnedBudget = true;
      this.panel.add('info', `You have passed today's budget (${fmt(settings.dailyBudgetUSD)}). Answers still work; live watching is paused until tomorrow. Change the budget in Settings → Cost.`);
    }

    this.tier = opts.tier || (settings.routing === 'auto' ? 'fast' : settings.routing);
    const ex = [];
    let cost = 0;
    let lastEl = null;
    const tiersUsed = new Set();
    this.panel.status('Looking at your page…');
    try {
      ex.push({ role: 'user', content: this.buildTurn(text, opts) });
      this.exchanges.push(ex);
      const ctx = { board: this.board, panel: this.panel, voice: this.voice, agent: this, changes: this.changes, sessions: this.sessions };
      for (let step = 0; step < MAX_STEPS; step++) {
        tiersUsed.add(this.tier);
        this.panel.status(`Thinking (${TIER_NAMES[this.tier]})…`);
        const { messages, historyEnd } = this.messages();
        const call = (msgs, end) => claude({
          model: settings.models[this.tier] || settings.models.main,
          system: systemPrompt(),
          messages: msgs,
          tools: TOOL_SCHEMAS,
          max_tokens: this.tier === 'fast' ? 2048 : 4096,
          signal: this.abort.signal,
          purpose: 'answer',
          cacheAt: end >= 0 ? [end] : [],
          cacheLast: true,
        });
        let resp;
        try {
          resp = await call(messages, historyEnd);
        } catch (e) {
          // Safety net: if the API still objects to a reasoning block, retry once without any of them.
          if (!/thinking/i.test(e.message || '')) throw e;
          ex.splice(0, ex.length, ...dropThinking(ex));
          this.exchanges = this.exchanges.map((x) => (x === ex ? x : dropThinking(x)));
          const again = this.messages();
          resp = await call(again.messages, again.historyEnd);
        }
        cost += resp._cost || 0;
        ex.push({ role: 'assistant', content: resp.content });
        const t = textOf(resp);
        if (t) lastEl = this.panel.add('assistant', t, { actions: this.answerActions(t) });
        const uses = resp.content.filter((c) => c.type === 'tool_use');
        if (!uses.length) break;
        const results = [];
        for (const u of uses) {
          if (this.abort.signal.aborted) results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Cancelled by the user.', is_error: true });
          else results.push(await runTool(u, ctx));
        }
        ex.push({ role: 'user', content: results });
        if (this.abort.signal.aborted) break;
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        this.panel.add('error', e.message || String(e));
        if (settings.voiceOut) this.voice.speak('Sorry, something went wrong. The details are in the panel.');
      } else this.panel.add('info', 'Stopped.');
    } finally {
      this.closeDanglingToolUse(ex);
      const i = this.exchanges.indexOf(ex);
      if (i >= 0) this.exchanges[i] = compactExchange(ex);
      if (lastEl && cost) this.panel.footer(lastEl, `${fmt(cost)} · ${[...tiersUsed].map((t) => TIER_NAMES[t]).join(' → ')}`);
      this.busy = false;
      this.turnSelection = null;
      this.board.setLocked(false);
      this.panel.status('');
      const next = this.queue.shift();
      if (next) this.ask(...next);
    }
  }

  // If a turn ended right after a tool_use (abort/error), add matching tool_results so history stays valid.
  closeDanglingToolUse(ex) {
    const last = ex[ex.length - 1];
    if (!last || last.role !== 'assistant') return;
    const uses = (last.content || []).filter((c) => c.type === 'tool_use');
    if (uses.length) ex.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Cancelled.', is_error: true })) });
  }

  answerActions(text) {
    const actions = [
      { label: 'Put on board', run: () => this.putTextOnBoard(text) },
      { label: 'Copy', run: (btn) => navigator.clipboard?.writeText(text).then(() => { btn.textContent = 'Copied'; }) },
    ];
    if (this.tier !== 'deep') {
      const up = nextTier(this.tier);
      actions.push({
        label: `Think harder (${TIER_NAMES[up]})`,
        run: () => {
          this.panel.add('user', `▸ Think harder (${TIER_NAMES[up]})`);
          this.ask('Redo your last answer more carefully: re-read the page, check each step (use cas where useful), and correct anything wrong.', { tier: up, selection: this.board.selection, origin: 'think-harder button' });
        },
      });
    }
    return actions;
  }

  async putTextOnBoard(text) {
    const lines = [];
    const display = text.match(/\$\$[\s\S]+?\$\$/g);
    if (display?.length) display.forEach((d) => lines.push(d.replace(/\s+/g, ' ')));
    else text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12).forEach((l) => lines.push(l.replace(/^[-*#>]+\s*/, '')));
    const b = this.board;
    const sel = b.selection;
    const cb = b.contentBounds();
    const vis = b.visibleWorld();
    const fontPx = b.aiFontSize(sel ? { x: sel.x, y: sel.y + sel.h } : cb ? { x: cb.x, y: cb.y + cb.h } : null, sel);
    const gap = fontPx * 1.1;
    const pos = sel ? { x: sel.x + sel.w + gap * 1.5, y: sel.y } : cb ? { x: cb.x + 10, y: cb.y + cb.h + gap } : { x: vis.x + 60, y: vis.y + 60 };
    b.setLocked(true);
    try {
      await b.addBlock({ lines, x: pos.x, y: pos.y, fontPx }, { animateMs: settings.writeAnimationMs });
    } finally {
      b.setLocked(false);
    }
  }
}
