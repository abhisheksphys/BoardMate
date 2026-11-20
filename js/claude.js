// Thin client for the Anthropic Messages API, called directly from the browser with the user's own key.
// Handles prompt caching (so repeated context is billed at a fraction) and records the cost of every call.
import { settings } from './settings.js';
import { meter } from './costs.js';

const cc = (long) => (long ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' });

// Returns a copy of message i with a cache breakpoint on its last block.
function markMessage(msg, long) {
  const content = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : msg.content.slice();
  const i = content.length - 1;
  if (i < 0) return msg;
  content[i] = { ...content[i], cache_control: cc(long) };
  return { ...msg, content };
}

/**
 * cacheAt: indexes of messages whose end should be cached for the long TTL (stable history).
 * cacheLast: also cache the end of the last message (short TTL) so tool-loop follow-ups reuse it.
 * Long-TTL breakpoints always come before the short one, as the API requires.
 */
export async function claude({ model, system, messages, tools, max_tokens = 4096, signal, purpose = 'answer', cacheAt = [], cacheLast = false }) {
  if (!settings.apiKey) throw new Error('Add your Anthropic API key in Settings (gear icon).');
  const long = !!settings.longCache;
  const msgs = messages.slice();
  for (const i of cacheAt) if (i >= 0 && i < msgs.length - (cacheLast ? 1 : 0)) msgs[i] = markMessage(msgs[i], long);
  if (cacheLast && msgs.length) msgs[msgs.length - 1] = markMessage(msgs[msgs.length - 1], false);

  const body = { model, max_tokens, messages: msgs };
  if (system) body.system = [{ type: 'text', text: system, cache_control: cc(long) }];
  if (tools?.length) body.tools = tools;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = String(res.status);
    try {
      const j = await res.json();
      msg += ' ' + (j.error?.message || JSON.stringify(j));
    } catch {}
    throw new Error('Claude API error: ' + msg);
  }
  const json = await res.json();
  json._cost = meter.record(model, json.usage || {}, purpose);
  return json;
}

export const textOf = (resp) =>
  (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

export function parseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export const imageBlock = (snap) => ({
  type: 'image',
  source: { type: 'base64', media_type: snap.media_type || 'image/jpeg', data: snap.b64 },
});

// ---- models you can choose in Settings ----
// Shown until (and if) the live list from your account can be fetched.
export const KNOWN_MODELS = [
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
];
const MODELS_KEY = 'live-board-models';

export function cachedModels() {
  try {
    const c = JSON.parse(localStorage.getItem(MODELS_KEY) || 'null');
    if (c && Array.isArray(c.list) && c.list.length) return c.list;
  } catch {}
  return KNOWN_MODELS;
}

// Every model your API key can use, newest first (Anthropic's Models API). Free: no tokens are used.
export async function listModels(apiKey = settings.apiKey) {
  if (!apiKey) throw new Error('no API key');
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const list = (j.data || []).filter((m) => m && m.id).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  if (!list.length) throw new Error('empty list');
  try { localStorage.setItem(MODELS_KEY, JSON.stringify({ at: Date.now(), list })); } catch {}
  return list;
}
