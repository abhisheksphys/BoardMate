// GitHub REST helpers for the self-update loop: read the app's repo, commit to a branch, open/merge PRs, roll back.
import { settings } from './settings.js';

async function api(path, opts = {}) {
  const g = settings.github;
  if (!g.token || !g.owner || !g.repo) throw new Error('Set up GitHub (token, owner, repo) in Settings → Self-update to let the app change its own code.');
  const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${g.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

function b64decode(s) {
  const bin = atob(s.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const gh = {
  async headSha(branch = settings.github.branch) {
    return (await api(`/git/ref/heads/${encodePath(branch)}`)).object.sha;
  },

  async listFiles(ref = settings.github.branch) {
    const t = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size }));
  },

  async readFile(path, ref = settings.github.branch) {
    const j = await api(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(j)) throw new Error(`${path} is a directory`);
    return b64decode(j.content || '');
  },

  // files: { path: newContent | null (delete) }
  async commitToNewBranch(newBranch, files, message, base = settings.github.branch) {
    const baseSha = await this.headSha(base);
    const baseCommit = await api(`/git/commits/${baseSha}`);
    const tree = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) tree.push({ path, mode: '100644', type: 'blob', sha: null });
      else {
        const blob = await api('/git/blobs', { method: 'POST', body: { content: b64encode(content), encoding: 'base64' } });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const newTree = await api('/git/trees', { method: 'POST', body: { base_tree: baseCommit.tree.sha, tree } });
    const commit = await api('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [baseSha] } });
    await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${newBranch}`, sha: commit.sha } });
    return { baseSha, commitSha: commit.sha };
  },

  openPR(head, title, body, base = settings.github.branch) {
    return api('/pulls', { method: 'POST', body: { head, base, title, body } });
  },

  merge(number) {
    return api(`/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
  },

  // Creates a new commit on the branch whose content equals an earlier commit (history is kept).
  async rollbackTo(sha, branch = settings.github.branch) {
    const head = await this.headSha(branch);
    const target = await api(`/git/commits/${sha}`);
    const c = await api('/git/commits', { method: 'POST', body: { message: `Roll back to ${sha.slice(0, 7)}`, tree: target.tree.sha, parents: [head] } });
    await api(`/git/refs/heads/${encodePath(branch)}`, { method: 'PATCH', body: { sha: c.sha } });
    return c.sha;
  },
};
