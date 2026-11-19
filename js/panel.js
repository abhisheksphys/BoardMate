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
    this.initSplitter();
    this.initFloatGrip();
    window.addEventListener('resize', () => this.applySize());
    this.renderActions();
    this.applyPosition();
  }

  // ---------- resizing the panel / board split ----------
  // Keeps the board at least 240 px and the panel at least 220 px, whatever the screen size.
  limits() {
    const st = document.getElementById('stage').getBoundingClientRect();
    const floating = settings.panelPosition === 'float';
    const left = floating ? this.el.offsetLeft || 0 : 0;
    const top = floating ? this.el.offsetTop || 0 : 0;
    return {
      w: [220, Math.max(220, st.width - 240)],
      h: [140, Math.max(140, st.height - 200)],
      // a floating panel never grows past the screen edge
      fw: [260, Math.max(260, st.width - left - 8)],
      fh: [220, Math.max(220, st.height - top - 8)],
    };
  }

  applySize() {
    const L = this.limits();
    const clamp = (v, [lo, hi]) => Math.round(Math.max(lo, Math.min(hi, v)));
    const root = document.documentElement.style;
    root.setProperty('--panel-w', clamp(settings.panelWidth, L.w) + 'px');
    root.setProperty('--panel-h', clamp(settings.panelHeight, L.h) + 'px');
    root.setProperty('--float-w', clamp(settings.floatWidth, L.fw) + 'px');
    root.setProperty('--float-h', clamp(settings.floatHeight, L.fh) + 'px');
  }

  initSplitter() {
    const sp = document.getElementById('splitter');
    const stage = document.getElementById('stage');
    let drag = null;
    const sizeFrom = (e) => {
      const r = stage.getBoundingClientRect();
      const pos = settings.panelPosition;
      if (pos === 'bottom') return { key: 'panelHeight', v: r.bottom - e.clientY };
      if (pos === 'left') return { key: 'panelWidth', v: e.clientX - r.left };
      return { key: 'panelWidth', v: r.right - e.clientX };
    };
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      drag = true;
      sp.classList.add('dragging');
      document.body.classList.add('resizing');
      document.body.style.cursor = settings.panelPosition === 'bottom' ? 'row-resize' : 'col-resize';
    });
    sp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { key, v } = sizeFrom(e);
      settings[key] = v;
      this.applySize();
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      sp.classList.remove('dragging');
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      const L = this.limits();
      settings.panelWidth = Math.max(L.w[0], Math.min(L.w[1], Math.round(settings.panelWidth)));
      settings.panelHeight = Math.max(L.h[0], Math.min(L.h[1], Math.round(settings.panelHeight)));
      setSettings({});
    };
    sp.addEventListener('pointerup', end);
    sp.addEventListener('pointercancel', end);
    sp.addEventListener('dblclick', () => setSettings({ panelWidth: 380, panelHeight: 300 }));
    sp.addEventListener('keydown', (e) => {
      const bottom = settings.panelPosition === 'bottom';
      const grow = settings.panelPosition === 'left' ? 'ArrowRight' : bottom ? 'ArrowUp' : 'ArrowLeft';
      const shrink = settings.panelPosition === 'left' ? 'ArrowLeft' : bottom ? 'ArrowDown' : 'ArrowRight';
      const key = bottom ? 'panelHeight' : 'panelWidth';
      if (e.key === grow) setSettings({ [key]: settings[key] + 24 });
      else if (e.key === shrink) setSettings({ [key]: settings[key] - 24 });
    });
  }

  initFloatGrip() {
    const g = document.getElementById('floatGrip');
    let start = null;
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      g.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY, w: this.el.offsetWidth, h: this.el.offsetHeight };
      document.body.classList.add('resizing');
    });
    g.addEventListener('pointermove', (e) => {
      if (!start) return;
      settings.floatWidth = start.w + e.clientX - start.x;
      settings.floatHeight = start.h + e.clientY - start.y;
      this.applySize();
    });
    const end = () => {
      if (!start) return;
      start = null;
      document.body.classList.remove('resizing');
      settings.floatWidth = this.el.offsetWidth;
      settings.floatHeight = this.el.offsetHeight;
      setSettings({});
    };
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
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

  footer(el, text) {
    if (!el) return;
    const f = document.createElement('div');
    f.className = 'cost-line';
    f.textContent = text;
    el.append(f);
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
    this.applySize();
    if (pos === 'float') {
      const p = JSON.parse(localStorage.getItem('live-board-float') || '{"x":null,"y":null}');
      const w = Math.min(settings.floatWidth, window.innerWidth - 16);
      const x = Math.max(8, Math.min(p.x ?? window.innerWidth - w - 24, window.innerWidth - w - 8));
      this.el.style.left = x + 'px';
      this.el.style.top = Math.max(8, p.y ?? 40) + 'px';
      this.applySize();
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
