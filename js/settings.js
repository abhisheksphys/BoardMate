// All behaviour lives here as data, so the user (or Claude, via update_settings) can change it without code changes.
import { emit } from './bus.js';

const KEY = 'live-board-settings';

export const DEFAULTS = {
  apiKey: '',
  // fast = default for answers and watching; main/deep = used only when a question needs them.
  models: { fast: 'claude-haiku-5-5', main: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
  routing: 'auto', // auto (fast, hands off when needed) | main | deep
  webSearch: true, // let Claude search the web in answers (never while watching)
  webSearchMax: 0, // most searches in one answer (0 = no limit)

  // Perception
  attention: 'quiet', // live | quiet | demand
  watchIdleSec: 6, // Live: look once you have paused this long
  quietIdleSec: 20, // Quiet live: look once you have paused this long
  watchMaxWaitSec: 60, // look at least this often while you keep writing
  escalate: true, // re-check suspected errors with the strong model
  quietLowEffort: false, // Quiet live: ask the fast model for low reasoning effort (cheaper; test that notes stay accurate)
  boardRequests: true, // Live / Quiet live: do what you write on the board for Claude ("Write down the Lagrangian…")
  liveSpeak: false, // speak live comments aloud

  // Cost control
  dailyBudgetUSD: 1, // 0 = no limit; when reached, watching pauses (answers still work)
  currencySymbol: '₹',
  currencyRate: 100, // local currency per US dollar, for display only (0 = show dollars)
  imageMaxPx: 1100, // longest side of page images sent to Claude
  maxHistory: 6, // past questions kept in the conversation
  idleResetMin: 20, // start a fresh conversation after this long without questions
  longCache: true, // keep cached context for 1 hour instead of 5 minutes

  // Voice
  wakeWord: '',
  headphones: false, // true = keep listening while AI speaks (enables barge-in)
  voiceSend: 'auto', // auto = send after a pause | manual = wait for the ↑ button in the speech bar
  voiceSendDelaySec: 1.4, // auto mode: seconds of silence before sending
  voiceDebug: false, // show what speech recognition is doing in the panel status line
  voiceOut: true,
  voiceName: '',
  speechRate: 1.05,
  narration: true, // short spoken "done" messages after actions

  // Board
  allowBoardWrite: true,
  writeAnimationMs: 200,
  aiMatchSize: true, // size Claude's writing like your handwriting where it goes
  aiSizeScale: 1, // then scale it (0.9 = a bit smaller, 1.1 = a bit larger)
  aiColor: '#1a5fd0',
  penColor: '#1d1d1f',
  penWidth: 2.4,
  recentColors: ['#1d1d1f', '#c0392b', '#1e7a46'],
  inkSmoothing: 0.3, // 0 = raw Pencil input, higher = smoother but slightly softer corners (max 0.8)
  inkPrediction: true, // draw a few milliseconds ahead of the Pencil tip where the browser supports it
  eraserSize: 20, // diameter in on-screen pixels
  eraserMode: 'partial', // partial = erase only what the circle touches | stroke = remove whole strokes
  paper: 'dots', // plain | dots | ruled | grid: for new pages, and pages that haven't picked their own
  paperSpacing: 40, // distance between lines or dots
  fingerDraws: false,
  showMarks: true,

  // Panel
  panelPosition: 'right', // right | left | bottom | float | hidden
  panelWidth: 380, // px, when docked left or right
  panelHeight: 300, // px, when docked at the bottom
  floatWidth: 360, // px, floating panel
  floatHeight: 560,

  // Personalisation
  customInstructions: [],
  savedActions: [
    { name: 'Check my work', prompt: 'Check everything on this page carefully and point out any mistakes.' },
    { name: 'Explain this page', prompt: 'Explain what I have written on this page.' },
  ],

  // Backup to a private GitHub repository (uses the GitHub token from Self-update)
  backupRepo: '', // repo name (same owner) or owner/name; must be private
  backupAuto: true, // back up by itself when something changed (at most every 10 minutes)

  // Self-update
  github: { token: '', owner: '', repo: '', branch: 'main', previewUrlTemplate: '' },

  pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/',
};

// Keys Claude may change itself. Secrets, models and self-update config stay user-only.
export const AI_EDITABLE = [
  'routing', 'attention', 'watchIdleSec', 'quietIdleSec', 'watchMaxWaitSec', 'escalate', 'boardRequests', 'quietLowEffort', 'liveSpeak',
  'voiceSend', 'voiceSendDelaySec', 'wakeWord', 'headphones', 'voiceOut', 'voiceName', 'speechRate', 'narration',
  'allowBoardWrite', 'writeAnimationMs', 'aiMatchSize', 'aiSizeScale', 'aiColor', 'penColor', 'penWidth', 'inkSmoothing', 'inkPrediction', 'eraserSize', 'eraserMode', 'paper', 'paperSpacing', 'fingerDraws', 'showMarks',
  'panelPosition', 'panelWidth', 'panelHeight', 'floatWidth', 'floatHeight', 'customInstructions',
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (isObj(v) && isObj(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function load() {
  const base = structuredClone(DEFAULTS);
  try {
    return merge(base, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return base;
  }
}

export const settings = load();
delete settings.voiceIn; // old setting: the mic is now always tap-on / tap-off
// Removed: both restarted listening without a tap, and on iPad a run started that way hears nothing.
delete settings.voiceFreshRuns; delete settings.voiceWatchdogSec;

export function saveSettings() {
  localStorage.setItem(KEY, JSON.stringify(settings));
  emit('settings', settings);
}

export function setSettings(patch) {
  merge(settings, patch);
  saveSettings();
}

export function aiUpdateSettings(patch) {
  const applied = {}, rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const def = DEFAULTS[k];
    const typeOk = Array.isArray(def) ? Array.isArray(v) : typeof def === typeof v;
    if (!AI_EDITABLE.includes(k) || !typeOk) { rejected.push(k); continue; }
    settings[k] = v;
    applied[k] = v;
  }
  if (Object.keys(applied).length) saveSettings();
  return { applied, rejected };
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const parent = parts.reduce((o, k) => (o[k] ??= {}), obj);
  parent[last] = value;
}
