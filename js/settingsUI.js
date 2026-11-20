// Settings dialog, generated from a field list so new settings are one line to add.
import { settings, saveSettings, getPath, setPath } from './settings.js';
import { addPdf, listBooks, removeBook } from './library.js';
import { escapeHtml } from './bus.js';
import { VERSION } from './version.js';
import { cachedModels, listModels, KNOWN_MODELS } from './claude.js';
import { priceOf, meter, fmt } from './costs.js';

const SECTIONS = [
  ['Claude', [
    { k: 'apiKey', label: 'Anthropic API key', type: 'password', hint: 'Stored only in this browser.' },
    { k: 'routing', label: 'Which model answers', type: 'select', options: [['auto', 'Auto — fast model, hands harder questions to a stronger one (cheapest)'], ['main', 'Always the strong model'], ['deep', 'Always the deepest model (most expensive)']] },
    { k: 'webSearch', label: 'Allow web search in answers (papers, arXiv, current values; about ₹1 per search plus reading the results)', type: 'checkbox' },
    { k: 'webSearchMax', label: 'Most web searches in one answer (0 = no limit)', type: 'number', step: 1 },
    { k: 'models.fast', label: 'Fast model (default answers, watching)', type: 'model' },
    { k: 'models.main', label: 'Strong model (hand-offs, error checks)', type: 'model' },
    { k: 'models.deep', label: 'Deepest model (hardest problems, app changes)', type: 'model', hint: 'Prices are US dollars per million tokens, input / output.' },
  ]],
  ['Attention', [
    { k: 'attention', label: 'Mode', type: 'select', options: [['live', 'Live — watch and comment'], ['quiet', 'Quiet live — keep notes, speak only when asked'], ['demand', 'On demand — look only when asked (cheapest)']] },
    { k: 'watchIdleSec', label: 'Live: look after you pause for (seconds)', type: 'number' },
    { k: 'quietIdleSec', label: 'Quiet live: look after you pause for (seconds)', type: 'number' },
    { k: 'watchMaxWaitSec', label: 'While writing non-stop, look at least every (seconds)', type: 'number' },
    { k: 'escalate', label: 'Double-check suspected errors with the strong model', type: 'checkbox' },
    { k: 'quietLowEffort', label: 'Quiet live: use low reasoning effort for looks (cheaper; check that Claude\'s notes and board requests stay accurate on your handwriting)', type: 'checkbox' },
    { k: 'boardRequests', label: 'Do what I write to Claude on the board (Live and Quiet live; e.g. "Write down the Lagrangian of the Standard Model")', type: 'checkbox' },
    { k: 'liveSpeak', label: 'Speak live comments aloud', type: 'checkbox' },
    { k: 'showMarks', label: 'Show margin marks', type: 'checkbox' },
  ]],
  ['Voice', [
    { k: 'voiceSend', label: 'Sending what you say', type: 'select', options: [['auto', 'Automatically, after I stop speaking'], ['manual', 'When I tap ↑ in the speech bar']] },
    { k: 'voiceSendDelaySec', label: 'Automatic sending: seconds of silence before it sends (e.g. 1.5; longer gives you time to think)', type: 'number', step: 0.5 },
    { k: 'wakeWord', label: 'Wake word (empty = everything you say is sent)' },
    { k: 'headphones', label: 'Wearing headphones: talking while Claude speaks interrupts it (leave off when using the iPad speaker, or the mic hears Claude and cuts it off)', type: 'checkbox' },
    { k: 'voiceOut', label: 'Spoken replies', type: 'checkbox' },
    { k: 'narration', label: 'Narrate actions ("done, it is on the board")', type: 'checkbox' },
    { k: 'voiceName', label: 'Voice', type: 'voice' },
    { k: 'voiceDebug', label: 'Show voice diagnostics (what Safari hears, step by step) — for troubleshooting', type: 'checkbox' },
    { k: 'speechRate', label: 'Speech rate', type: 'number', step: 0.05 },
  ]],
  ['Board', [
    { k: 'allowBoardWrite', label: 'Claude may write on the board', type: 'checkbox' },
    { k: 'aiMatchSize', label: "Size Claude's writing to match my handwriting where it writes", type: 'checkbox' },
    { k: 'aiSizeScale', label: "Claude's writing size relative to mine (1 = same, 0.9 = a bit smaller, 1.2 = larger)", type: 'number', step: 0.05 },
    { k: 'writeAnimationMs', label: 'Delay between written lines (ms)', type: 'number' },
    { k: 'aiColor', label: 'Claude colour', type: 'color' },
    { k: 'penWidth', label: 'Pen width', type: 'number', step: 0.2 },
    { k: 'inkSmoothing', label: 'Ink smoothing (0 = raw, 0.3 = default, up to 0.8 = very smooth)', type: 'number', step: 0.05 },
    { k: 'inkPrediction', label: 'Draw slightly ahead of the Pencil tip to reduce lag', type: 'checkbox' },
    { k: 'paper', label: 'Paper for new pages (and pages that haven\'t picked their own)', type: 'select', options: [['plain', 'Plain'], ['dots', 'Dots'], ['ruled', 'Ruled (notebook)'], ['grid', 'Grid (squared)']] },
    { k: 'paperSpacing', label: 'Line / dot spacing on the paper', type: 'number', step: 2 },
    { k: 'fingerDraws', label: 'Finger draws when no Pencil is used', type: 'checkbox' },
    { k: 'panelPosition', label: 'Panel position', type: 'select', options: [['right', 'Right'], ['left', 'Left'], ['bottom', 'Bottom'], ['float', 'Floating'], ['hidden', 'Hidden']] },
  ]],
  ['Cost', [
    { k: 'dailyBudgetUSD', label: 'Daily budget in US dollars (0 = no limit). When reached, watching pauses; answers still work.', type: 'number', step: 0.1 },
    { k: 'currencySymbol', label: 'Show costs in (symbol)' },
    { k: 'currencyRate', label: 'Exchange rate: your currency per US dollar (0 = show dollars)', type: 'number', step: 0.5 },
    { k: 'imageMaxPx', label: 'Page image size sent to Claude (px, longest side; smaller = cheaper)', type: 'number' },
    { k: 'maxHistory', label: 'Past questions kept in the conversation', type: 'number' },
    { k: 'idleResetMin', label: 'Start a fresh conversation after this many idle minutes', type: 'number' },
    { k: 'longCache', label: 'Keep cached context for 1 hour (cheaper if you ask questions more than 5 minutes apart)', type: 'checkbox' },
  ]],
  ['Standing instructions', [
    { k: 'customInstructions', label: 'One per line — Claude follows these in every answer', type: 'lines' },
  ]],
  ['Self-update (GitHub)', [
    { k: 'github.token', label: 'Fine-grained token (contents + pull requests: read/write, this repo only)', type: 'password' },
    { k: 'github.owner', label: 'Repo owner' },
    { k: 'github.repo', label: 'Repo name' },
    { k: 'github.branch', label: 'Live branch' },
    { k: 'github.previewUrlTemplate', label: 'Preview URL template (optional, e.g. https://deploy-preview-{pr}--yoursite.netlify.app)' },
  ]],
  ['Backup to GitHub', [
    { k: 'backupRepo', label: 'Private repository for backups (name, or owner/name). Make a new PRIVATE repo on GitHub, e.g. live-board-backups, and give the token below "Contents: read and write" on it', },
    { k: 'backupAuto', label: 'Back up automatically when something changes (at most every 10 minutes)', type: 'checkbox' },
  ]],
  ['Advanced', [
    { k: 'pyodideUrl', label: 'Pyodide URL (SymPy runtime)' },
  ]],
];

