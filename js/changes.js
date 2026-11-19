// Self-update flow: run the coding agent, show the PR, ship on your approval, roll back, and
// collect a friction log Claude can turn into improvement proposals.
import { settings } from './settings.js';
import { runCodeAgent } from './codeagent.js';
import { gh } from './github.js';

const SHIPPED = 'live-board-shipped';
const FRICTION = 'live-board-friction';
const LAST_PROPOSAL = 'live-board-last-proposal';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export class Changes {
  constructor({ panel, voice }) {
    this.panel = panel;
    this.voice = voice;
    this.lastPR = null;
    this.running = 0;
  }

  get friction() { return read(FRICTION, []); }

  logFriction(note) {
    if (!note) return;
    const list = this.friction;
    list.push({ note, at: new Date().toISOString() });
    write(FRICTION, list.slice(-50));
  }

  clearFriction() { write(FRICTION, []); }

  startCodeChange(request) {
    if (!request.trim()) return;
    this.running++;
    this.panel.add('info', `**Working on an app change:** ${request}\n\nThis runs in the background; keep writing.`);
    runCodeAgent(request, { onStatus: (s) => this.panel.status(s) })
      .then((res) => {
        if (res.noChange) {
          this.panel.add('assistant', `No code change was needed. ${res.summary}`);
          return;
        }
        this.lastPR = res;
        this.showPRCard(res);
        if (settings.narration && settings.voiceOut) this.voice.speak('Your app change is ready to review.');
      })
      .catch((e) => this.panel.add('error', 'Code change failed: ' + e.message))
      .finally(() => { this.running--; this.panel.status(''); });
  }

  showPRCard(res) {
    const tpl = settings.github.previewUrlTemplate;
    const preview = tpl ? tpl.replace('{pr}', res.pr.number).replace('{branch}', res.branch) : null;
    this.panel.add(
      'card',
      `**${res.title}** — PR #${res.pr.number}\n\n${res.summary}\n\nFiles: ${res.files.map((f) => '`' + f + '`').join(', ')}\n\n[Open pull request](${res.pr.html_url})${preview ? ` · [Try the preview](${preview})` : ''}`,
      { actions: [{ label: 'Ship it', run: (b) => this.ship(res, b) }] },
    );
  }

  requestShip() {
    if (!this.lastPR) return 'There is no prepared change in this session. The user can merge pull requests on GitHub directly.';
    this.panel.add('card', `Ship **${this.lastPR.title}** (PR #${this.lastPR.pr.number})?`, {
      actions: [{ label: 'Ship it', run: (b) => this.ship(this.lastPR, b) }],
    });
    return 'Showed a confirm button in the panel.';
  }

  async ship(res, btn) {
    btn.disabled = true;
    btn.textContent = 'Shipping…';
    try {
      const before = await gh.headSha();
      await gh.merge(res.pr.number);
      const shipped = read(SHIPPED, []);
      shipped.push({ before, pr: res.pr.number, title: res.title, at: new Date().toISOString() });
      write(SHIPPED, shipped.slice(-20));
      btn.textContent = 'Shipped';
      this.panel.add('info', 'Shipped. GitHub Pages usually updates within a minute or two; then reload.', {
        actions: [
          { label: 'Reload app', run: () => location.reload() },
          { label: 'Roll back', run: (b) => this.rollback(b) },
        ],
      });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Ship it';
      this.panel.add('error', 'Merge failed: ' + e.message);
    }
  }

  requestRollback() {
    const shipped = read(SHIPPED, []);
    if (!shipped.length) return 'Nothing has been shipped from this device yet, so there is nothing to roll back here.';
    const last = shipped[shipped.length - 1];
    this.panel.add('card', `Roll back **${last.title}** (restores the app as it was before ${last.at.slice(0, 16).replace('T', ' ')})?`, {
      actions: [{ label: 'Roll back', run: (b) => this.rollback(b) }],
    });
    return 'Showed a confirm button in the panel.';
  }

  async rollback(btn) {
    const shipped = read(SHIPPED, []);
    const last = shipped.pop();
    if (!last) return this.panel.add('info', 'Nothing to roll back.');
    btn.disabled = true;
    try {
      await gh.rollbackTo(last.before);
      write(SHIPPED, shipped);
      btn.textContent = 'Rolled back';
      this.panel.add('info', `Rolled back "${last.title}". Reload in a minute or two.`, { actions: [{ label: 'Reload app', run: () => location.reload() }] });
    } catch (e) {
      btn.disabled = false;
      this.panel.add('error', 'Rollback failed: ' + e.message);
    }
  }

  improveFromFriction() {
    const list = this.friction;
    if (!list.length) return this.panel.add('info', 'The friction log is empty, so there is nothing to improve yet.');
    write(LAST_PROPOSAL, Date.now());
    this.startCodeChange(
      `Improve the app based on these problems noticed during use:\n- ${list.map((f) => f.note).join('\n- ')}\n\nPick the 1-3 most valuable fixes that can be done safely in one change, and say in the summary which ones you chose.`,
    );
    this.clearFriction();
  }

  // Level 3: occasionally offer (never auto-run) improvements based on what went wrong.
  maybeOfferImprovements() {
    const list = this.friction;
    const last = read(LAST_PROPOSAL, 0);
    if (list.length >= 3 && Date.now() - last > 24 * 3600 * 1000 && settings.github.token) {
      write(LAST_PROPOSAL, Date.now());
      this.panel.add('info', `I noted ${list.length} rough edges recently (things I misread or couldn't do). Want me to prepare an improvement for you to review?`, {
        actions: [{ label: 'Prepare improvements', run: () => this.improveFromFriction() }],
      });
    }
  }
}
