// Automatic backup of all sessions, PDFs and settings to a PRIVATE GitHub repository, and restore from it.
// Layout in the repo:  sessions/<id>.json  ·  pdfs/<id>.pdf + pdfs/<id>.json  ·  folders.json  ·  settings.json  ·  README.md
// Only what changed since the last backup is uploaded (one commit per backup). The API key and the GitHub
// token are never included. The app's own repo is public on GitHub Pages, so backups never go there.
import { settings } from './settings.js';
import { idb } from './storage.js';

const STATE_KEY = 'backup-state';
const CHECK_EVERY_MS = 5 * 60 * 1000; // look for changes this often…
const MIN_GAP_MS = 10 * 60 * 1000; // …and back up at most this often

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const textToB64 = (s) => bytesToB64(new TextEncoder().encode(s));
const b64ToText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + s.length;
}

function cleanSettings() {
  const s = structuredClone(settings);
  delete s.apiKey;
  if (s.github) delete s.github.token;
  return s;
}

export class Backup {
  constructor({ panel, sessions }) {
    this.panel = panel;
    this.sessions = sessions;
    this.running = false;
    this.lastRun = 0;
    setInterval(() => this.maybeAuto(), CHECK_EVERY_MS);
    setTimeout(() => this.maybeAuto(), 60 * 1000); // shortly after opening the app
  }

  target() {
    const name = String(settings.backupRepo || '').trim();
    if (!name) return null;
    const [o, r] = name.includes('/') ? name.split('/') : [settings.github.owner, name];
    return o && r ? { owner: o.trim(), repo: r.trim() } : null;
  }

  configured() { return !!(settings.github.token && this.target()); }