function fieldHtml(f) {
  const id = 'set-' + f.k.replace(/\./g, '-');
  const v = getPath(settings, f.k);
  const hint = f.hint ? `<small>${escapeHtml(f.hint)}</small>` : '';
  if (f.type === 'checkbox') return `<label class="row check"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> <span>${escapeHtml(f.label)}</span></label>`;
  if (f.type === 'select') return `<label class="row"><span>${escapeHtml(f.label)}</span><select id="${id}">${f.options.map(([val, lab]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${escapeHtml(lab)}</option>`).join('')}</select></label>`;
  if (f.type === 'model') return `<label class="row"><span>${escapeHtml(f.label)}</span><select id="${id}" data-model>${modelOptions(cachedModels(), v)}</select>${hint}</label>`;
  if (f.type === 'voice') return `<label class="row"><span>${escapeHtml(f.label)}</span><select id="${id}"></select></label>`;
  if (f.type === 'lines') return `<label class="row"><span>${escapeHtml(f.label)}</span><textarea id="${id}" rows="4">${escapeHtml((v || []).join('\n'))}</textarea></label>`;
  const type = f.type || 'text';
  return `<label class="row"><span>${escapeHtml(f.label)}</span><input id="${id}" type="${type}" ${f.step ? `step="${f.step}"` : ''} value="${escapeHtml(v ?? '')}" autocomplete="off" autocapitalize="off" spellcheck="false">${hint}</label>`;
}

function modelOptions(list, current) {
  const all = list.some((m) => m.id === current) || !current ? list : [{ id: current, name: current + ' (not in the list)' }, ...list];
  return all.map((m) => {
    // prices only for the current models the cost meter knows exactly
    const p = KNOWN_MODELS.some((k) => k.id === m.id) ? priceOf(m.id) : null;
    return `<option value="${escapeHtml(m.id)}" ${m.id === current ? 'selected' : ''}>${escapeHtml(m.name)}${p ? ` · $${p.in} / $${p.out}` : ''}</option>`;
  }).join('');
}

function readField(f) {
  const el = document.getElementById('set-' + f.k.replace(/\./g, '-'));
  if (!el) return;
  let v;
  if (f.type === 'checkbox') v = el.checked;
  else if (f.type === 'number') v = parseFloat(el.value) || 0;
  else if (f.type === 'lines') v = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else v = el.value.trim();
  setPath(settings, f.k, v);
}

export class SettingsUI {
  constructor({ voice, changes, panel }) {
    this.dlg = document.getElementById('settingsDlg');
    this.voice = voice;
    this.changes = changes;
    this.panel = panel;
  }

  async open(welcome = false) {
    const intro = welcome
      ? `<p class="welcome"><b>Welcome.</b> Paste your Anthropic API key to start. Everything else works with defaults and can be changed later — or just ask Claude to change it.</p>`
      : '';
    this.dlg.innerHTML = `
      <form method="dialog" class="settings">
        <header><h2>Settings <small class="muted" style="font-weight:400">version ${VERSION}</small></h2><button value="cancel" class="ghost" aria-label="Close">✕</button></header>
        <div class="scroll">
          ${intro}
          ${SECTIONS.map(([title, fields]) => `<fieldset><legend>${escapeHtml(title)}</legend>${fields.map(fieldHtml).join('')}</fieldset>`).join('')}
          <fieldset><legend>Voice troubleshooting</legend>
            <div class="muted">If listening stops working: reproduce it, then copy the voice log and paste it to Claude in your chat. It records what Safari's speech recognition did, step by step (no audio).</div>
            <div class="buttons"><button type="button" id="testVoice">Test voice</button><button type="button" id="copyVoiceLog">Copy voice log</button><button type="button" id="clearVoiceLog" class="ghost">Clear log</button></div>
            <div id="voiceLogMsg" class="muted small"></div>
          </fieldset>
          <fieldset><legend>GitHub backup</legend>
            <div id="backupStatus" class="muted small"></div>
            <div class="buttons"><button type="button" id="backupNow">Back up now</button><button type="button" id="backupRestore" class="ghost">Restore from GitHub</button></div>
          </fieldset>
          <fieldset id="sessionLayoutBox" hidden><legend>This session (notebook)</legend>
            <label class="row"><span>Page size</span><select id="slSize"><option value="A4">A4</option><option value="A5">A5</option><option value="Letter">US Letter</option><option value="Square">Square</option></select></label>
            <label class="row"><span>Orientation</span><select id="slOrient"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
            <label class="row"><span>Pages scroll</span><select id="slScroll"><option value="vertical">Vertically (up / down)</option><option value="horizontal">Horizontally (left / right)</option></select></label>
            <label class="row"><span>Paper for new pages</span><select id="slPaper"><option value="ruled">Ruled</option><option value="grid">Grid (squared)</option><option value="dots">Dots</option><option value="plain">Plain</option></select></label>
            <div class="muted small">Changes apply right away. A smaller page can hide writing near the edges (it is kept, just outside the page).</div>
          </fieldset>
          <fieldset><legend>This page</legend>
            <label class="row"><span>Paper for the page you are on</span><select id="pagePaper"><option value="plain">Plain</option><option value="dots">Dots</option><option value="ruled">Ruled (notebook)</option><option value="grid">Grid (squared)</option></select></label>
            <div class="muted small">Changes this page right away. New pages use the "Paper for new pages" setting under Board.</div>
          </fieldset>
          <fieldset><legend>Where the money goes</legend>
            <div id="costBreakdown" class="small"></div>
            <div class="muted small">Estimated from token counts at list prices; the Claude Console usage page is the exact record. "This month" by purpose counts from this update on.</div>
          </fieldset>
          <fieldset><legend>Watching log</legend>
            <div class="muted">What Live / Quiet live did: when it looked at your writing, and what came back (notes, marks, comments, board requests) or why it didn't look.</div>
            <div class="buttons"><button type="button" id="copyWatchLog">Copy watching log</button><button type="button" id="clearWatchLog" class="ghost">Clear log</button></div>
            <div id="watchLogMsg" class="muted small"></div>
          </fieldset>
          <fieldset><legend>Saved action buttons</legend><div id="savedList"></div></fieldset>
          <fieldset><legend>Shared library (PDFs every session can use)</legend><div class="muted">PDFs for just one session go in that session's 📎 materials, in the Claude panel.</div>
            <div id="bookList" class="list"></div>
            <label class="row"><span>Add PDFs</span><input type="file" id="pdfInput" accept="application/pdf" multiple></label>
            <div id="pdfProgress" class="muted"></div>
          </fieldset>
          <fieldset><legend>Change the app</legend>
            <label class="row"><span>Describe a change and the coding agent will open a pull request for you to approve</span><textarea id="changeReq" rows="3" placeholder="e.g. Add a button that exports the current page as a PNG"></textarea></label>
            <div class="buttons"><button type="button" id="changeGo">Start change</button><button type="button" id="improveGo">Improve from friction log (<span id="fricCount">0</span>)</button><button type="button" id="rollbackGo" class="ghost">Roll back last shipped change</button></div>
            <div id="fricList" class="muted small"></div>
          </fieldset>
        </div>
        <footer><button value="cancel" class="ghost">Cancel</button><button id="saveSettings" value="save">Save</button></footer>
      </form>`;
    this.fillVoices();
    this.fillModels();
    this.renderCosts();
    window.liveBackup?.status().then((t) => { const el = document.getElementById('backupStatus'); if (el) el.textContent = t; });
    const lay = window.liveSessions?.meta?.layout;
    const box = document.getElementById('sessionLayoutBox');
    if (box) {
      box.hidden = !lay;
      if (lay) { document.getElementById('slSize').value = lay.size; document.getElementById('slOrient').value = lay.orient; document.getElementById('slScroll').value = lay.scroll; document.getElementById('slPaper').value = lay.paper || 'ruled'; }
    }
    const pp = document.getElementById('pagePaper');
    if (pp && window.liveBoard) pp.value = window.liveBoard.paperOf();
    document.getElementById('set-apiKey')?.addEventListener('change', () => this.fillModels());
    this.renderSaved();
    this.renderBooks();
    this.renderFriction();
    this.bind();
    this.dlg.showModal();
  }

  renderCosts() {
    const el = document.getElementById('costBreakdown');
    if (!el) return;
    const s = meter.stats();
    const NAMES = { answer: 'Your questions', watch: 'Live / Quiet live looks', verify: 'Double-checks of suspected errors (strong model)', title: 'Session titles and summaries', find: 'Session search', search: 'Web searches (fee per search)', code: 'App changes' };
    const rows = (by, total) => {
      const list = Object.entries(by || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      if (!list.length) return '<div class="muted">Nothing yet.</div>';
      return list.map(([k, v]) => `<div class="row"><span>${escapeHtml(NAMES[k] || k)}</span><span>${fmt(v)} · ${Math.round((100 * v) / (total || 1))}%</span></div>`).join('');
    };
    el.innerHTML = `<b>Today: ${fmt(s.today)}</b>${rows(s.byPurpose, s.today)}<br><b>This month: ${fmt(s.month)}</b>${rows(s.monthByPurpose, s.month)}<br><span class="muted">Since the app was opened: ${fmt(s.session)}</span>`;
  }

  // Replace the built-in model list with the live one from your account (keeps your choices).
  async fillModels() {
    const key = document.getElementById('set-apiKey')?.value.trim() || settings.apiKey;
    if (!key) return;
    try {
      const list = await listModels(key);
      for (const sel of this.dlg.querySelectorAll('select[data-model]')) sel.innerHTML = modelOptions(list, sel.value);
    } catch { /* offline or key not valid yet: the built-in list stays */ }
  }

  fillVoices() {
    const sel = document.getElementById('set-voiceName');
    if (!sel) return;
    const voices = this.voice.voices();
    sel.innerHTML = `<option value="">System default</option>` + voices.map((v) => `<option value="${escapeHtml(v.name)}" ${v.name === settings.voiceName ? 'selected' : ''}>${escapeHtml(v.name)} (${v.lang})</option>`).join('');
    if (!voices.length && 'speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => this.fillVoices();
  }

  renderSaved() {
    const el = document.getElementById('savedList');
    el.innerHTML = (settings.savedActions || []).map((a, i) => `<div class="item"><span><b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.prompt)}</span><button type="button" class="ghost" data-del-action="${i}">Remove</button></div>`).join('') || '<div class="muted">None yet. Ask Claude to save one.</div>';
  }

  async renderBooks() {
    const el = document.getElementById('bookList');
    const books = await listBooks(null, { only: 'global' });
    el.innerHTML = books.map((b) => `<div class="item"><span>${escapeHtml(b.name)} · ${b.pages} pages</span><button type="button" class="ghost" data-del-book="${escapeHtml(b.id)}">Remove</button></div>`).join('') || '<div class="muted">No PDFs yet.</div>';
  }

  renderFriction() {
    const list = this.changes.friction;
    document.getElementById('fricCount').textContent = list.length;
    document.getElementById('fricList').innerHTML = list.slice(-8).map((f) => `• ${escapeHtml(f.note)}`).join('<br>');
  }

  bind() {
    const d = this.dlg;
    d.querySelector('#saveSettings').addEventListener('click', (e) => {
      e.preventDefault();
      for (const [, fields] of SECTIONS) for (const f of fields) readField(f);
      saveSettings();
      d.close();
    });
    d.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-del-action]');
      if (a) {
        settings.savedActions.splice(+a.dataset.delAction, 1);
        saveSettings();
        this.renderSaved();
      }
      const b = e.target.closest('[data-del-book]');
      if (b && confirm('Remove this PDF from the shared library? Sessions that added it themselves keep it.')) {
        await removeBook(b.dataset.delBook);
        this.renderBooks();
      }
    });
    d.querySelector('#testVoice').addEventListener('click', () => {
      this.voice.testVoice();
      document.getElementById('voiceLogMsg').textContent = 'Speaking a test sentence… If you hear nothing, check the iPad volume and Silent mode, then copy the voice log.';
    });
    d.querySelector('#copyVoiceLog').addEventListener('click', async () => {
      const text = this.voice.report();
      const msg = d.querySelector('#voiceLogMsg');
      try { await navigator.clipboard.writeText(text); msg.textContent = `Copied (${(this.voice.events || []).length} events). Paste it into your chat with Claude.`; }
      catch {
        // clipboard blocked: show it so it can be selected and copied by hand
        msg.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.value = text; ta.rows = 8; ta.style.width = '100%';
        msg.append('Copying was blocked. Select all of this and copy it:', ta);
        ta.focus(); ta.select();
      }
    });
    d.querySelector('#backupNow').addEventListener('click', async () => {
      const bk = window.liveBackup;
      const st = d.querySelector('#backupStatus');
      st.textContent = 'Backing up…';
      const r = await bk.run();
      st.textContent = r.ok ? await bk.status() : 'Failed: ' + r.error;
    });
    d.querySelector('#backupRestore').addEventListener('click', async () => {
      if (!confirm('Download your GitHub backup and merge it in? Sessions that are newer on this iPad are kept.')) return;
      this.close?.();
      await window.liveBackup.restore();
    });
    for (const [id, key] of [['#slSize', 'size'], ['#slOrient', 'orient'], ['#slScroll', 'scroll'], ['#slPaper', 'paper']]) {
      d.querySelector(id).addEventListener('change', (e) => window.liveSessions?.setLayout({ [key]: e.target.value }));
    }
    d.querySelector('#pagePaper').addEventListener('change', (e) => window.liveBoard?.setPaper(e.target.value));
    d.querySelector('#copyWatchLog').addEventListener('click', async () => {
      const w = window.liveWatcher;
      const text = w ? w.report() : 'Watching has not started.';
      const msg = d.querySelector('#watchLogMsg');
      try { await navigator.clipboard.writeText(text); msg.textContent = `Copied (${w?.events.length || 0} entries). Paste it into your chat with Claude.`; }
      catch {
        msg.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.value = text; ta.rows = 8; ta.style.width = '100%';
        msg.append('Copying was blocked. Select all of this and copy it:', ta);
        ta.focus(); ta.select();
      }
    });
    d.querySelector('#clearWatchLog').addEventListener('click', () => { if (window.liveWatcher) window.liveWatcher.events = []; d.querySelector('#watchLogMsg').textContent = 'Log cleared.'; });
    d.querySelector('#clearVoiceLog').addEventListener('click', () => { this.voice.clearLog(); d.querySelector('#voiceLogMsg').textContent = 'Log cleared. Now reproduce the problem, then copy the log.'; });
    d.querySelector('#pdfInput').addEventListener('change', async (e) => {
      const prog = d.querySelector('#pdfProgress');
      for (const file of e.target.files) {
        try {
          await addPdf(file, (i, n) => { prog.textContent = `Indexing ${file.name}: page ${i} of ${n}`; });
          prog.textContent = `Added ${file.name}`;
        } catch (err) {
          prog.textContent = `Could not add ${file.name}: ${err.message}`;
        }
      }
      e.target.value = '';
      this.renderBooks();
    });
    d.querySelector('#changeGo').addEventListener('click', () => {
      const req = d.querySelector('#changeReq').value.trim();
      if (!req) return;
      for (const [, fields] of SECTIONS) for (const f of fields) readField(f);
      saveSettings();
      d.close();
      this.changes.startCodeChange(req);
    });
    d.querySelector('#improveGo').addEventListener('click', () => {
      d.close();
      this.changes.improveFromFriction();
    });
    d.querySelector('#rollbackGo').addEventListener('click', () => {
      d.close();
      const msg = this.changes.requestRollback();
      if (!msg.startsWith('Showed')) this.panel.add('info', msg);
    });
  }
}
