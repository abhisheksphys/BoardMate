// Tools Claude can call while answering. Pixel coordinates always refer to the latest full-page image.
import { settings, saveSettings, aiUpdateSettings, AI_EDITABLE } from './settings.js';
import { runSympy } from './cas.js';
import { searchLibrary, renderPage, listBooks } from './library.js';
import { imageBlock } from './claude.js';
import { emit } from './bus.js';
import { texErrors } from './mathrender.js';

export const TOOL_SCHEMAS = [
  {
    name: 'hand_off',
    description:
      'Pass this question to a stronger model, which continues with the full conversation. level "main" for careful multi-step reasoning, derivations, proofs, or checking subtle work; "deep" for the hardest problems. Not for reading the page, routine algebra, or short explanations.',
    input_schema: { type: 'object', properties: { level: { type: 'string', enum: ['main', 'deep'] }, reason: { type: 'string' } }, required: ['level'] },
  },
  {
    name: 'cas',
    description:
      'Run SymPy (Python) for exact symbolic math: differentiate, integrate, expand, simplify, solve, series, substitute, check equality, vector calculus. ' +
      'Preloaded: everything from sympy; sympy.vector CoordSys3D, curl, divergence, gradient, Del; a frame N = CoordSys3D("N") (N.x, N.y, N.z coordinates; N.i, N.j, N.k unit vectors); real symbols x, y, z, t. ' +
      'Assign the final answer to `result` (returned as text and LaTeX); print() anything else.',
    input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  {
    name: 'write_on_canvas',
    description:
      'Write typeset content on the board in the AI colour. `lines`: one entry per line. A line wrapped in $$...$$ is display math; other lines are text that may contain inline $...$. ' +
      'Keep it short: equations and brief labels. Position: anchor "below_content" (default), "below_selection", "right_of_selection", or "at_xy" with x,y = top-left in pixels of the latest page image.',
    input_schema: {
      type: 'object',
      properties: {
        lines: { type: 'array', items: { type: 'string' } },
        anchor: { type: 'string', enum: ['below_content', 'below_selection', 'right_of_selection', 'at_xy'] },
        x: { type: 'number' },
        y: { type: 'number' },
        size_scale: { type: 'number', description: "Optional. The text is automatically sized to match the user's handwriting there; use e.g. 1.3 for larger or 0.8 for smaller only if the user asks." },
      },
      required: ['lines'],
    },
  },
  {
    name: 'resize_board_block',
    description: "Make one of your blocks on the board (or an image) bigger or smaller, e.g. when the user says \"make that bigger\". id from your_board_blocks; scale e.g. 1.25 or 0.8.",
    input_schema: { type: 'object', properties: { id: { type: 'string' }, scale: { type: 'number' } }, required: ['id', 'scale'] },
  },
  {
    name: 'view_page',
    description: 'See another page of this session (1-based page number, see board_context.other_pages): returns its image plus its notes and your blocks. By default the user stays on their page; coordinates in that image are only for reading. go:true also turns the board to that page (only when the user asks to go there); then the returned image becomes the current page image for annotate / write_on_canvas.',
    input_schema: { type: 'object', properties: { page: { type: 'integer' }, go: { type: 'boolean' } }, required: ['page'] },
  },
  {
    name: 'set_page_paper',
    description: 'Change the paper of the page the user is on: plain, dots, ruled (notebook lines) or grid (squared). For all new pages use update_settings with paper instead.',
    input_schema: { type: 'object', properties: { style: { type: 'string', enum: ['plain', 'dots', 'ruled', 'grid'] } }, required: ['style'] },
  },
  {
    name: 'export_session',
    description: 'Export the open session when the user asks: "pdf" = the pages as written (free); "latex" = you type every page up as a LaTeX document (costs about as much as a long answer per page; the user confirms first). The user gets buttons in the panel to save the file or open the LaTeX in Overleaf.',
    input_schema: { type: 'object', properties: { format: { type: 'string', enum: ['pdf', 'latex'] } }, required: ['format'] },
  },
  {
    name: 'annotate',
    description: 'Put a small margin mark on the board; the note shows when the user taps it. kind: ok | warn | error | note. x,y in pixels of the latest page image, just beside the line it refers to.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, kind: { type: 'string', enum: ['ok', 'warn', 'error', 'note'] }, note: { type: 'string' } },
      required: ['x', 'y', 'kind', 'note'],
    },
  },
  {
    name: 'clear_marks',
    description: 'Remove all margin marks from the current page.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_region',
    description: 'Get a sharper image of part of the page. x, y, w, h in pixels of the latest page image.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
      required: ['x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'speak',
    description: 'Say something aloud to the user. Natural spoken language only: no LaTeX, math said in words, 1-3 sentences.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'notebook_update',
    description:
      'Update your notes (memory) about the equations on this page. entries: [{key, latex, description, x, y}] with x,y in image pixels; an existing key is overwritten. remove: keys to delete.',
    input_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: { key: { type: 'string' }, latex: { type: 'string' }, description: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
            required: ['key', 'latex'],
          },
        },
        remove: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'update_settings',
    description:
      `Change app settings immediately. Allowed keys: ${AI_EDITABLE.join(', ')}. ` +
      'attention: live|quiet|demand. panelPosition: right|left|bottom|float|hidden. customInstructions: array of standing instructions for you. ' +
      'Only use when the user asked for the change or agreed to your suggestion.',
    input_schema: { type: 'object', properties: { patch: { type: 'object' }, reason: { type: 'string' } }, required: ['patch'] },
  },
  {
    name: 'save_action',
    description: 'Save a reusable one-tap action button in the panel (e.g. for a request the user makes often).',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' } }, required: ['name', 'prompt'] },
  },
  {
    name: 'search_library',
    description: "Search the user's PDFs: the shared library plus this session's own materials (books, notes, papers). Returns book id, its scope, PDF page index and a snippet.",
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'show_page',
    description: "Show a page of one of the user's PDFs in the panel and see it yourself. page = PDF page index (1-based), which can differ from the printed page number.",
    input_schema: { type: 'object', properties: { book: { type: 'string' }, page: { type: 'number' } }, required: ['book', 'page'] },
  },
  {
    name: 'list_sessions',
    description: "List the user's other work sessions: id, title, subject, last edited, short summary.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_session',
    description: "Read another session to bring its results here: its summary, your LaTeX notes of its equations, recent chat, and an image of its page. Then use write_on_canvas or answer.",
    input_schema: { type: 'object', properties: { session: { type: 'string', description: 'session id, or (part of) its title' } }, required: ['session'] },
  },
  {
    name: 'log_friction',
    description: 'Record something that went wrong or that you could not do, so it can be fixed in a future app improvement.',
    input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'propose_code_change',
    description:
      "Start the coding agent to change the app's own code (new features, fixes, UI changes). It works in the background and opens a pull request that the user must approve. Write a clear, specific request.",
    input_schema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
  },
  {
    name: 'ship_change',
    description: 'Show the user a confirm button to merge the latest prepared code change. Only when the user explicitly asks to ship/merge it.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'roll_back',
    description: 'Show the user a confirm button to roll the app back to before the last shipped change. Only when the user explicitly asks.',
    input_schema: { type: 'object', properties: {} },
  },
];

