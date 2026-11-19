// Wires everything together.
import { on, emit } from './bus.js';
import { settings, setSettings } from './settings.js';
import { idb } from './storage.js';
import { Board } from './board.js';
import { Panel } from './panel.js';
import { voice } from './voice.js';
import { Agent } from './agent.js';
import { Perception } from './perception.js';
import { Changes } from './changes.js';
import { SettingsUI } from './settingsUI.js';
import { warmCas } from './cas.js';
import { meter, fmt, overBudget } from './costs.js';

const $ = (s) => document.querySelector(s);

// ---------- core objects ----------
const board = new Board($('#board'));
let agent;
const panel = new Panel({
  onSend: (text) => askFrom(text, 'typed'),
  onAction: (kind, a) => {
    if (kind === 'saved') askFrom(a.prompt, 'action button', a.name);
    if (kind === 'clear-chat') agent.reset();
  },
});
const changes = new Changes({ panel, voice });
agent = new Agent({ board, panel, voice, changes });
new Perception({ board, panel, voice, agent });
const settingsUI = new SettingsUI({ voice, changes, panel });

function askFrom(text, origin, label) {
  panel.add('user', label ? `▸ ${label}` : text);
  agent.ask(text, { selection: board.selection, origin });
}

// ---------- load saved pages ----------
try {
  board.load((await idb.get('pages', 'all')) || []);
} catch {
  board.load([]);
}
on('save', () => {
  idb.set('pages', 'all', board.pages).catch((e) => panel.status('Could not save: ' + e.message));
});

// ---------- toolbar ----------
document.querySelectorAll('[data-tool]').forEach((btn) =>
  btn.addEventListener('click', () => {
    board.tool = btn.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
    if (board.tool !== 'select' && board.selection) { board.selection = null; board.render(); }
  }),
);
document.querySelectorAll('[data-color]').forEach((btn) => {
  btn.style.background = btn.dataset.color;
  btn.classList.toggle('active', btn.dataset.color === settings.penColor);
  btn.addEventListener('click', () => {
    setSettings({ penColor: btn.dataset.color });
    document.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b === btn));
    $('[data-tool="pen"]').click();
  });
});
$('#undo').addEventListener('click', () => board.undo());
$('#redo').addEventListener('click', () => board.redo());
$('#pagePrev').addEventListener('click', () => board.goto(board.pi - 1));
$('#pageNext').addEventListener('click', () => board.goto(board.pi + 1));
$('#pageNew').addEventListener('click', () => board.addPage());
$('#pageLabel').addEventListener('click', () => {
  const name = prompt('Page name', board.page.name);
  if (name) { board.page.name = name; emit('page', { page: board.page, index: board.pi, count: board.pages.length }); board.saveSoon(); }
});
on('page', ({ page, index, count }) => { $('#pageLabel').textContent = `${page.name} (${index + 1}/${count})`; });
$('#pageLabel').textContent = `${board.page.name} (${board.pi + 1}/${board.pages.length})`;

$('#attention').addEventListener('change', (e) => setSettings({ attention: e.target.value }));
$('#voiceOutBtn').addEventListener('click', () => {
  setSettings({ voiceOut: !settings.voiceOut });
  if (!settings.voiceOut) voice.cancelSpeech();
});
$('#panelBtn').addEventListener('click', () => {
  const order = ['right', 'bottom', 'left', 'float', 'hidden'];
  setSettings({ panelPosition: order[(order.indexOf(settings.panelPosition) + 1) % order.length] });
});
$('#settingsBtn').addEventListener('click', () => settingsUI.open());
$('#stopBtn').addEventListener('click', () => agent.stop());
$('#askSel').addEventListener('click', () => {
  if (settings.panelPosition === 'hidden') setSettings({ panelPosition: 'right' });
  $('#input').focus();
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? board.redo() : board.undo(); }
  else if (e.key === 'Escape') agent.stop();
  else if (e.key === 'p') $('[data-tool="pen"]').click();
  else if (e.key === 'e') $('[data-tool="eraser"]').click();
  else if (e.key === 's') $('[data-tool="select"]').click();
});

