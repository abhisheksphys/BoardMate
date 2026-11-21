// Minimal IndexedDB key-value wrapper.
// Stores: sessions (titles, summaries… small), sessionData (pages, chat, Claude history), library (PDFs), kv,
// and pages (only from version 1, read once to migrate into the first session).
import { emit } from './bus.js';

const DB_NAME = 'live-board';
const DB_VERSION = 2;
const STORES = ['pages', 'library', 'kv', 'sessions', 'sessionData'];
let dbPromise;

function db() {
  if (!dbPromise) {
    const mine = (dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => {
        const d = req.result;
        // iPadOS can close the connection on its own (for example while the app is hidden behind the
        // Files picker). Forget it, so the next read or write opens a fresh one.
        d.onclose = () => { if (dbPromise === mine) dbPromise = null; };
        // If a newer version of the app opens in another tab, step aside so its upgrade isn't blocked.
        d.onversionchange = () => {
          d.close();
          dbPromise = null;
          emit('storage-error', 'BoardMate was updated in another tab. Reload this tab to keep working.');
        };
        resolve(d);
      };
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open storage')); };
      // An older copy of the app is still open somewhere and holding the storage: the upgrade waits for it.
      req.onblocked = () => emit('storage-error', 'BoardMate is open in another Safari tab with an older version. Close that tab and this page will finish loading.');
    }));
  }
  return dbPromise;
}

// The connection was closed under us ("The database connection is closing", "Connection to Indexed
// Database server lost"): not a problem with the data, so reopen and try once more.
const lostConnection = (e) => e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || /clos|lost/i.test(e.message || ''));

function once(d, store, mode, fn) {
  return new Promise((resolve, reject) => {
    let t;
    try { t = d.transaction(store, mode); } catch (e) { reject(e); return; }
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new DOMException('Transaction aborted', 'UnknownError'));
  });
}

async function tx(store, mode, fn) {
  const d = await db();
  try {
    return await once(d, store, mode, fn);
  } catch (e) {
    if (!lostConnection(e)) throw e;
    if (dbPromise && (await dbPromise.catch(() => null)) === d) dbPromise = null; // drop the dead connection
    try { d.close(); } catch {}
    return once(await db(), store, mode, fn);
  }
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
};
