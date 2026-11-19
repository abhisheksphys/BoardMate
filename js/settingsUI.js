// Settings dialog, generated from a field list so new settings are one line to add.
import { settings, saveSettings, getPath, setPath } from './settings.js';
import { addPdf, listBooks, removeBook } from './library.js';
import { escapeHtml } from './bus.js';

const SECTIONS = [
  ['Claude', [
    { k: 'apiKey', label: 'Anthropic API key', type: 'password', hint: 'Stored only in this browser.' },
    { k: 'models.main', label: 'Main model (answers)' },
    { k: 'models.watch', label: 'Watcher model (live/quiet)' },
    { k: 'models.deep', label: 'Deep model (checks, code changes)' },
  ]],
  ['Attention', [
    { k: 'attention', label: 'Mode', type: 'select', options: [['live', 'Live — watch and comment'], ['quiet', 'Quiet live — watch, speak only when asked'], ['demand', 'On demand — look only when asked']] },
    { k: 'watchIntervalSec', label: 'Seconds between looks (min)', type: 'number' },
    { k: 'escalate', label: 'Double-check suspected errors with the deep model', type: 'checkbox' },
    { k: 'liveSpeak', label: 'Speak live comments aloud', type: 'checkbox' },
    { k: 'showMarks', label: 'Show margin marks', type: 'checkbox' },
  ]],
  ['Voice', [
    { k: 'voiceIn', label: 'Voice input', type: 'select', options: [['push', 'Hold mic to talk'], ['continuous', 'Always listening (tap mic to start/stop)'], ['off', 'Off']] },
    { k: 'wakeWord', label: 'Wake word (always-listening only; empty = everything you say)' },
    { k: 'headphones', label: 'Using headphones (keep listening while Claude talks; lets you interrupt)', type: 'checkbox' },
    { k: 'voiceOut', label: 'Spoken replies', type: 'checkbox' },
    { k: 'narration', label: 'Narrate actions ("done, it is on the board")', type: 'checkbox' },
    { k: 'voiceName', label: 'Voice', type: 'voice' },
    { k: 'speechRate', label: 'Speech rate', type: 'number', step: 0.05 },
  ]],
  ['Board', [
    { k: 'allowBoardWrite', label: 'Claude may write on the board', type: 'checkbox' },
    { k: 'writeAnimationMs', label: 'Delay between written lines (ms)', type: 'number' },
    { k: 'aiColor', label: 'Claude colour', type: 'color' },
    { k: 'penWidth', label: 'Pen width', type: 'number', step: 0.2 },
    { k: 'fingerDraws', label: 'Finger draws when no Pencil is used', type: 'checkbox' },
    { k: 'panelPosition', label: 'Panel position', type: 'select', options: [['right', 'Right'], ['left', 'Left'], ['bottom', 'Bottom'], ['float', 'Floating'], ['hidden', 'Hidden']] },
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
  if (f.type === 'voice') return `<label class="row"><span>${escapeHtml(f.label)}</span><select id="${id}"></select></label>`;
  if (f.type === 'lines') return `<label class="row"><span>${escapeHtml(f.label)}</span><textarea id="${id}" rows="4">${escapeHtml((v || []).join('\n'))}</textarea></label>`;
  const type = f.type || 'text';
  return `<label class="row"><span>${escapeHtml(f.label)}</span><input id="${id}" type="${type}" ${f.step ? `step="${f.step}"` : ''} value="${escapeHtml(v ?? '')}" autocomplete="off" autocapitalize="off" spellcheck="false">${hint}</label>`;
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
        <header><h2>Settings</h2><button value="cancel" class="ghost" aria-label="Close">✕</button></header>
        <div class="scroll">
          ${intro}
          ${SECTIONS.map(([title, fields]) => `<fieldset><legend>${escapeHtml(title)}</legend>${fields.map(fieldHtml).join('')}</fieldset>`).join('')}
          <fieldset><legend>Saved action buttons</legend><div id="savedList"></div></fieldset>
          <fieldset><legend>Library (your PDFs)</legend>
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
    this.renderSaved();
    this.renderBooks();
    this.renderFriction();
    this.bind();
    this.dlg.showModal();
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
    const books = await listBooks();
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
      if (b && confirm('Remove this PDF from the library?')) {
        await removeBook(b.dataset.delBook);
        this.renderBooks();
      }
    });
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
