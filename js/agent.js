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
import { pageText } from './pdfbg.js';

const MAX_STEPS = 14;

// The app's own tools, plus Anthropic's server-side web search when it is allowed (answers only).
function toolsNow() {
  if (!settings.webSearch) return TOOL_SCHEMAS;
  const max = Math.floor(Number(settings.webSearchMax) || 0);
  return [...TOOL_SCHEMAS, { type: 'web_search_20250305', name: 'web_search', ...(max > 0 ? { max_uses: max } : {}) }];
}

// Answer text for the panel. With web search the reply comes in many small cited pieces: join them
// without breaks (they are parts of one paragraph) and list the cited pages as sources at the end.
function answerText(resp) {
  const blocks = (resp.content || []).filter((b) => b.type === 'text');
  let out = '';
  blocks.forEach((b, i) => {
    const cited = b.citations?.length || blocks[i - 1]?.citations?.length;
    out += (i === 0 ? '' : cited ? '' : '\n') + b.text;
  });
  const seen = new Map();
  for (const b of blocks) for (const c of b.citations || []) if (c.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
  if (seen.size) out = out.trim() + '\n\n**Sources:** ' + [...seen].map(([u, t]) => `[${t.replace(/[\[\]]/g, '')}](${u})`).join(' · ');
  return out.trim();
}
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
- The user's current selection (a box, or a freehand lasso outline) is given in board_context.selection, and a second image shows it close up; with a lasso, everything outside the outline is faded. "This" usually means what they selected.
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
- ${s.webSearch ? 'web_search: when the user asks you to look something up (a paper, an arXiv preprint, a reference, a current value), search as much as it takes to find it. Without being asked, search only when the question needs current or outside facts (a recent measurement, a specific paper\'s result, a convention in a named source); never for textbook physics or derivations. Your citations are listed as sources under the answer automatically.' : 'Web search is turned off in settings: if a question needs it, say so.'}
- A notebook can be made from a PDF: then a page may have a PDF page as its background (board_context.pdf_page: its printed text and where it is). The user writes on top; you never change the PDF. Blank pages may sit between PDF pages.
- The session may have several pages; you see only the current one. board_context.other_pages lists the others (their notes and your blocks, as text). When a question needs another page ("look at page 3", "use the result from earlier", "compare with page 2"), call view_page for it. Use go:true only when the user asks to go to / open / show that page.
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
// Web search blocks (the search and its results, which are long) are dropped from finished turns too,
// so later questions don't keep paying to re-read old search results; the answer text stays.
const isThinking = (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
function dropThinking(ex) {
  return ex.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some((b) => isThinking(b) || b.citations)) return m;
    const content = m.content.filter((b) => !isThinking(b)).map((b) => (b.citations ? { type: 'text', text: b.text } : b));
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

  async buildTurn(text, { selection, origin }) {
    const b = this.board;
    const max = settings.imageMaxPx || 1100;
    // A page from a PDF: its printed text goes as text (exact small print, cheap), and the image is the page as you
    // see it (print + your ink) around what you wrote; a page without a text layer (a scan) is sent whole.
    let pdf = null;
    if (b.page.bg) {
      const bg = b.page.bg;
      let printed = null;
      try { printed = await pageText(bg); } catch {}
      await b.bgReady(b.page, 1500);
      pdf = { bg, printed, scanned: !printed || printed.text.replace(/\s/g, '').length < 40 };
    }
    // With a selection, the selection carries the detail, so the full page can be smaller.
    const snap = pdf?.scanned
      ? b.snapshot({ region: b.pageRect(), maxDim: max, maxScale: 1.5, pad: 0 })
      : b.snapshot({ region: pdf ? this.pdfRegion() : null, maxDim: selection ? Math.min(800, max) : max, maxScale: 1.5 });
    this.lastSnap = snap;
    const content = [imageBlock(snap)];
    if (selection) content.push(imageBlock(b.snapshot({ region: selection, maxDim: max, maxScale: 2.5, pad: 12 })));
    const page = b.page;
    const ctx = {
      page: page.name,
      session_type: b.layout ? `notebook${b.layout.pdf ? ' from a PDF' : ''}: page ${b.pi + 1} of ${b.pages.length}, ${b.page.bg ? `PDF page ${b.page.bg.page} as background` : b.layout.pdf ? `a blank ${b.layout.size} page added between PDF pages` : `${b.layout.size} ${b.layout.orient}`}; the image shows the page. Board writing stays on the page; what doesn't fit continues on the next page.` : 'freeform (an endless page)',
      session: this.sessions?.meta ? { title: this.sessions.meta.title, summary: this.sessions.meta.summary || undefined } : undefined,
      image: { width: snap.width, height: snap.height, note: 'All x,y for tools are pixels in the FIRST image.' },
      selection: selection ? { ...b.rectToImage(snap, selection), shape: selection.path ? 'lasso (only what is inside the outline)' : 'box' } : null,
      your_board_blocks: page.blocks.filter((x) => x.kind !== 'image').map((x) => ({ id: x.id, at: b.rectToImage(snap, { x: x.x, y: x.y, w: x.w || 0, h: x.h || 0 }), lines: x.lines })),
      notebook: page.notebook.slice(-40).map((e) => ({ key: e.key, latex: e.latex, description: e.description, at: Number.isFinite(e.x) ? b.worldToImage(snap, e.x, e.y) : null })),
      // the session's other pages, as text only (cheap); view_page fetches one when it is needed
      other_pages: b.pages.length > 1 ? b.pages.map((p, i) => ({ p, i })).filter(({ i }) => i !== b.pi).map(({ p, i }) => ({
        page: i + 1,
        name: p.name,
        pdf_page: p.bg?.page,
        starred: p.starred || undefined,
        empty: !p.strokes.length && !p.blocks.length ? (p.bg ? 'no writing yet (printed PDF page)' : true) : undefined,
        notes: (p.notebook || []).slice(0, 8).map((e) => String(e.description || e.latex).slice(0, 80)),
        your_blocks: p.blocks.filter((x) => x.kind !== 'image' && x.lines?.length).slice(0, 4).map((x) => x.lines.join(' ').slice(0, 80)),
      })) : undefined,
      pdf_page: pdf ? this.pdfContext(pdf, snap) : undefined,
      input: origin,
    };
    content.push({ type: 'text', text: `<board_context>${JSON.stringify(ctx)}</board_context>\n\n${text}` });
    return content;
  }

  // What Claude gets about a PDF page: which page of which PDF, where the page is in the image, and the printed
  // lines with their positions in image pixels (lines outside the image are on the page but not in the picture).
  // On a PDF page: what you wrote plus the print just above and beside it (often the problem it answers).
  pdfRegion() {
    const b = this.board, cb = b.contentBounds(), pr = b.pageRect();
    if (!cb) return null; // nothing written: the whole page
    const x0 = Math.max(0, cb.x - 60), y0 = Math.max(0, cb.y - 180), x1 = Math.min(pr.w, cb.x + cb.w + 60), y1 = Math.min(pr.h, cb.y + cb.h + 40);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  pdfContext({ bg, printed, scanned }, snap) {
    const b = this.board;
    const name = b.layout?.pdf?.name || 'PDF';
    const out = {
      source: `${name}, page ${bg.page}`,
      page_in_image: b.rectToImage(snap, b.pageRect()),
      note: scanned
        ? 'This PDF page has no text layer (a scan): read it from the image. Your writing goes on the user\'s ink layer, never into the PDF; place it in empty space on the page.'
        : 'The printed text of this PDF page is in printed_lines (exact; maths may be garbled there, so trust the image for formulas). The image shows the page with the user\'s ink around what they wrote; call get_region (any x,y,w,h in the same pixel units, also outside the image but inside page_in_image) to see other parts. Your writing goes on the user\'s ink layer, never into the PDF; place it in empty space (margins, gaps between printed lines).',
    };
    if (!scanned) {
      let budget = 7000;
      out.printed_lines = [];
      for (const it of printed.items) {
        if (budget <= 0) { out.printed_lines.push({ text: '…(more lines; use get_region to read the rest)' }); break; }
        const t = it.text.slice(0, 300);
        budget -= t.length + 24;
        const r = b.rectToImage(snap, it);
        out.printed_lines.push({ at: [r.x, r.y, r.w, r.h], text: t });
      }
    }
    return out;
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
      ex.push({ role: 'user', content: await this.buildTurn(text, opts) });
      this.exchanges.push(ex);
      const ctx = { board: this.board, panel: this.panel, voice: this.voice, agent: this, changes: this.changes, sessions: this.sessions, exporter: this.exporter };
      for (let step = 0; step < MAX_STEPS; step++) {
        tiersUsed.add(this.tier);
        this.panel.status(`Thinking (${TIER_NAMES[this.tier]})…`);
        const { messages, historyEnd } = this.messages();
        const call = (msgs, end) => claude({
          model: settings.models[this.tier] || settings.models.main,
          system: systemPrompt(),
          messages: msgs,
          tools: toolsNow(),
          max_tokens: this.tier === 'fast' ? 8000 : 16000, // includes Claude's reasoning; only what is used is paid for
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
        const t = answerText(resp);
        if (t) lastEl = this.panel.add('assistant', t, { actions: this.answerActions(t) });
        // A long web search can pause mid-answer: send it back as it is and Claude carries on.
        if (resp.stop_reason === 'pause_turn') { this.panel.status('Searching the web…'); continue; }
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
    const style = b.aiStyle(sel ? { x: sel.x, y: sel.y + sel.h } : cb ? { x: cb.x, y: cb.y + cb.h } : null, sel);
    const fontPx = style.fontPx;
    const gap = fontPx * 1.1;
    const pos = sel ? { x: sel.x + sel.w + gap * 1.5, y: sel.y } : cb ? { x: cb.x + 10, y: cb.y + cb.h + gap } : { x: vis.x + 60, y: vis.y + 60 };
    b.setLocked(true);
    try {
      await b.addBlock({ lines, x: pos.x, y: pos.y, fontPx, color: style.color, strokePx: style.strokePx }, { animateMs: settings.writeAnimationMs });
    } finally {
      b.setLocked(false);
    }
  }
}