// ---------- mic ----------
const mic = $('#micBtn');
function updateMic() {
  const st = voice.state();
  mic.classList.toggle('on', st.listening || st.want);
  mic.title = !voice.supported ? 'Speech recognition is not available in this browser' : settings.voiceIn === 'push' ? 'Hold to talk' : settings.voiceIn === 'continuous' ? 'Tap to start/stop listening' : 'Voice input is off (Settings)';
  mic.disabled = !voice.supported || settings.voiceIn === 'off';
}
mic.addEventListener('pointerdown', (e) => {
  voice.unlock();
  if (settings.voiceIn === 'push') { e.preventDefault(); mic.setPointerCapture(e.pointerId); voice.pushStart(); mic.classList.add('on'); }
});
const endPush = () => { if (settings.voiceIn === 'push' && voice.listening) voice.pushEnd(); };
mic.addEventListener('pointerup', endPush);
mic.addEventListener('pointercancel', endPush);
mic.addEventListener('click', () => { if (settings.voiceIn === 'continuous') voice.toggleContinuous(); });
on('mic', updateMic);
on('utterance', (text) => askFrom(text, 'voice'));
on('interim', (t) => {
  const el = $('#interim');
  el.hidden = !t;
  el.textContent = t;
});
on('voice-error', (m) => panel.add('error', m));
on('speaking', (v) => $('#voiceOutBtn').classList.toggle('speaking', v));
document.addEventListener('pointerdown', () => voice.unlock(), { once: true });

// ---------- board events ----------
on('lock', (v) => { $('#aiChip').hidden = !v; });
on('locked-tap', () => {
  const chip = $('#aiChip');
  chip.classList.remove('pulse');
  void chip.offsetWidth;
  chip.classList.add('pulse');
});
on('mark', (m) => {
  const label = { ok: 'Looks right', warn: 'Worth a look', error: 'Possible mistake', note: 'Note' }[m.kind] || 'Note';
  panel.add('info', `**${label}:** ${m.note}`, {
    actions: [
      { label: 'Explain more', run: () => askFrom(`Explain your margin note in more detail: "${m.note}"`, 'mark') },
      { label: 'Dismiss', run: () => { board.page.marks = board.page.marks.filter((x) => x !== m); board.render(); board.saveSoon(); } },
    ],
  });
});
on('selection', (sel) => { $('#askSel').hidden = !sel; });

// ---------- cost meter ----------
function updateCost() {
  const s = meter.stats();
  const btn = $('#costBtn');
  btn.textContent = `${fmt(s.today)} today`;
  btn.classList.toggle('over', overBudget());
}
on('cost', updateCost);
$('#costBtn').addEventListener('click', () => {
  const s = meter.stats();
  const names = { answer: 'Answers', watch: 'Watching', verify: 'Error checks', code: 'App changes' };
  const by = Object.entries(s.byPurpose).map(([k, v]) => `- ${names[k] || k}: ${fmt(v)}`).join('\n') || '- nothing yet';
  const budget = settings.dailyBudgetUSD > 0 ? `${fmt(settings.dailyBudgetUSD)} per day` : 'no limit';
  panel.add('info', `**Spending**\n\nThis session: ${fmt(s.session)}\nToday: ${fmt(s.today)} (budget ${budget})\n${by}\n\nThis month: ${fmt(s.month)}\n\nEstimated from token counts at list prices; the Claude Console usage page is the exact record.`);
});

// ---------- settings → UI ----------
function applySettings() {
  $('#attention').value = settings.attention;
  $('#voiceOutBtn').classList.toggle('active', settings.voiceOut);
  panel.applyPosition();
  panel.renderActions();
  updateMic();
  board.render();
  updateCost();
  if (settings.voiceIn !== 'continuous' && voice.want) voice.stopAll();
}
on('settings', applySettings);
applySettings();

// ---------- start ----------
panel.add('info', `Write on the page, then ask about it — type below, hold the mic, or tap a button. Select a region with ⬚ to point at something. Attention: **${{ live: 'Live', quiet: 'Quiet live', demand: 'On demand' }[settings.attention]}**.`);
if (!settings.apiKey) settingsUI.open(true);
else {
  setTimeout(warmCas, 6000);
  setTimeout(() => changes.maybeOfferImprovements(), 3000);
}
