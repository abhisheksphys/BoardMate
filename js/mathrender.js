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
// A line cut into pieces for wrapping: each $...$ whole, each word on its own, and **bold** / *italic* spans
// spread over their words (so a wrapped italic line stays italic on every row).
export function wrapTokens(line) {
  const s = normaliseText(String(line))
    .replace(/\*\*([^*]+)\*\*/g, (_, x) => x.split(/(\s+)/).map((w) => (w.trim() ? `**${w}**` : w)).join(''))
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*/g, (_, pre, x) => pre + x.split(/(\s+)/).map((w) => (w.trim() ? `*${w}*` : w)).join(''));
  const tokens = [];
  for (const part of s.split(/(\$[^$]+\$)/g).filter(Boolean)) {
    if (part.length > 1 && part.startsWith('$') && part.endsWith('$')) tokens.push(part);
    else tokens.push(...(part.match(/\S+\s*|\s+/g) || []));
  }
  return tokens;
}

// opts.serif: plain words are typeset too (\text{}), so text and maths share one typeface; opts.bold: \textbf{}.
// LaTeX written as text (outside $...$) becomes what it means instead of showing as code:
// \textbf{x} → **x**, \textit{x} / \emph{x} → *x*, \underline / \texttt / \textsf → maths, \(x\) → $x$.
function normaliseText(s) {
  return s
    .replace(/\\\((.+?)\\\)/g, (_, m) => `$${m}$`)
    .replace(/\\textbf\{([^{}]*)\}/g, '**$1**')
    .replace(/\\(?:textit|emph)\{([^{}]*)\}/g, '*$1*')
    .replace(/\\(underline|texttt|textsf)\{([^{}]*)\}/g, (_, c, x) => `$\\${c}{\\text{${x}}}$`);
}

// Words with **bold** and *italic* (Markdown, as Claude writes in the panel) as TeX text pieces.
function wordsTex(t, { bold = false, sans = false } = {}) {
  const out = [];
  for (const piece of t.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*?\*)/g)) {
    if (!piece) continue;
    let cmd = bold ? 'textbf' : sans ? 'textsf' : 'text', body = piece;
    if (/^\*\*[^*]+\*\*$/.test(piece)) { cmd = 'textbf'; body = piece.slice(2, -2); }
    else if (/^\*[^*\s][^*]*\*$/.test(piece) && piece.length > 2) { cmd = bold ? 'textbf' : 'textit'; body = piece.slice(1, -1); }
    out.push(textTex(body).replace('\\text{', `\\${cmd}{`));
  }
  return out.join(' ');
}
const hasMarkup = (s) => /\*\*[^*]+\*\*|(^|[\s(])\*[^*\s][^*]*\*/.test(s);

// opts.serif: plain words are typeset too (\text{}), so text and maths share one typeface; opts.bold: \textbf{}.
export function lineToTex(line, { serif = false, bold = false } = {}) {
  const s = normaliseText(String(line).trim());
  const m = s.match(/^\$\$([\s\S]*)\$\$$/) || s.match(/^\\\[([\s\S]*)\\\]$/);
  if (m) return { tex: m[1].trim(), display: true };
  const parts = s.split(/(\$[^$]+\$)/g).filter(Boolean);
  const isMath = (p) => p.length > 1 && p.startsWith('$') && p.endsWith('$');
  if (!parts.some(isMath) && !serif && !hasMarkup(s)) return { plain: true, text: s };
  const tex = parts.map((p) => (isMath(p) ? (bold ? `\\boldsymbol{${p.slice(1, -1)}}` : p.slice(1, -1)) : wordsTex(p, { bold, sans: !serif }))).join(' ');
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
      // the promise version loads extra LaTeX packages on demand (\boldsymbol, \cancel, \bra/\ket, \ce …);
      // the plain one can't wait for them and drew such commands as red text
      node = window.MathJax.tex2svgPromise ? await window.MathJax.tex2svgPromise(tex, { display }) : window.MathJax.tex2svg(tex, { display });
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
    // an unknown command is drawn as its name in red (not as an error box): report it too
    const unknown = svg.querySelector('[data-mml-node="mtext"][fill="red"], [data-mml-node="mtext"][color="red"]');
    if (unknown) return { error: `Unknown command ${unknown.textContent || ''}`.trim() };
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