  async api(path, opts = {}) {
    const t = this.target();
    const res = await fetch(`https://api.github.com/repos/${t.owner}/${t.repo}${path}`, {
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${settings.github.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (opts.allow?.includes(res.status)) return { status: res.status };
    if (!res.ok) {
      const msg = (await res.text()).slice(0, 200);
      if (res.status === 404) throw new Error(`GitHub can't find ${t.owner}/${t.repo}, or the token has no access to it. Give the token "Contents: read and write" on that repository.`);
      if (res.status === 401) throw new Error('GitHub rejected the token (expired or wrong). Make a new one and paste it in Settings → Self-update.');
      throw new Error(`GitHub ${res.status}: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async state() { return (await idb.get('kv', STATE_KEY)) || { files: {}, at: 0, error: null }; }

  async status() {
    if (!this.target()) return 'Not set up: enter a private repository name above.';
    if (!settings.github.token) return 'Not set up: add a GitHub token under Self-update.';
    const s = await this.state();
    const when = s.at ? new Date(s.at).toLocaleString() : 'never';
    return `Last backup: ${when}${s.error ? ` · last attempt failed: ${s.error}` : ''}`;
  }

  async repoReady() {
    const info = await this.api('');
    if (!info.private) throw new Error(`${info.full_name} is public. Backups contain your sessions and PDFs, so they only go to a private repository. Make it private on GitHub (Settings → General → Danger zone → Change visibility) or use another one.`);
    const branch = info.default_branch || 'main';
    let ref = await this.api(`/git/ref/heads/${encodeURIComponent(branch)}`, { allow: [404, 409] });
    if (ref.status) {
      // an empty repository: the first file has to be created with the contents API
      await this.api('/contents/README.md', { method: 'PUT', body: { message: 'Start BoardMate backups', content: textToB64('# BoardMate backups\n\nSessions, PDFs and settings saved by the BoardMate app. Restore them from the app: Settings → Backup → Restore from GitHub.\n'), branch } });
      ref = await this.api(`/git/ref/heads/${encodeURIComponent(branch)}`);
    }
    return { branch, head: ref.object.sha };
  }

  // Everything that should be in the backup, with a fingerprint for each file (to skip unchanged ones).
  async inventory() {
    const items = [];
    for (const m of (await idb.all('sessions')) || []) {
      items.push({ path: `sessions/${m.id}.json`, stamp: `${m.updated || 0}`, make: async () => textToB64(JSON.stringify({ meta: m, data: await idb.get('sessionData', m.id) })) });
    }
    for (const b of (await idb.all('library')) || []) {
      const { data, ...meta } = b;
      items.push({ path: `pdfs/${b.id}.pdf`, stamp: 'pdf', make: async () => bytesToB64(new Uint8Array(data)) });
      const mj = JSON.stringify(meta);
      items.push({ path: `pdfs/${b.id}.json`, stamp: hash(mj), make: async () => textToB64(mj) });
    }
    const fj = JSON.stringify((await idb.get('kv', 'folders')) || []);
    items.push({ path: 'folders.json', stamp: hash(fj), make: async () => textToB64(fj) });
    const sj = JSON.stringify(cleanSettings());
    items.push({ path: 'settings.json', stamp: hash(sj), make: async () => textToB64(sj) });
    return items;
  }

  async maybeAuto() {
    if (!settings.backupAuto || !this.configured() || this.running) return;
    if (Date.now() - this.lastRun < MIN_GAP_MS) return;
    try { await this.sessions?.save?.(); } catch {}
    const st = await this.state();
    const items = await this.inventory();
    const changed = items.some((it) => st.files[it.path] !== it.stamp) || Object.keys(st.files).some((p) => !items.find((it) => it.path === p));
    if (changed) this.run({ quiet: true });
  }

  async run({ quiet = false } = {}) {
    if (this.running) return { ok: false, error: 'A backup is already running.' };
    if (!this.configured()) {
      const msg = 'Set up the GitHub backup first: Settings → Backup.';
      if (!quiet) this.panel.add('info', msg);
      return { ok: false, error: msg };
    }
    this.running = true;
    this.lastRun = Date.now();
    const st = await this.state();
    try {
      if (!quiet) this.panel.status('Backing up to GitHub…');
      await this.sessions?.save?.();
      const { branch, head } = await this.repoReady();
      const items = await this.inventory();
      const tree = [];
      let uploaded = 0;
      for (const it of items) {
        if (st.files[it.path] === it.stamp) continue;
        const blob = await this.api('/git/blobs', { method: 'POST', body: { content: await it.make(), encoding: 'base64' } });
        tree.push({ path: it.path, mode: '100644', type: 'blob', sha: blob.sha });
        uploaded++;
      }
      const gone = Object.keys(st.files).filter((p) => !items.find((it) => it.path === p));
      for (const p of gone) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
      if (tree.length) {
        const headCommit = await this.api(`/git/commits/${head}`);
        const newTree = await this.api('/git/trees', { method: 'POST', body: { base_tree: headCommit.tree.sha, tree } });
        const commit = await this.api('/git/commits', { method: 'POST', body: { message: `Backup ${new Date().toISOString()}: ${uploaded} file(s) updated${gone.length ? `, ${gone.length} removed` : ''}`, tree: newTree.sha, parents: [head] } });
        await this.api(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: commit.sha } });
      }
      const files = {};
      for (const it of items) files[it.path] = it.stamp;
      await idb.set('kv', STATE_KEY, { files, at: Date.now(), error: null });
      if (!quiet) this.panel.add('info', tree.length ? `Backed up to GitHub: ${uploaded} file(s) updated${gone.length ? `, ${gone.length} removed` : ''}.` : 'GitHub backup is already up to date.', { noLog: true });
      return { ok: true, uploaded, removed: gone.length };
    } catch (e) {
      const msg = e.message || String(e);
      await idb.set('kv', STATE_KEY, { ...st, error: msg.slice(0, 200) });
      if (!quiet || !this.warned) { this.warned = true; this.panel.add('error', 'GitHub backup failed: ' + msg); }
      return { ok: false, error: msg };
    } finally {
      this.running = false;
      if (!quiet) this.panel.status('');
    }
  }

  // Downloads the backup and merges it in (sessions that are newer here are kept), like restoring a file.
  async restore() {
    if (!this.configured()) return this.panel.add('info', 'Set up the GitHub backup first: Settings → Backup.');
    this.panel.status('Downloading your backup from GitHub…');
    try {
      const info = await this.api('');
      const ref = await this.api(`/git/ref/heads/${encodeURIComponent(info.default_branch || 'main')}`);
      const commit = await this.api(`/git/commits/${ref.object.sha}`);
      const tree = await this.api(`/git/trees/${commit.tree.sha}?recursive=1`);
      const blob = async (sha) => (await this.api(`/git/blobs/${sha}`)).content;
      const j = { app: 'live-board', version: 1, sessions: [], books: [], settings: null };
      const pdfMeta = {}, pdfData = {};
      for (const e of tree.tree.filter((x) => x.type === 'blob')) {
        let m;
        if ((m = e.path.match(/^sessions\/(.+)\.json$/))) j.sessions.push(JSON.parse(b64ToText(await blob(e.sha))));
        else if ((m = e.path.match(/^pdfs\/(.+)\.json$/))) pdfMeta[m[1]] = JSON.parse(b64ToText(await blob(e.sha)));
        else if ((m = e.path.match(/^pdfs\/(.+)\.pdf$/))) pdfData[m[1]] = (await blob(e.sha)).replace(/\n/g, '');
        else if (e.path === 'folders.json') j.folders = JSON.parse(b64ToText(await blob(e.sha)));
        else if (e.path === 'settings.json') j.settings = JSON.parse(b64ToText(await blob(e.sha)));
      }
      for (const id of Object.keys(pdfMeta)) if (pdfData[id]) j.books.push({ ...pdfMeta[id], data: pdfData[id] });
      this.panel.status('');
      await this.sessions.restoreData(j);
    } catch (e) {
      this.panel.status('');
      this.panel.add('error', 'Could not restore from GitHub: ' + (e.message || e));
    }
  }
}
