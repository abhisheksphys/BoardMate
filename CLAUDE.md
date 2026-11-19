# Live Board — notes for the coding agent

A personal handwriting whiteboard. Claude watches the page (images), listens (speech-to-text), answers in a panel or by voice, writes typeset math on the board, and can change this app's own code through pull requests the owner approves.

## Constraints
- Static site: plain HTML, CSS, ES modules. No build step, no npm. Hosted on GitHub Pages.
- External libraries only from cdn.jsdelivr.net or cdnjs.cloudflare.com (currently MathJax 3, marked, Pyodide, pdf.js).
- Single user, online only. Data lives in the browser (localStorage for settings, IndexedDB for pages and PDFs).
- Must work well in iPad Safari with Apple Pencil (Pointer Events, pressure; fingers pan/zoom).

## Files
- `index.html`, `styles.css` — layout and look.
- `js/app.js` — wiring: toolbar, mic, events, startup.
- `js/board.js` — canvas: strokes, eraser, select/move, pan/zoom, pages, undo, AI blocks, marks, `snapshot()` for Claude.
- `js/mathrender.js` — LaTeX → image (MathJax SVG) for AI blocks.
- `js/agent.js` — main assistant loop and system prompt; sends page image + context with every question.
- `js/tools.js` — tool schemas and handlers Claude can call (cas, write_on_canvas, annotate, get_region, speak, notebook_update, update_settings, save_action, search_library, show_page, log_friction, propose_code_change, ship_change, roll_back).
- `js/perception.js` — watcher loop (live / quiet live / on demand).
- `js/cas.js` — SymPy via Pyodide.
- `js/voice.js` — speech in/out, barge-in.
- `js/panel.js` — chat panel, Markdown + LaTeX rendering, docking.
- `js/costs.js` — prices, per-call cost from token usage, daily/monthly totals, budget check.
- `js/claude.js` — API client with prompt-cache breakpoints; every call records its cost.
- `js/settings.js` — all settings + defaults; `AI_EDITABLE` lists what Claude may change at runtime.
- `js/settingsUI.js` — settings dialog generated from a field list.
- `js/library.js` — PDF library (pdf.js), search, page rendering.
- `js/changes.js`, `js/codeagent.js`, `js/github.js` — self-update loop. Keep the approval step intact.

## Cost
Keep cost low: default to the fast model, keep the cached prefix (tools, system prompt, compacted history) stable, send small images, and pass `purpose` to `claude()` so the meter can attribute spending.

## Conventions
- New behaviour should be configurable through `settings.js` where reasonable, with a field in `settingsUI.js`.
- Communicate between modules with the event bus in `js/bus.js` (`emit`/`on`) rather than new globals.
- Keep tool descriptions precise; Claude relies on them.
