// Renders LaTeX to images (via MathJax SVG) so typeset AI blocks can live on the canvas
// and appear in the snapshots Claude sees.
const cache = new Map();

// Resolves true when MathJax is ready, or false after a timeout (then blocks fall back to plain text).
let gaveUp = false;
export function mathReady(timeoutMs = 8000) {
  const start = Date.now();
  if (gaveUp && !window.MathJax?.tex2svg) return Promise.resolve(false);
  return new Promise((resolve) => {
    const check = () => {
      if (window.MathJax && window.MathJax.tex2svg) (window.MathJax.startup?.promise || Promise.resolve()).then(() => resolve(true), () => resolve(false));
      else if (Date.now() - start > timeoutMs) { gaveUp = true; resolve(false); }
      else setTimeout(check, 100);
    };
    check();
  });
}

const textTex = (t) => `\\text{${t.replace(/[{}]/g, (c) => (c === '{' ? '｛' : '｝'))}}`;

// Checks every board line before anything is written. Returns [] when all render, else
// [{ line, error }] (an empty list too when MathJax is unavailable: lines then fall back to text anyway).
export async function texErrors(lines) {
  const out = [];
  for (const line of lines) {
    const L = lineToTex(line);
    if (L.plain) continue;
    const im = await texToImage(L.tex, { display: L.display });
    if (im?.error) out.push({ line: String(line), error: im.error });
  }
  return out;
}

// One board line -> { plain, text } or { tex, display }.
// "$$...$$" or "\[...\]" = display math; other lines are text with optional inline $...$.
export function lineToTex(line) {
  const s = String(line).trim();
  const m = s.match(/^\$\$([\s\S]*)\$\$$/) || s.match(/^\\\[([\s\S]*)\\\]$/);
  if (m) return { tex: m[1].trim(), display: true };
  const parts = s.split(/(\$[^$]+\$)/g).filter(Boolean);
  if (!parts.some((p) => p.length > 1 && p.startsWith('$') && p.endsWith('$'))) return { plain: true, text: s };
  const tex = parts
    .map((p) => (p.length > 1 && p.startsWith('$') && p.endsWith('$') ? p.slice(1, -1) : textTex(p)))
    .join(' ');
  return { tex, display: false };
}

export function texToImage(tex, { color = '#000', display = true, fontPx = 22, strokePx = 0 } = {}) {
  const key = `${tex}|${color}|${display}|${fontPx}|${strokePx}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (!(await mathReady())) {
      cache.delete(key); // retry later once MathJax has loaded
      return null;
    }
    let node;
    try {
      node = window.MathJax.tex2svg(tex, { display });
    } catch {
      return null;
    }
    const svg = node.querySelector('svg');
    if (!svg) return null;
    // A LaTeX mistake makes MathJax draw an error box whose yellow/red colours come from a page stylesheet.
    // In a standalone image that stylesheet is missing, so the box became a solid bar of ink colour that
    // hid the message. Report the error instead, so the line can be shown as text and Claude can fix it.
    const err = svg.querySelector('[data-mml-node="merror"]');
    if (err) return { error: err.getAttribute('data-mjx-error') || err.getAttribute('title') || err.textContent || 'LaTeX error' };
    const exPx = fontPx * 0.44;
    const w = Math.max(1, parseFloat(svg.getAttribute('width')) * exPx);
    const h = Math.max(1, parseFloat(svg.getAttribute('height')) * exPx);
    // Thicker letters: outline every glyph, so its lines are about strokePx thick (the font's own are ~0.075 em)
    const extra = strokePx - fontPx * 0.075;
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    if (extra > 0.2 && vb[2] > 0) {
      const units = (extra * vb[2]) / w; // px -> the SVG's own units
      svg.querySelectorAll('[stroke-width]').forEach((el) => el.setAttribute('stroke-width', String(units)));
      const g = svg.querySelector('g');
      if (g) { g.setAttribute('stroke', 'currentColor'); g.setAttribute('stroke-width', String(units)); g.setAttribute('stroke-linejoin', 'round'); }
    }
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.removeAttribute('style');
    const xml = new XMLSerializer().serializeToString(svg).replace(/currentColor/g, color);
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      });
    } catch {
      return null;
    }
    return { img, w, h };
  })();
  cache.set(key, p);
  return p;
}
