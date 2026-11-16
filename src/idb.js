// Keeps KV and R2 contents across reloads in the browser's IndexedDB (one record per worker name). Used from inside the
// Web Worker when `persist: '<name>'` is passed to startWorker. Without it, everything lives in memory and a reload clears it.
const open = (name) =>
  new Promise((resolve, reject) => {
    const r = indexedDB.open(`cfworker2browser:${name}`, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('snap');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const tx = async (name, mode, fn) => {
  const db = await open(name);
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction('snap', mode).objectStore('snap'));
    req.onsuccess = () => {
      db.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
};

export const loadSnapshot = async (name) => (await tx(name, 'readonly', (s) => s.get('current'))) ?? {};
export const saveSnapshot = (name, snap) => tx(name, 'readwrite', (s) => s.put(snap, 'current'));
