// In-app coding agent: reads the app's repo, edits files, and opens a pull request for you to approve.
import { claude } from './claude.js';
import { settings } from './settings.js';
import { gh } from './github.js';

const TOOLS = [
  { name: 'list_files', description: 'List all files in the app repository with their sizes.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'read_file',
    description: 'Read a file (your staged version if you already wrote it, otherwise the current main branch).',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create or replace a whole file. Always send the COMPLETE new content of the file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'delete_file',
    description: 'Delete a file.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'finish',
    description: 'Call once the change is complete (or if no change is needed). title = pull request title; summary = 2-5 sentences for the user: what changed and how to try it.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] },
  },
];

const SYSTEM = `You are the coding agent for "Live Board", a personal web app: a handwriting whiteboard where Claude watches, listens, answers, and writes typeset math. It is a static site (plain HTML, CSS and ES modules, no build step) hosted on GitHub Pages.

How to work
- Start by reading CLAUDE.md, then list_files, then read every file you will touch.
- Make the smallest change that fully does the job, in the existing style. Keep the app working with no build step; load libraries only from cdn.jsdelivr.net or cdnjs.cloudflare.com.
- write_file replaces the whole file: always send complete content, never placeholders like "rest unchanged".
- If you add a setting, add its default in js/settings.js and a field in js/settingsUI.js. If Claude should control it, add it to AI_EDITABLE.
- Do not weaken safeguards: code changes must keep going through a pull request the user approves; never send API keys or tokens anywhere except the API they belong to; do not modify js/github.js or js/codeagent.js unless the request is explicitly about them.
- When done, call finish.`;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

export async function runCodeAgent(request, { onStatus, signal } = {}) {
  const pending = {};
  const messages = [{ role: 'user', content: `Change request from the user:\n\n${request}` }];
  let done = null;
  for (let step = 0; step < 40 && !done; step++) {
    onStatus?.(`Coding agent working… (step ${step + 1})`);
    // Each step re-sends the growing conversation; caching its end makes the next step read it at ~5% of the price.
    const resp = await claude({ model: settings.models.deep, system: SYSTEM, messages, tools: TOOLS, max_tokens: 16000, signal, purpose: 'code', cacheLast: true });
    if (resp.stop_reason === 'max_tokens') throw new Error('The coding agent ran out of output space; try a smaller, more specific change.');
    messages.push({ role: 'assistant', content: resp.content });
    const uses = resp.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      let out;
      try {
        const p = u.input?.path;
        if (u.name === 'list_files') out = JSON.stringify(await gh.listFiles());
        else if (u.name === 'read_file') out = p in pending ? (pending[p] ?? '(deleted in this change)') : await gh.readFile(p);
        else if (u.name === 'write_file') { pending[p] = String(u.input.content); out = `Staged ${p} (${pending[p].length} chars).`; }
        else if (u.name === 'delete_file') { pending[p] = null; out = `Staged deletion of ${p}.`; }
        else if (u.name === 'finish') { done = u.input; out = 'OK'; }
        else out = 'Unknown tool';
      } catch (e) {
        out = 'Error: ' + e.message;
      }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 120000) });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!done) throw new Error('The coding agent stopped without finishing.');
  const files = Object.keys(pending);
  if (!files.length) return { noChange: true, ...done };
  const branch = `claude/${slug(done.title)}-${Date.now().toString(36)}`;
  const { baseSha } = await gh.commitToNewBranch(branch, pending, done.title);
  const pr = await gh.openPR(branch, done.title, `${done.summary}\n\n---\nRequest: ${request}\n\n_Opened by the Live Board coding agent._`);
  return { pr, branch, baseSha, files, ...done };
}
