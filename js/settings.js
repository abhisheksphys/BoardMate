// All behaviour lives here as data, so the user (or Claude, via update_settings) can change it without code changes.
import { emit } from './bus.js';

const KEY = 'live-board-settings';

export const DEFAULTS = {
  apiKey: '',
  // fast = default for answers and watching; main/deep = used only when a question needs them.
  models: { fast: 'claude-haiku-5-5', main: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
  routing: 'auto', // auto (fast, hands off when needed) | main | deep
  // How Claude's board writing looks (a preset sets all of them; any change makes it "custom")
  writeStyle: 'comfortable', // compact | comfortable | textbook | custom
  textFont: 'serif', // serif = the same typeface as the maths | sans
  lineSpacing: 'normal', // compact | normal | relaxed
  paraSpacing: 'normal', // small | normal | large: space before headings and around display equations
  columnChars: 75, // longest line in characters (0 = as wide as the page allows)
  displayAlign: 'center', // center | left
  stepIndent: 'small', // none | small | medium: lines under a heading are indented
  mathScale: 1, // display equations, relative to the text
  headingScale: 'normal', // small | normal | large
  headingColor: 'darker', // same | darker
  aiSideBar: true, // the thin line to the left of Claude's blocks
  writeMargin: 40, // page padding left/right: space Claude's writing keeps from the page edge (freeform: from the screen edge)
  writeMarginV: 40, // page padding top/bottom (notebook: starts below the top, continues on the next page before the bottom)
  blockPadding: 'normal', // none | small | normal | large: space between a block's side bar and its text
  blockGap: 'normal', // small | normal | large: space Claude leaves above its block (from your writing or its other blocks)
  hangIndent: true, // wrapped lines: the rows after the first are set in a little
  awareness: 'normal', // normal | deep (more looks at other parts of the page, step-back looks in pauses)
  markTap: 'board', // tapping a ✗ / ! mark: board = Claude writes what is wrong and the fix next to the line | panel = the note in the panel
  answerDepth: 'auto', // auto (as much as the question needs) | brief | detailed
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
  writeAnimation: 'write', // write (each line drawn left to right) | fade | lines (one at a time) | off
  writeAnimationMs: 350, // time per line
  // How Claude's writing looks. Each: 'mimic' (from your writing where it goes) or 'manual' (a set value).
  aiSizeMode: 'mimic',
  aiSizeScale: 1, // mimic: × your handwriting where it writes (1 = same, 1.2 = a bit larger)
  aiSizeManual: 1, // manual: × your average writing size on the page
  aiSizeFixed: 18, // fixed: the same size everywhere, in points (as in a document; 12 = printed text)
  aiWeightMode: 'manual',
  aiWeightManual: 0, // manual: line thickness, same units as Pen width (0 = normal type)
  aiColorMode: 'manual',
  aiColor: '#1a5fd0', // manual colour
  penColor: '#1d1d1f',
  penWidth: 2.4,
  recentColors: ['#1d1d1f', '#c0392b', '#1e7a46'],
  inkSmoothing: 0.3, // 0 = raw Pencil input, higher = smoother but slightly softer corners (max 0.8)
  inkPrediction: true, // draw a few milliseconds ahead of the Pencil tip where the browser supports it
  eraserSize: 20, // diameter in on-screen pixels
  eraserMode: 'partial', // partial = erase only what the circle touches | stroke = remove whole strokes
  eraserBlocks: false, // the eraser also removes Claude's blocks and pasted pictures (off: only your ink and marks)
  paper: 'dots', // plain | dots | ruled | grid: for new pages, and pages that haven't picked their own
  paperSpacing: 40, // distance between lines or dots
  fingerDraws: false,
  doubleTapAction: null, // one-finger double tap on the page runs this saved action (its name); '' = nothing
  twoFingerSwap: true, // a quick two-finger tap on the page switches to the last tool (pen ↔ eraser…)
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
  'routing', 'answerDepth', 'attention', 'watchIdleSec', 'quietIdleSec', 'watchMaxWaitSec', 'escalate', 'boardRequests', 'awareness', 'writeStyle', 'textFont', 'lineSpacing', 'paraSpacing', 'columnChars', 'displayAlign', 'stepIndent', 'mathScale', 'headingScale', 'headingColor', 'aiSideBar', 'writeMargin', 'writeMarginV', 'blockPadding', 'blockGap', 'hangIndent', 'markTap', 'quietLowEffort', 'liveSpeak',
  'voiceSend', 'voiceSendDelaySec', 'wakeWord', 'headphones', 'voiceOut', 'voiceName', 'speechRate', 'narration',
  'allowBoardWrite', 'writeAnimation', 'writeAnimationMs', 'aiSizeMode', 'aiSizeScale', 'aiSizeManual', 'aiSizeFixed', 'aiWeightMode', 'aiWeightManual', 'aiColorMode', 'aiColor', 'penColor', 'penWidth', 'inkSmoothing', 'inkPrediction', 'eraserSize', 'eraserMode', 'eraserBlocks', 'paper', 'paperSpacing', 'fingerDraws', 'twoFingerSwap', 'doubleTapAction', 'showMarks',
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
if (settings.aiMatchSize === false) settings.aiSizeMode = 'manual'; // old on/off switch for size matching
delete settings.aiMatchSize;
// first time: a double tap runs your "AOP" action if you have one
if (settings.doubleTapAction == null) settings.doubleTapAction = (settings.savedActions || []).find((a) => /^aop$/i.test(a.name))?.name || '';
// Removed: both restarted listening without a tap, and on iPad a run started that way hears nothing.
delete settings.voiceFreshRuns; delete settings.voiceWatchdogSec;

// Board-writing presets: one choice sets every style setting (each can still be changed on its own).
export const WRITE_PRESETS = {
  compact: { textFont: 'serif', lineSpacing: 'compact', paraSpacing: 'small', columnChars: 0, displayAlign: 'left', stepIndent: 'none', mathScale: 1, headingScale: 'small', headingColor: 'same', aiSideBar: true, writeMargin: 16, writeMarginV: 16, blockPadding: 'small', blockGap: 'small', hangIndent: false },
  comfortable: { textFont: 'serif', lineSpacing: 'normal', paraSpacing: 'normal', columnChars: 75, displayAlign: 'center', stepIndent: 'small', mathScale: 1, headingScale: 'normal', headingColor: 'darker', aiSideBar: true, writeMargin: 40, writeMarginV: 40, blockPadding: 'normal', blockGap: 'normal', hangIndent: true },
  textbook: { textFont: 'serif', lineSpacing: 'relaxed', paraSpacing: 'large', columnChars: 65, displayAlign: 'center', stepIndent: 'small', mathScale: 1.08, headingScale: 'large', headingColor: 'darker', aiSideBar: false, writeMargin: 64, writeMarginV: 64, blockPadding: 'normal', blockGap: 'large', hangIndent: true },
};

// What a session can set for itself (Page setup → Claude's writing in this session). The style is a preset name.
export const WRITING_KEYS = ['aiSizeMode', 'aiSizeScale', 'aiSizeManual', 'aiSizeFixed', 'aiWeightMode', 'aiWeightManual', 'aiColorMode', 'aiColor', 'writeStyle', 'writeMargin', 'writeMarginV', 'blockPadding', 'blockGap'];

// The settings Claude's writing follows in a session: the global ones, then the session's preset, then its own values.
export function writingSettings(override) {
  if (!override) return settings;
  const preset = WRITE_PRESETS[override.writeStyle] || {};
  const own = {};
  for (const k of WRITING_KEYS) if (override[k] !== undefined && override[k] !== null && k !== 'writeStyle') own[k] = override[k];
  return { ...settings, ...preset, ...own };
}

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
