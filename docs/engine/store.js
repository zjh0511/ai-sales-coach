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

// 上傳的教材與條款依帳號分開（使用者 2026-10-07 決定，理由見 owner.js）：
// 每份文件記下 owner（帳號 uid），只看得到、改得到自己的。
// 沒有帳號功能時 owner 是 null，所有文件都沒有 owner，行為與以前相同。
let OWNER = null;
export const setOwner = uid => { OWNER = uid || null; };
const mine = d => !!d && (d.owner || null) === OWNER;

async function everything() {
  if (!hasIDB) return [...mem.values()];
  return (await tx('readonly', s => s.getAll())) || [];
}

export async function allDocs() {
  return (await everything()).filter(mine);
}

export async function putDoc(doc) {
  doc.owner = OWNER;
  if (!hasIDB) { mem.set(doc.id, doc); return; }
  await tx('readwrite', s => s.put(doc));
}

export async function delDoc(id) {
  if (!await getDocById(id)) return;           // 別人的文件不能刪
  if (!hasIDB) { mem.delete(id); return; }
  await tx('readwrite', s => s.delete(id));
}

export async function getDocById(id) {
  const d = hasIDB ? await tx('readonly', s => s.get(id)) : mem.get(id);
  return mine(d) ? d : null;
}

// 更新前上傳、還沒有 owner 的文件
export async function legacyDocCount() {
  return (await everything()).filter(d => !d.owner).length;
}

export async function adoptLegacyDocs(uid) {
  for (const d of await everything()) {
    if (d.owner) continue;
    d.owner = uid;
    if (!hasIDB) mem.set(d.id, d);
    else await tx('readwrite', s => s.put(d));
  }
}
