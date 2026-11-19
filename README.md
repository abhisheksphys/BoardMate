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

## Voice tips

- Safari asks for microphone permission the first time.
- Without headphones, Claude pauses listening while it speaks (so it does not hear itself). With headphones, turn on *Using headphones* and you can interrupt it mid-sentence.
- *Always listening* sends everything you say; set a wake word (e.g. "Claude") if you talk to yourself while working.

## Running costs

You pay Anthropic per use. *Live* mode costs the most because the watcher looks after each pause in your writing; raise *Seconds between looks* or use *Quiet live* / *On demand* to spend less.

## Not in this version (ask the app to add them)

- Second-device panel (needs a small relay server).
- Mathpix handwriting recognition (Claude's vision is used instead).
- Speech-to-speech voice models (uses the browser's speech recognition and voices).

## Run locally

`python3 -m http.server` in this folder, then open `http://localhost:8000`. The microphone only works on `https` or `localhost`, so use GitHub Pages for the iPad.

See `CLAUDE.md` for how the code is organised.