const ok = (id, content) => ({ type: 'tool_result', tool_use_id: id, content });
const fail = (id, msg) => ({ type: 'tool_result', tool_use_id: id, content: msg, is_error: true });

export async function runTool(use, ctx) {
  const { board, panel, voice, agent, changes } = ctx;
  const inp = use.input || {};
  const snap = agent.lastSnap;
  try {
    switch (use.name) {
      case 'hand_off': {
        const order = { fast: 0, main: 1, deep: 2 };
        if (agent.tier === 'deep') return ok(use.id, 'You are already the strongest model. Answer the question.');
        let lvl = inp.level === 'deep' ? 'deep' : 'main';
        if (order[lvl] <= order[agent.tier]) lvl = 'deep';
        agent.tier = lvl;
        return ok(use.id, `Handed off. You are now the stronger model (${settings.models[lvl]}); continue from here and answer the user's question fully.`);
      }

      case 'cas': {
        panel.status('Computing with SymPy…');
        const r = await runSympy(inp.code || '');
        return ok(use.id, JSON.stringify(r));
      }

      case 'write_on_canvas': {
        if (!settings.allowBoardWrite) return fail(use.id, 'Writing on the board is turned off in settings. Put the content in your text reply instead.');
        const lines = (inp.lines || []).map(String).filter((l) => l.trim());
        if (!lines.length) return fail(use.id, 'No lines given.');
        const sel = agent.turnSelection || board.selection;
        const cb = board.contentBounds();
        const vis = board.visibleWorld();
        let pos;
        const anchor = inp.anchor || (Number.isFinite(inp.x) && Number.isFinite(inp.y) ? 'at_xy' : 'below_content');
        // Size: matched to the handwriting it continues (selection → nearby lines → recent writing).
        const sizeRef = anchor === 'at_xy' && snap && Number.isFinite(inp.x) ? board.imageToWorld(snap, inp.x, inp.y) : sel ? { x: sel.x, y: sel.y + sel.h } : cb ? { x: cb.x, y: cb.y + cb.h } : null;
        const fontPx = board.aiFontSize(sizeRef, sel, inp.size_scale);
        const gap = fontPx * 1.1;
        if (anchor === 'at_xy' && snap && Number.isFinite(inp.x) && Number.isFinite(inp.y)) pos = board.imageToWorld(snap, inp.x, inp.y);
        else if (anchor === 'below_selection' && sel) pos = { x: sel.x, y: sel.y + sel.h + gap };
        else if (anchor === 'right_of_selection' && sel) pos = { x: sel.x + sel.w + gap * 1.5, y: sel.y };
        else pos = cb ? { x: cb.x + 10, y: cb.y + cb.h + gap } : { x: vis.x + 60, y: vis.y + 60 };
        // Check the LaTeX first: a broken line is reported back for fixing instead of being written.
        const bad = await texErrors(lines);
        if (bad.length) {
          return fail(use.id, `Nothing was written: ${bad.length} line(s) have LaTeX errors. ${bad.map((b) => `"${b.line}" → ${b.error}`).join('; ')}. Fix the LaTeX (standard MathJax commands only; math inside $...$ or a whole line in $$...$$) and call write_on_canvas again.`);
        }
        board.setLocked(true);
        let moved = null;
        try {
          const blk = await board.addBlock({ lines, x: pos.x, y: pos.y, fontPx }, { animateMs: settings.writeAnimationMs, signal: agent.abort?.signal });
          moved = await board.keepOnPage(blk); // notebook: stay on the page, or continue on the next one
        } finally {
          board.setLocked(false);
        }
        if (moved) return ok(use.id, `It did not fit on this page, so it was written at the top of page ${moved.page + 1} (now shown).`);
        if (settings.narration && settings.voiceOut && !agent.spokeThisTurn) voice.speak('Done, it is on the board.');
        const at = snap ? board.worldToImage(snap, pos.x, pos.y) : null;
        return ok(use.id, `Wrote ${lines.length} line(s) on the board${at ? ` at about (${at.x}, ${at.y}) in image pixels` : ''}.`);
      }

      case 'resize_board_block': {
        const b = await board.scaleBlock(inp.id, Number(inp.scale));
        return b ? ok(use.id, `Resized to ${Math.round((Number(inp.scale) || 1) * 100)}%.`) : fail(use.id, 'No block with that id on this page.');
      }

      case 'view_page': {
        const i = Math.round(Number(inp.page)) - 1;
        if (!(i >= 0 && i < board.pages.length)) return fail(use.id, `There is no page ${inp.page}; this session has ${board.pages.length} page(s).`);
        const max = settings.imageMaxPx || 1100;
        let shot, page;
        if (inp.go) {
          board.goto(i);
          await new Promise((r) => setTimeout(r, 50));
          ({ snap: shot, page } = await board.pageSnapshot(i, { maxDim: max, maxScale: 1.5 }));
          agent.lastSnap = shot; // tools now work on this page
        } else ({ snap: shot, page } = await board.pageSnapshot(i, { maxDim: max, maxScale: 1.5 }));
        const blank = !page.strokes.length && !page.blocks.length;
        const info = {
          page: i + 1,
          name: page.name,
          now_shown: !!inp.go || i === board.pi,
          notes: (page.notebook || []).map((e) => ({ latex: e.latex, description: e.description })),
          your_blocks: page.blocks.filter((x) => x.kind !== 'image').map((x) => x.lines),
        };
        const note = inp.go ? 'The board now shows this page; x,y in this image are valid for annotate and write_on_canvas.' : 'For reading only: the user is still on their own page, so do not use x,y from this image with annotate or write_on_canvas.';
        return ok(use.id, [...(blank ? [] : [imageBlock(shot)]), { type: 'text', text: `${blank ? 'This page is empty. ' : ''}${note}\n${JSON.stringify(info)}` }]);
      }

      case 'set_page_paper':
        board.setPaper(inp.style);
        return ok(use.id, `This page now uses ${inp.style} paper.`);

      case 'export_session': {
        if (!ctx.exporter) return fail(use.id, 'Export is not available.');
        const r = inp.format === 'latex' ? await ctx.exporter.latex() : await ctx.exporter.pdf();
        return r?.ok ? ok(use.id, `Exported ${r.pages} page(s); the user now has a button in the panel to save it.`) : fail(use.id, `Export did not finish: ${r?.error || 'unknown'}.`);
      }

      case 'annotate': {
        if (!snap) return fail(use.id, 'No page image yet.');
        const w = board.imageToWorld(snap, inp.x, inp.y);
        board.addMark({ x: w.x, y: w.y, kind: inp.kind || 'note', note: inp.note || '' });
        return ok(use.id, 'Mark added.');
      }

      case 'clear_marks':
        board.replaceMarks('chat', []);
        board.replaceMarks('watch', []);
        return ok(use.id, 'Marks cleared.');

      case 'get_region': {
        if (!snap) return fail(use.id, 'No page image yet.');
        const a = board.imageToWorld(snap, inp.x, inp.y);
        const region = { x: a.x, y: a.y, w: inp.w / snap.scale, h: inp.h / snap.scale };
        const crop = board.snapshot({ region, maxDim: settings.imageMaxPx || 1100, maxScale: 4, pad: 0 });
        return ok(use.id, [imageBlock(crop), { type: 'text', text: 'Sharper view of the requested region.' }]);
      }

      case 'speak':
        if (!settings.voiceOut) return ok(use.id, 'Voice output is off; the user will read your text reply.');
        agent.spokeThisTurn = true;
        voice.speak(inp.text || '');
        return ok(use.id, 'Spoken.');

      case 'notebook_update': {
        const nb = board.page.notebook;
        for (const k of inp.remove || []) {
          const i = nb.findIndex((e) => e.key === k);
          if (i >= 0) nb.splice(i, 1);
        }
        for (const e of inp.entries || []) {
          const w = snap && Number.isFinite(e.x) && Number.isFinite(e.y) ? board.imageToWorld(snap, e.x, e.y) : {};
          const entry = { key: e.key, latex: e.latex, description: e.description || '', x: w.x, y: w.y };
          const i = nb.findIndex((x) => x.key === e.key);
          if (i >= 0) nb[i] = entry; else nb.push(entry);
        }
        board.saveSoon();
        return ok(use.id, `Notebook now has ${nb.length} entries.`);
      }

      case 'update_settings': {
        const r = aiUpdateSettings(inp.patch);
        const keys = Object.keys(r.applied);
        if (keys.length) panel.add('info', `Settings changed: ${keys.map((k) => `**${k}** → \`${JSON.stringify(r.applied[k])}\``).join(', ')}${inp.reason ? ` — ${inp.reason}` : ''}`);
        return ok(use.id, JSON.stringify(r));
      }

      case 'save_action':
        settings.savedActions = [...settings.savedActions.filter((a) => a.name !== inp.name), { name: inp.name, prompt: inp.prompt }];
        saveSettings();
        panel.add('info', `Saved a new action button: **${inp.name}**`);
        return ok(use.id, 'Saved.');

      case 'search_library': {
        const sid = ctx.sessions?.currentId || null;
        const books = await listBooks(sid);
        if (!books.length) return ok(use.id, "No PDFs yet. The user can add shared ones in Settings → Library, or ones for this session with the 📎 button in the panel.");
        const hits = await searchLibrary(inp.query || '', 6, sid);
        return ok(use.id, JSON.stringify({ books: books.map((b) => ({ id: b.id, scope: b.inSession ? 'this session' : 'shared library' })), hits }));
      }

      case 'show_page': {
        const r = await renderPage(inp.book, inp.page, 1.35, ctx.sessions?.currentId || null);
        panel.addImage(r.dataUrl, `${r.book} — PDF page ${r.page}`, [
          { label: 'Pin to board', run: () => board.pinImage(r.dataUrl, r.w, r.h) },
        ]);
        const forClaude = r.dataUrl.split(',')[1];
        return ok(use.id, [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: forClaude } },
          { type: 'text', text: `Shown to the user: ${r.book}, PDF page ${r.page}.` },
        ]);
      }

      case 'list_sessions':
        return ok(use.id, JSON.stringify(await ctx.sessions.listForClaude()));

      case 'read_session': {
        const r = await ctx.sessions.readForClaude(inp.session || '');
        if (!r) return fail(use.id, 'No session matches that. Call list_sessions to see them.');
        const out = [{ type: 'text', text: JSON.stringify(r.info) }];
        if (r.snap) out.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.snap } });
        return ok(use.id, out);
      }

      case 'log_friction':
        changes.logFriction(inp.note || '');
        return ok(use.id, 'Logged.');

      case 'propose_code_change':
        changes.startCodeChange(inp.request || '');
        return ok(use.id, 'The coding agent has started in the background. A pull request card will appear in the panel when it is ready.');

      case 'ship_change':
        return ok(use.id, changes.requestShip());

      case 'roll_back':
        return ok(use.id, changes.requestRollback());

      default:
        emit('unknown-tool', use.name);
        return fail(use.id, `Unknown tool ${use.name}`);
    }
  } catch (e) {
    return fail(use.id, 'Error: ' + (e?.message || String(e)));
  }
}
