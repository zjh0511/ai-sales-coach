// 文件知識庫的儲存層。
// 瀏覽器用 IndexedDB（可存數十 MB，且資料永遠留在使用者自己的裝置）；
// Node 沒有 IndexedDB，自動退回記憶體版本，讓 tools/selftest.mjs 仍可執行。

const DB = 'aicoach', STORE = 'docs';
const hasIDB = typeof indexedDB !== 'undefined';
const mem = new Map();

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}

export async function allDocs() {
  if (!hasIDB) return [...mem.values()];
  return (await tx('readonly', s => s.getAll())) || [];
}

export async function putDoc(doc) {
  if (!hasIDB) { mem.set(doc.id, doc); return; }
  await tx('readwrite', s => s.put(doc));
}

export async function delDoc(id) {
  if (!hasIDB) { mem.delete(id); return; }
  await tx('readwrite', s => s.delete(id));
}

export async function getDocById(id) {
  if (!hasIDB) return mem.get(id) || null;
  return (await tx('readonly', s => s.get(id))) || null;
}
