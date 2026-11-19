// All behaviour lives here as data, so the user (or Claude, via update_settings) can change it without code changes.
import { emit } from './bus.js';

const KEY = 'live-board-settings';

export const DEFAULTS = {
  apiKey: '',
  models: { watch: 'claude-haiku-5-5', main: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },

  // Perception
  attention: 'quiet', // live | quiet | demand
  watchIntervalSec: 4,
  escalate: true, // re-check suspected errors with the deep model
  liveSpeak: false, // speak live comments aloud

  // Voice
  voiceIn: 'push', // off | push | continuous
  wakeWord: '',
  headphones: false, // true = keep listening while AI speaks (enables barge-in)
  voiceOut: true,
  voiceName: '',
  speechRate: 1.05,
  narration: true, // short spoken "done" messages after actions

  // Board
  allowBoardWrite: true,
  writeAnimationMs: 200,
  aiColor: '#1a5fd0',
  penColor: '#1d1d1f',
  penWidth: 2.4,
  fingerDraws: false,
  showMarks: true,

  // Panel
  panelPosition: 'right', // right | left | bottom | float | hidden

  // Personalisation
  customInstructions: [],
  savedActions: [
    { name: 'Check my work', prompt: 'Check everything on this page carefully and point out any mistakes.' },
    { name: 'Explain this page', prompt: 'Explain what I have written on this page.' },
  ],

  // Self-update
  github: { token: '', owner: '', repo: '', branch: 'main', previewUrlTemplate: '' },

  pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/',
};

// Keys Claude may change itself. Secrets, models and self-update config stay user-only.
export const AI_EDITABLE = [
  'attention', 'watchIntervalSec', 'escalate', 'liveSpeak',
  'voiceIn', 'wakeWord', 'headphones', 'voiceOut', 'voiceName', 'speechRate', 'narration',
  'allowBoardWrite', 'writeAnimationMs', 'aiColor', 'penColor', 'penWidth', 'fingerDraws', 'showMarks',
  'panelPosition', 'customInstructions',
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
