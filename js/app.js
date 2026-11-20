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
import { Exporter } from './export.js';
import { Backup } from './backup.js';
import { PageNav } from './pages.js';

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
const exporter = new Exporter({ board, panel, sessions });
agent.exporter = exporter;
window.liveExporter = exporter;
window.liveBackup = new Backup({ panel, sessions });
$('#exportBtn')?.addEventListener('click', () => {
  sessions.closeDrawer?.();
  $('#exportDlg').showModal();
});
$('#exportPdf')?.addEventListener('click', () => { $('#exportDlg').close(); exporter.pdf(); });
$('#exportTex')?.addEventListener('click', () => { $('#exportDlg').close(); exporter.latex(); });
$('#exportCancel')?.addEventListener('click', () => $('#exportDlg').close());
$('#exportDlg')?.addEventListener('click', (e) => { if (e.target === $('#exportDlg')) $('#exportDlg').close(); });

// ---------- toolbar ----------
function selectTool(name) {
  if (name !== board.tool) lastTool = board.tool; // for the two-finger tap
  board.tool = name;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  if (name !== 'select' && name !== 'lasso' && board.selection) { board.selection = null; board.render(); }
  if (name !== 'eraser') board.eraserCursor = null;
  if (name !== 'select') board.activeBlock = null;
  board.renderLive();
}
// A quick two-finger tap on the page: back to the tool used before (Safari can't see the Pencil's own double-tap).
let lastTool = 'eraser';
const TOOL_NAMES = { pen: 'Pen', eraser: 'Eraser', select: 'Select', lasso: 'Lasso' };
on('two-finger-tap', () => {
  if (!settings.twoFingerSwap) return;
  const to = lastTool && lastTool !== board.tool ? lastTool : board.tool === 'pen' ? 'eraser' : 'pen';
  selectTool(to);
  toolToast(TOOL_NAMES[to] || to);
});
// A one-finger double tap on the page runs the action button chosen in Settings (e.g. AOP), like tapping it.
on('double-tap', () => {
  const name = settings.doubleTapAction;
  if (!name) return;
  const a = (settings.savedActions || []).find((x) => x.name === name);
  if (!a) return toolToast(`No action called "${name}" (Settings → Board)`);
  toolToast(`▸ ${a.name}`);
  askFrom(a.prompt, 'double tap', a.name);
});
function toolToast(text) {
  let t = $('#toolToast');
  if (!t) { t = document.createElement('div'); t.id = 'toolToast'; $('#boardWrap').append(t); }
  t.textContent = text;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toolToast.timer);
  toolToast.timer = setTimeout(() => t.classList.remove('show'), 900);
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
  if (name) { board.page.name = name; board.page.customName = true; emit('page', { page: board.page, index: board.pi, count: board.pages.length }); board.saveSoon(); }
});
function setPageLabel({ page, index, count }) {
  if (!page) return;
  $('#pageLabel').textContent = count > 1 ? `${page.name} · ${index + 1}/${count}` : page.name;
  $('#pageLabel').title = `${page.name} (page ${index + 1} of ${count}) — tap to rename`;
}
on('page', setPageLabel);

// ---------- page navigation: floating page number, Back, bookmark star, Pages overview ----------
window.livePages = new PageNav({ board, panel });


$('#attention').addEventListener('change', (e) => setSettings({ attention: e.target.value }));
$('#voiceOutBtn').addEventListener('click', () => {
  setSettings({ voiceOut: !settings.voiceOut });
  if (!settings.voiceOut) voice.cancelSpeech();
  else voice.unlock(); // this tap can unlock speech output (only if the mic is off)
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
  else if (e.key === 'l') $('[data-tool="lasso"]').click();
});

// ---------- mic ----------
const mic = $('#micBtn');
function updateMic() {
  const st = voice.state();
  mic.classList.toggle('on', st.listening || st.want);
  mic.title = !voice.supported ? 'Speech recognition is not available in this browser' : st.want ? 'Listening: tap to stop' : 'Tap to start listening';
  mic.disabled = !voice.supported;
}
// Tap on = listening until you tap again. (Speech output is not unlocked on this tap: on iOS that
// switches audio to playback just as listening starts, and the mic then hears nothing for a while.)
mic.addEventListener('click', () => voice.toggleContinuous());
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
on('voice-notice', (m) => panel.add('info', `🎙 ${m}`));
// Visible proof that the mic is actually listening, and optional step-by-step diagnostics.
on('mic', (st) => {
  if (agent.busy) return;
  panel.status(st.listening ? (st.ready ? '🎙 Listening…' : '🎙 Starting the mic…') : st.want ? '🎙 Starting the mic…' : '');
});
on('voice-debug', (m) => panel.add('info', `🎙 ${m}`, { noLog: true }));
on('speaking', (v) => $('#voiceOutBtn').classList.toggle('speaking', v));
// Unlock speech output (iOS needs a tap for that) on a tap that isn't the mic, once replies are on
// and the mic is off (see voice.unlock).
const unlockOnTap = (e) => {
  if (e.target.closest?.('#micBtn')) return;
  if (voice.unlock()) document.removeEventListener('pointerdown', unlockOnTap, true);
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
  // ✗ and ! marks: tapping writes the explanation and the fix next to the line (unless set to the panel only)
  if ((m.kind === 'error' || m.kind === 'warn') && settings.markTap !== 'panel') return agent.explainMark(m);
  const label = { ok: 'Looks right', warn: 'Worth a look', error: 'Possible mistake', note: 'Note' }[m.kind] || 'Note';
  panel.add('info', `**${label}:** ${m.note}`, {
    actions: [
      { label: 'Explain more', run: () => askFrom(`Explain your margin note in more detail: "${m.note}"`, 'mark') },
      { label: 'Dismiss', run: (btn) => { board.page.marks = board.page.marks.filter((x) => x !== m); board.render(); board.saveSoon(); btn?.closest('.msg')?.remove(); } },
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
