// Toolbar tool options:
// - pen: thickness slider (live preview, presets), colour palette, the system's full-spectrum picker, recent colours;
// - eraser: size slider and presets (shown as circles), and partial vs whole-stroke erasing.
import { settings, setSettings } from './settings.js';
import { on } from './bus.js';

const PALETTE = [
  '#1d1d1f', '#5b5b60', '#9a9aa0', '#7a4a2a',
  '#c0392b', '#e8590c', '#f2a20c', '#e9d10b',
  '#7cb518', '#1e7a46', '#0f9d8f', '#1fa3d6',
  '#1a5fd0', '#3f37c9', '#7b2cbf', '#c2187a',
];
const WIDTH_PRESETS = [1, 2, 3.5, 6, 10];
const ERASER_PRESETS = [8, 16, 28, 44, 64];
const $ = (s) => document.querySelector(s);

// A popover that opens under its anchor and closes on an outside tap (without drawing) or Escape.
export function makePopover(pop, triggerSel) {
  const open = (anchor) => {
    closeAll(pop);
    pop.hidden = false;
    const a = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, a.left - 8)) + 'px';
    pop.style.top = a.bottom + 8 + 'px';
  };
  const close = () => { pop.hidden = true; };
  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden || pop.contains(e.target) || e.target.closest(triggerSel)) return;
    close();
    // A tap on the board that only closes the popover shouldn't also draw or erase.
    if (e.target.id === 'board') { e.stopPropagation(); e.preventDefault(); }
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  let lastSize = `${window.innerWidth}x${window.innerHeight}`;
  window.addEventListener('resize', () => {
    const size = `${window.innerWidth}x${window.innerHeight}`;
    if (size !== lastSize) { lastSize = size; close(); } // real rotation only, not the app's own layout refreshes
  });
  const p = { pop, open, close, toggle: (anchor) => (pop.hidden ? open(anchor) : close()) };
  popovers.push(p);
  return p;
}
const popovers = [];
const closeAll = (except) => popovers.forEach((p) => { if (p.pop !== except) p.close(); });

export function initInkTools({ selectPen, selectEraser }) {
  // ---------- pen ----------
  const penPop = makePopover($('#inkPop'), '#colorBtn,#widthBtn');
  const range = $('#widthRange');
  const colorInput = $('#colorInput');
  $('#palette').innerHTML = PALETTE.map((c) => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
  $('#widthPresets').innerHTML = WIDTH_PRESETS.map((w) => `<button type="button" data-width="${w}" aria-label="Thickness ${w}"><span style="height:${Math.max(1, w * 0.9)}px"></span></button>`).join('');

  function chooseColor(c, { live = false } = {}) {
    if (live) { settings.penColor = c; refresh(); return; } // while dragging in the system picker
    const recent = [c, ...(settings.recentColors || []).filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 3);
    setSettings({ penColor: c, recentColors: recent });
    selectPen();
  }
  function setWidth(w, save) {
    settings.penWidth = Math.round(w * 10) / 10;
    if (save) setSettings({});
    refresh();
  }

  $('#colorBtn').addEventListener('click', (e) => penPop.toggle(e.currentTarget));
  $('#widthBtn').addEventListener('click', (e) => penPop.toggle(e.currentTarget));
  $('#recentColors').addEventListener('click', (e) => {
    const b = e.target.closest('[data-recent]');
    if (b) chooseColor(b.dataset.recent);
  });
  penPop.pop.addEventListener('click', (e) => {
    const c = e.target.closest('[data-color]');
    if (c) chooseColor(c.dataset.color);
    const w = e.target.closest('[data-width]');
    if (w) { setWidth(+w.dataset.width, true); selectPen(); }
  });
  range.addEventListener('input', () => setWidth(+range.value, false));
  range.addEventListener('change', () => { setWidth(+range.value, true); selectPen(); });
  colorInput.addEventListener('input', () => chooseColor(colorInput.value, { live: true }));
  colorInput.addEventListener('change', () => chooseColor(colorInput.value));

  // ---------- eraser ----------
  const erPop = makePopover($('#eraserPop'), '#eraserMore,[data-tool="eraser"]');
  const erRange = $('#eraserRange');
  $('#eraserPresets').innerHTML = ERASER_PRESETS.map((s) => `<button type="button" data-esize="${s}" aria-label="Eraser size ${s}"><span style="width:${Math.max(6, s * 0.5)}px;height:${Math.max(6, s * 0.5)}px"></span></button>`).join('');
  const setEraser = (s, save) => {
    settings.eraserSize = Math.round(s);
    if (save) setSettings({});
    refresh();
  };
  $('#eraserMore').addEventListener('click', (e) => { selectEraser(); erPop.toggle(e.currentTarget.parentElement); });
  erRange.addEventListener('input', () => setEraser(+erRange.value, false));
  erRange.addEventListener('change', () => setEraser(+erRange.value, true));
  erPop.pop.addEventListener('click', (e) => {
    const s = e.target.closest('[data-esize]');
    if (s) setEraser(+s.dataset.esize, true);
    const m = e.target.closest('[data-mode]');
    if (m) setSettings({ eraserMode: m.dataset.mode });
  });

  // ---------- reflect current settings ----------
  function refresh() {
    const c = settings.penColor, w = settings.penWidth;
    $('#colorBtn .ink-dot').style.background = c;
    $('#widthIcon').setAttribute('stroke-width', String(Math.min(5, 1 + w * 0.45)));
    $('#widthDemo path').setAttribute('stroke', c);
    $('#widthDemo path').setAttribute('stroke-width', String(w));
    $('#widthVal').textContent = w.toFixed(1);
    range.value = String(w);
    colorInput.value = /^#[0-9a-f]{6}$/i.test(c) ? c : '#1d1d1f';
    penPop.pop.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === c.toLowerCase()));
    penPop.pop.querySelectorAll('[data-width]').forEach((b) => b.classList.toggle('active', Math.abs(+b.dataset.width - w) < 0.05));
    $('#recentColors').innerHTML = (settings.recentColors || [])
      .map((rc) => `<button type="button" class="swatch${rc.toLowerCase() === c.toLowerCase() ? ' active' : ''}" data-recent="${rc}" style="background:${rc}" aria-label="Recent colour ${rc}"></button>`)
      .join('');

    const es = settings.eraserSize;
    $('#eraserVal').textContent = `${es} px`;
    erRange.value = String(es);
    erPop.pop.querySelectorAll('[data-esize]').forEach((b) => b.classList.toggle('active', Math.abs(+b.dataset.esize - es) < 1));
    erPop.pop.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === settings.eraserMode));
  }

  on('settings', refresh);
  refresh();
  return { openEraser: (anchor) => erPop.open(anchor) };
}
