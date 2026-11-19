// The assistant panel: chat, answers (Markdown + LaTeX), live commentary, action buttons.
// Dockable right/left/bottom, floating, or hidden.
import { settings, setSettings } from './settings.js';
import { escapeHtml } from './bus.js';

function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  });
  return doc.body.firstChild.innerHTML;
}

export function renderMarkdown(md) {
  const store = [];
  const protect = (s) => { store.push(s); return `@@M${store.length - 1}@@`; };
  const t = String(md)
    .replace(/\$\$[\s\S]+?\$\$/g, protect)
    .replace(/\\\[[\s\S]+?\\\]/g, protect)
    .replace(/\\\([\s\S]+?\\\)/g, protect)
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (m, pre, inner) => pre + protect(`$${inner}$`));
  let html = window.marked ? window.marked.parse(t, { breaks: true }) : escapeHtml(t).replace(/\n/g, '<br>');
  html = html.replace(/@@M(\d+)@@/g, (_, i) => escapeHtml(store[+i]));
  return sanitize(html);
}

export class Panel {
  constructor({ onSend, onAction }) {
    this.el = document.getElementById('panel');
    this.list = document.getElementById('messages');
    this.actionsEl = document.getElementById('actions');
    this.statusEl = document.getElementById('status');
    this.input = document.getElementById('input');
    this.onSend = onSend;
    this.onAction = onAction;
    document.getElementById('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      this.send();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
    });
    this.input.addEventListener('input', () => this.autosize());
    document.getElementById('panelPos').addEventListener('change', (e) => setSettings({ panelPosition: e.target.value }));
    document.getElementById('clearChat').addEventListener('click', () => { this.list.innerHTML = ''; this.onAction?.('clear-chat'); });
    this.initFloatDrag();
    this.renderActions();
    this.applyPosition();
  }

  send() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.autosize();
    this.onSend(text);
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(160, this.input.scrollHeight) + 'px';
  }

  add(role, md, { actions } = {}) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (role === 'commentary') {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = 'watching';
      el.append(tag);
    }
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = role === 'user' ? escapeHtml(md) : renderMarkdown(md);
    el.append(body);
    if (actions?.length) el.append(this.actionBar(actions));
    this.list.append(el);
    this.typeset(body);
    this.scroll();
    return el;
  }

  addImage(src, caption, actions) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    const img = document.createElement('img');
    img.src = src;
    img.className = 'page-img';
    img.addEventListener('click', () => window.open(src, '_blank'));
    const cap = document.createElement('div');
    cap.className = 'caption';
    cap.textContent = caption || '';
    el.append(img, cap);
    if (actions?.length) el.append(this.actionBar(actions));
    this.list.append(el);
    this.scroll();
    return el;
  }

  actionBar(actions) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.addEventListener('click', () => a.run(b));
      bar.append(b);
    }
    return bar;
  }

  typeset(el) {
    const go = () => window.MathJax?.typesetPromise?.([el]).catch(() => {});
    if (window.MathJax?.typesetPromise) go();
    else setTimeout(go, 1200);
  }

  scroll() {
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  status(text) {
    this.statusEl.textContent = text || '';
    this.statusEl.classList.toggle('busy', !!text);
  }

  renderActions() {
    this.actionsEl.innerHTML = '';
    for (const a of settings.savedActions || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = a.name;
      b.title = a.prompt;
      b.addEventListener('click', () => this.onAction?.('saved', a));
      this.actionsEl.append(b);
    }
  }

  applyPosition() {
    const pos = settings.panelPosition;
    document.body.classList.remove('panel-right', 'panel-left', 'panel-bottom', 'panel-float', 'panel-hidden');
    document.body.classList.add(`panel-${pos}`);
    document.getElementById('panelPos').value = pos;
    if (pos === 'float') {
      const p = JSON.parse(localStorage.getItem('live-board-float') || '{"x":null,"y":null}');
      this.el.style.left = (p.x ?? window.innerWidth - 400) + 'px';
      this.el.style.top = (p.y ?? 80) + 'px';
    } else {
      this.el.style.left = '';
      this.el.style.top = '';
    }
    window.dispatchEvent(new Event('resize'));
  }

  initFloatDrag() {
    const head = document.getElementById('panelHead');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (settings.panelPosition !== 'float' || e.target.closest('select,button')) return;
      drag = { dx: e.clientX - this.el.offsetLeft, dy: e.clientY - this.el.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(window.innerWidth - 120, e.clientX - drag.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, e.clientY - drag.dy));
      this.el.style.left = x + 'px';
      this.el.style.top = y + 'px';
    });
    head.addEventListener('pointerup', () => {
      if (!drag) return;
      drag = null;
      localStorage.setItem('live-board-float', JSON.stringify({ x: this.el.offsetLeft, y: this.el.offsetTop }));
    });
  }
}
