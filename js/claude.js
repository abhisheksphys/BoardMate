// Thin client for the Anthropic Messages API, called directly from the browser with the user's own key.
import { settings } from './settings.js';

export async function claude({ model, system, messages, tools, max_tokens = 4096, signal }) {
  if (!settings.apiKey) throw new Error('Add your Anthropic API key in Settings (gear icon).');
  const body = { model, max_tokens, messages };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
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
  return res.json();
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
