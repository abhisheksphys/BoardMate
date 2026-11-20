# Live Board — notes for the coding agent

A personal handwriting whiteboard. Claude watches the page (images), listens (speech-to-text), answers in a panel or by voice, writes typeset math on the board, and can change this app's own code through pull requests the owner approves.

## Constraints
- Static site: plain HTML, CSS, ES modules. No build step, no npm. Hosted on GitHub Pages.
- External libraries only from cdn.jsdelivr.net or cdnjs.cloudflare.com (currently MathJax 3, marked, Pyodide, pdf.js, jsPDF).
- Single user, online only. Data lives in the browser (localStorage for settings; IndexedDB stores `sessions`, `sessionData`, `library`, `kv`). PDFs are shared (`global`) and/or belong to sessions (`sessions: [ids]`).
- Must work well in iPad Safari with Apple Pencil (Pointer Events, pressure; fingers pan/zoom).

## Files
- `index.html`, `styles.css` — layout and look.
- `js/app.js` — wiring: toolbar, mic, events, startup.
- `js/board.js` — canvas: strokes, eraser, select/move, pan/zoom, pages, undo, AI blocks, marks, `snapshot()` for Claude. Two session types: freeform (endless page) and notebook (`board.layout` = { size, orient, scroll, paper }: fixed-size pages shown whole, flipped with a snap, `keepOnPage()` keeps Claude's writing on the page). The type is set when a session is created (`meta.layout`) and never changes; the page setup can.
- `js/sessions.js` — sessions: per-session pages/chat/Claude history/cost, autosave, auto titles + summaries + recaps, drawer (search, subjects, pin, branch, trash), backup/restore, session PDFs (📎).
- `js/images.js` — paste / pick / drop images onto the page (scaled down before saving).
- `js/export.js` — export the open session: PDF of the pages as written (jsPDF from cdnjs, A4 slices) or LaTeX typed up by Claude (save .tex / open in Overleaf).
- `js/backup.js` — automatic incremental backup of sessions, PDFs and settings to a PRIVATE GitHub repo (`backupRepo`), and restore from it. Never writes to the app's own (public) repo; never includes the API key or token.
- `js/inktools.js` — toolbar pen options: thickness slider/presets, colour palette, system colour picker, recent colours.
- `js/mathrender.js` — LaTeX → image (MathJax SVG) for AI blocks.
- `js/agent.js` — main assistant loop and system prompt; sends page image + context with every question.
- `js/tools.js` — tool schemas and handlers Claude can call (cas, write_on_canvas, view_page, annotate, get_region, speak, notebook_update, update_settings, save_action, search_library, show_page, log_friction, propose_code_change, ship_change, roll_back).
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

## Versioning (important)
Browsers cache files aggressively. Every change must bump the version so the new files are fetched:
use one new value (e.g. `2026.11.21-0930`) in **all** of: `js/version.js`, the `?v=` of `js/app.js` and of `styles.css` in `index.html`,
and every entry of the import map in `index.html`. Add an import-map entry for any new module.
