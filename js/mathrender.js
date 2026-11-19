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

export function texToImage(tex, { color = '#000', display = true, fontPx = 22 } = {}) {
  const key = `${tex}|${color}|${display}|${fontPx}`;
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
    const exPx = fontPx * 0.44;
    const w = Math.max(1, parseFloat(svg.getAttribute('width')) * exPx);
    const h = Math.max(1, parseFloat(svg.getAttribute('height')) * exPx);
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
