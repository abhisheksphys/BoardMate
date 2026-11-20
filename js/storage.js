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
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => {
        const d = req.result;
        // If a newer version of the app opens in another tab, step aside so its upgrade isn't blocked.
        d.onversionchange = () => {
          d.close();
          dbPromise = null;
          emit('storage-error', 'Live Board was updated in another tab. Reload this tab to keep working.');
        };
        resolve(d);
      };
      req.onerror = () => { dbPromise = null; reject(req.error || new Error('Could not open storage')); };
      // An older copy of the app is still open somewhere and holding the storage: the upgrade waits for it.
      req.onblocked = () => emit('storage-error', 'Live Board is open in another Safari tab with an older version. Close that tab and this page will finish loading.');
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  set: (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
};
