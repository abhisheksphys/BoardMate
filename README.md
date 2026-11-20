# Live Board

A handwriting whiteboard for iPad where Claude watches the page, listens, answers in a side panel or by voice, writes typeset math on the board, and can change this app's own code with your approval.

## Set up (about 10 minutes, once)

1. **Make a GitHub repo** (public is fine; no secrets live in the code). Upload everything in this folder to it, keeping the folder structure.
2. **Turn on GitHub Pages**: repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save. After a minute your app is at `https://<you>.github.io/<repo>/`.
3. **On the iPad**, open that address in Safari → Share → *Add to Home Screen*. Launch it from the home screen for full-screen.
4. **Paste your Anthropic API key** when the app asks (from console.anthropic.com). It is stored only in that browser.
5. **Optional, for self-update**: create a GitHub *fine-grained* token for this repo only, with *Contents: read/write* and *Pull requests: read/write*. Enter it with the owner and repo name under Settings → Self-update.
6. **Optional, preview links**: connect the repo to Netlify (free) so each pull request gets a preview site, and set the preview template, e.g. `https://deploy-preview-{pr}--yoursite.netlify.app`.

## Using it

- **Write** with the Pencil. Fingers pan and pinch-zoom. Tools: pen, eraser, select (draw a box to point at something, or drag Claude's blocks).
- **Ask** any way you like: type, hold the mic, or tap a saved action. Refer to things naturally — "the one that looks like Maxwell's equation", "my last line", "this" with a selection. There are no fixed commands.
- **Attention** (toolbar): *Live* checks new work as you write and puts ✓ ! ✗ marks in the margin (tap a mark to read it); *Quiet live* watches but only speaks when asked; *On demand* looks only when you ask.
- **Claude writes on the board** in blue when you ask it to; the board locks briefly while it writes (Stop button to cancel). Erase, move, or write over its blocks freely; Undo removes them.
- **Exact math** (curl, expand, solve, …) runs in SymPy inside the browser, loaded on first use (about 20 MB, cached afterwards).
- **Library**: add PDFs in Settings → Library, then ask "find the related equation in Jackson" or "show me that page".
- **Change things by asking**: "move the panel to the left", "from now on use SI units", "save a button that checks my signs" — applied instantly.
- **Change the app itself**: "add a button that exports this page as a PNG". The coding agent opens a pull request; you get a card with *Ship it*. After shipping, reload. *Roll back* undoes the last shipped change. Claude also keeps a log of things that went wrong and offers to fix them (it never ships without your tap).

## Sessions

- **Sessions** (top-left button, or tap the session title) lists your work, newest first, with a thumbnail, cost and summary. **+ New** starts a fresh page and a fresh Claude; everything saves automatically.
- When you leave a session, Claude names it and writes a short summary and a **"where you left off"** note that greets you when you return. Rename anytime.
- Organise with **subjects** and **pins**; **search** titles, notes and equations, or tap **Ask Claude to find it** for descriptions like "where I took the curl of B".
- **Branch** a session to try a different approach without touching the original. Deleted sessions stay in **Trash** for 30 days.
- Ask Claude to bring results from another session: "put yesterday's boundary conditions here".
- **📎 in the Claude panel**: PDFs just for this session. PDFs added in Settings are shared by every session.
- **Back up** saves everything (optionally with PDFs) to a file; **Restore…** brings it back on any device or browser. Your API key is never included. The Safari tab and a home-screen copy of the app keep separate data, so use backup and restore to move between them.

## Voice tips

- Safari asks for microphone permission the first time.
- Without headphones, Claude pauses listening while it speaks (so it does not hear itself). With headphones, turn on *Using headphones* and you can interrupt it mid-sentence.
- *Always listening* sends everything you say; set a wake word (e.g. "Claude") if you talk to yourself while working.

## Running costs

You pay Anthropic per use, from prepaid credits. The app is built to keep this low:

- **Fast model first.** Haiku answers by default and hands a question to Sonnet (or Opus) only when it needs real reasoning. Each answer has a *Think harder* button if you want a stronger model to redo it.
- **Prompt caching.** Instructions, tools and the conversation so far are cached, so follow-ups and tool steps are billed at a small fraction.
- **Cheap watching.** The watcher looks only after you pause, at just the changed region plus its notes. Suspected errors are re-checked by Sonnet, not Opus.
- **Smaller images and short history.** Page images are capped at 1100 px. Old turns drop their images, and the conversation resets after 20 idle minutes.
- **Cost meter and budget.** The panel header shows today's spending (tap it for a breakdown), each answer shows its cost, and watching pauses when the daily budget is reached (default $1).

All of these are adjustable in Settings → Claude, Attention and Cost.

## Not in this version (ask the app to add them)

- Second-device panel (needs a small relay server).
- Mathpix handwriting recognition (Claude's vision is used instead).
- Speech-to-speech voice models (uses the browser's speech recognition and voices).

## Run locally

`python3 -m http.server` in this folder, then open `http://localhost:8000`. The microphone only works on `https` or `localhost`, so use GitHub Pages for the iPad.

See `CLAUDE.md` for how the code is organised.
