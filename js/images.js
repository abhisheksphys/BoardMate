// Images on the page: paste (⌘V or the Paste button), pick from Photos/Files, or drag and drop.
// Large images are scaled down before saving so pages stay light. Pasted images appear in the
// page snapshots Claude sees, so you can paste a figure or a book page and ask about it.
import { makePopover } from './inktools.js';

const $ = (s) => document.querySelector(s);
const MAX_PX = 1600;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = url;
  });
}

const blobToDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function prepareImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, MAX_PX / Math.max(w, h));
    if (s === 1 && blob.size < 700_000) return { src: await blobToDataURL(blob), w, h };
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * s);
    cv.height = Math.round(h * s);
    const ctx = cv.getContext('2d');
    const png = blob.type === 'image/png' || blob.type === 'image/gif';
    if (!png) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height); }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    let src = cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88);
    if (png && src.length > 1_500_000) { // big screenshots: JPEG is much smaller
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      src = cv.toDataURL('image/jpeg', 0.88);
    }
    return { src, w: cv.width, h: cv.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function initImages({ board, panel, selectTool }) {
  const pop = makePopover($('#imgPop'), '#imgBtn');

  async function place(blob, at) {
    try {
      const { src, w, h } = await prepareImage(blob);
      selectTool('select'); // so it can be moved or resized right away
      await board.placeImage(src, w, h, at);
    } catch (e) {
      panel.add('error', e.message || 'Could not add that image.');
    }
  }

  $('#imgBtn').addEventListener('click', (e) => pop.toggle(e.currentTarget));

  $('#imgPaste').addEventListener('click', async () => {
    pop.close();
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) return place(await it.getType(type));
      }
      panel.add('info', 'There is no image on the clipboard. Copy one first (from Photos, Safari, a screenshot…), then tap Paste image.');
    } catch {
      panel.add('info', "Safari didn't allow reading the clipboard this time. Tap **Paste** if it offers it, press ⌘V with a keyboard, or use **Photo or file…**.");
    }
  });

  $('#imgFile').addEventListener('change', async (e) => {
    pop.close();
    for (const f of e.target.files) await place(f);
    e.target.value = '';
  });

  // ⌘V / Ctrl+V anywhere except the settings dialog. Text pastes into the chat box are left alone.
  document.addEventListener('paste', async (e) => {
    if (e.target.closest?.('dialog')) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) await place(f);
  });

  // Drag and drop onto the page (e.g. from Photos or Files in Split View).
  const wrap = $('#boardWrap');
  const hasImage = (e) => [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
  wrap.addEventListener('dragover', (e) => { if (hasImage(e)) { e.preventDefault(); wrap.classList.add('drop'); } });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop'));
  wrap.addEventListener('drop', async (e) => {
    wrap.classList.remove('drop');
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const r = board.c.getBoundingClientRect();
    const at = board.toWorld(e.clientX - r.left, e.clientY - r.top);
    for (const [i, f] of files.entries()) await place(f, { x: at.x + i * 30, y: at.y + i * 30 });
  });
}
