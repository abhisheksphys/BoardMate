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
import { initInkTools } from './inktools.js';
import { initImages } from './images.js';
import { Sessions } from './sessions.js';

const $ = (s) => document.querySelector(s);

// ---------- core objects ----------
const board = new Board($('#board'));
window.liveBoard = board; // handy for debugging from the browser console
window.liveVoice = voice;
let agent;
const panel = new Panel({
  onSend: (text) => askFrom(text, 'typed'),
  onAction: (kind, a) => {
    if (kind === 'saved') askFrom(a.prompt, 'action button', a.name);
    if (kind === 'clear-chat') { agent.reset(); sessions.chat = []; sessions.markChanged(); }
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

const sessions = new Sessions({ board, panel, agent });
agent.sessions = sessions;
window.liveSessions = sessions;

// ---------- toolbar ----------
function selectTool(name) {
  board.tool = name;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  if (name !== 'select' && board.selection) { board.selection = null; board.render(); }
  if (name !== 'eraser') board.eraserCursor = null;
  if (name !== 'select') board.activeBlock = null;
  board.renderLive();
}
const ink = initInkTools({ selectPen: () => selectTool('pen'), selectEraser: () => selectTool('eraser') });
initImages({ board, panel, selectTool });
document.querySelectorAll('[data-tool]').forEach((btn) =>
  btn.addEventListener('click', () => {
    // Tapping the eraser while it's already selected opens its size options (like GoodNotes).
    if (btn.dataset.tool === 'eraser' && board.tool === 'eraser') {
      const pop = $('#eraserPop');
      if (pop.hidden) ink.openEraser(btn.parentElement); else pop.hidden = true;
      return;
    }
    selectTool(btn.dataset.tool);
  }),
);
$('#undo').addEventListener('click', () => board.undo());
$('#redo').addEventListener('click', () => board.redo());
$('#pagePrev').addEventListener('click', () => board.goto(board.pi - 1));
$('#pageNext').addEventListener('click', () => board.goto(board.pi + 1));
$('#pageNew').addEventListener('click', () => board.addPage());
$('#pageLabel').addEventListener('click', () => {
  const name = prompt('Page name', board.page.name);
  if (name) { board.page.name = name; emit('page', { page: board.page, index: board.pi, count: board.pages.length }); board.saveSoon(); }
});
function setPageLabel({ page, index, count }) {
  if (!page) return;
  $('#pageLabel').textContent = count > 1 ? `${page.name} · ${index + 1}/${count}` : page.name;
  $('#pageLabel').title = `${page.name} (page ${index + 1} of ${count}) — tap to rename`;
}
on('page', setPageLabel);


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
  else if ((e.key === 'Backspace' || e.key === 'Delete') && board.deleteActiveBlock()) e.preventDefault();
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
  // Don't unlock speech output here: on iOS that switches audio to playback just as listening starts,
  // and the mic then hears nothing for a while. It is unlocked on any other tap, or just after listening is up.
  if (settings.voiceIn === 'push') { e.preventDefault(); mic.setPointerCapture(e.pointerId); voice.pushStart(); mic.classList.add('on'); }
});
const endPush = () => { if (settings.voiceIn === 'push' && voice.listening) voice.pushEnd(); };
mic.addEventListener('pointerup', endPush);
mic.addEventListener('pointercancel', endPush);
mic.addEventListener('click', () => { if (settings.voiceIn === 'continuous') voice.toggleContinuous(); });
on('mic', updateMic);
on('utterance', (text) => askFrom(text, 'voice'));
// The speech bar: what you're saying, live. In "send manually" mode it keeps everything you say
// until you tap ↑ (send), ✎ (edit in the chat box first) or ✕ (discard).
on('interim', (t) => {
  const el = $('#interim');
  el.hidden = !t;
  el.classList.toggle('manual', settings.voiceSend === 'manual');
  el.querySelector('.interim-text').textContent = t;
});
$('#interimSend').addEventListener('click', () => voice.sendNow());
$('#interimClear').addEventListener('click', () => voice.discardHeard());
$('#interimEdit').addEventListener('click', () => {
  const t = voice.takeHeard();
  if (!t) return;
  if (settings.panelPosition === 'hidden') setSettings({ panelPosition: 'right' });
  const input = $('#input');
  input.value = input.value ? `${input.value} ${t}` : t;
  input.dispatchEvent(new Event('input'));
  input.focus();
});
on('voice-error', (m) => panel.add('error', m));
// Visible proof that the mic is actually listening, and optional step-by-step diagnostics.
on('mic', (st) => {
  if (agent.busy) return;
  panel.status(st.listening ? (st.ready ? '🎙 Listening…' : '🎙 Starting the mic…') : st.want ? '🎙 Starting the mic…' : '');
});
on('voice-debug', (m) => panel.add('info', `🎙 ${m}`, { noLog: true }));
on('speaking', (v) => $('#voiceOutBtn').classList.toggle('speaking', v));
// Unlock speech output (iOS needs a tap for that) on the first tap that isn't the mic.
const unlockOnTap = (e) => {
  if (e.target.closest?.('#micBtn')) return;
  voice.unlock();
  document.removeEventListener('pointerdown', unlockOnTap, true);
};
document.addEventListener('pointerdown', unlockOnTap, true);

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
// Every button is wired up above, so the app is usable even if loading sessions has a problem.
on('storage-error', (m) => window.showAppError?.(m));
try {
  await sessions.init();
} catch (e) {
  window.showAppError?.(`Your sessions could not be loaded (${e?.message || e}). You can still write on a blank page; tell Claude in chat what happened.`);
  if (!board.page) board.load([]);
}
setPageLabel({ page: board.page, index: board.pi, count: board.pages.length });
window.liveBoardReady = true;

if (!settings.apiKey) settingsUI.open(true);
else {
  setTimeout(warmCas, 6000);
  setTimeout(() => changes.maybeOfferImprovements(), 3000);
}
