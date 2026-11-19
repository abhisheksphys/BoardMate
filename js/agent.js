// The main assistant: every question (typed, spoken or from an action button) goes to Claude
// together with the latest image of the page, your selection, and its notebook. No command parsing.
import { settings } from './settings.js';
import { claude, textOf, imageBlock } from './claude.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';

const MAX_EXCHANGES = 12;
const MAX_STEPS = 14;

function systemPrompt() {
  const s = settings;
  const custom = s.customInstructions?.length ? `\nStanding instructions from the user:\n- ${s.customInstructions.join('\n- ')}\n` : '';
  return `You are the live assistant inside "Live Board", a handwriting whiteboard the user writes on with an Apple Pencil. The user is a scientist. You see their page as images, hear them through speech-to-text, and read their typed messages.

Understanding the board
- Read the page images directly, the way you would read a photo of notes or a book page. The user refers to things freely ("the one that looks like Maxwell's equation", "my second line", "what I just crossed out", "this" while something is selected). Work out what they mean from the image; ask only if it is genuinely ambiguous.
- Blue typeset blocks with a thin bar on their left are things you wrote earlier. Small circled symbols are margin marks.
- A dashed blue rectangle (and the second image, when present) is the user's current selection: "this" usually means it.
- If something is too small or messy to read, call get_region for a sharper view.
- Speech-to-text garbles math words ("curls" for curl, "dell" for del, "partial tea" for partial t); interpret charitably.

Answering
- Put full answers in your text reply, shown in the side panel. Use Markdown with LaTeX: $...$ inline, $$...$$ display.
- For any symbolic computation (curl, divergence, expanding, simplifying, solving, integrating, series, checking equalities) use the cas tool rather than doing the algebra in your head; then explain.
- When the user asks you to write, continue, fill in, or put something on the board, use write_on_canvas${s.allowBoardWrite ? '' : ' (currently turned off: say so and answer in the panel)'}. Place it next to what it relates to. Keep board content short: equations and brief labels.
- Use annotate to flag a specific spot (an error, a check, a note).
- ${s.voiceOut ? 'Voice replies are ON: call speak with a short natural spoken version of your answer (1-3 sentences, no LaTeX, math in words), then give the full written answer.' : 'Voice replies are OFF: do not call speak unless asked.'}
- Use search_library and show_page for the user's own PDFs.
- Keep your notebook (notebook_update) current with the equations you read: LaTeX, short description, position. It is your memory of the page.
- Be concise and precise. The user is an expert; skip basics unless asked.

Changing the app itself
- Settings change through update_settings. Apply it when the user asks ("from now on…", "move the panel to the left"). If you only think a change would help, suggest it and wait for a yes.
- save_action creates a reusable one-tap button for something they ask often.
- For features or fixes that need code, call propose_code_change with a clear request; the user approves the pull request before anything changes. Call ship_change or roll_back only when the user explicitly asks; they still confirm with a button.
- Call log_friction when something went wrong or you could not do what was asked.

Current state: attention=${s.attention}, voiceIn=${s.voiceIn}, voiceOut=${s.voiceOut}, boardWriting=${s.allowBoardWrite}, panel=${s.panelPosition}.${custom}`;
}

// Replace images in older turns with a placeholder to keep requests small.
function stripImages(content) {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (b.type === 'image') return { type: 'text', text: '[earlier image omitted]' };
    if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: stripImages(b.content) };
    return b;
  });
}

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

  messages() {
    const recent = this.exchanges.slice(-MAX_EXCHANGES);
    const out = [];
    recent.forEach((ex, i) => {
      const last = i === recent.length - 1;
      for (const m of ex) {
        const content = last ? m.content : stripImages(m.content);
        const prev = out[out.length - 1];
        if (prev && prev.role === m.role && m.role === 'user') {
          prev.content = [...(Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }]), ...content];
        } else out.push({ role: m.role, content });
      }
    });
    return out;
  }

  buildTurn(text, { selection, origin }) {
    const b = this.board;
    const snap = b.snapshot();
    this.lastSnap = snap;
    const content = [imageBlock(snap)];
    if (selection) content.push(imageBlock(b.snapshot({ region: selection, maxDim: 1200, maxScale: 3, pad: 12 })));
    const page = b.page;
    const ctx = {
      page: page.name,
      image: { width: snap.width, height: snap.height, note: 'All x,y for tools are pixels in the FIRST image.' },
      selection: selection ? b.rectToImage(snap, selection) : null,
      your_board_blocks: page.blocks.filter((x) => x.kind !== 'image').map((x) => ({ at: b.rectToImage(snap, { x: x.x, y: x.y, w: x.w || 0, h: x.h || 0 }), lines: x.lines })),
      notebook: page.notebook.map((e) => ({ key: e.key, latex: e.latex, description: e.description, at: Number.isFinite(e.x) ? b.worldToImage(snap, e.x, e.y) : null })),
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
    this.abort = new AbortController();
    const ex = [];
    this.panel.status('Looking at your page…');
    try {
      ex.push({ role: 'user', content: this.buildTurn(text, opts) });
      this.exchanges.push(ex);
      const ctx = { board: this.board, panel: this.panel, voice: this.voice, agent: this, changes: this.changes };
      for (let step = 0; step < MAX_STEPS; step++) {
        this.panel.status('Thinking…');
        const resp = await claude({
          model: opts.deep ? settings.models.deep : settings.models.main,
          system: systemPrompt(),
          messages: this.messages(),
          tools: TOOL_SCHEMAS,
          max_tokens: 4096,
          signal: this.abort.signal,
        });
        ex.push({ role: 'assistant', content: resp.content });
        const t = textOf(resp);
        if (t) this.panel.add('assistant', t, { actions: this.answerActions(t) });
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
      this.busy = false;
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
    return [
      { label: 'Put on board', run: () => this.putTextOnBoard(text) },
      { label: 'Copy', run: (btn) => navigator.clipboard?.writeText(text).then(() => { btn.textContent = 'Copied'; }) },
    ];
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
    const pos = sel ? { x: sel.x + sel.w + 36, y: sel.y } : cb ? { x: cb.x + 10, y: cb.y + cb.h + 30 } : { x: vis.x + 60, y: vis.y + 60 };
    b.setLocked(true);
    try {
      await b.addBlock({ lines, x: pos.x, y: pos.y }, { animateMs: settings.writeAnimationMs });
    } finally {
      b.setLocked(false);
    }
  }
}
