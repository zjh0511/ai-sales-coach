// 平台實作：瀏覽器。
// 匯入本模組即完成注入，之後才能使用 engine/*.js。
//
//   import './engine/shims/web.js';       // ← 必須在其他引擎模組之前
//   import { api } from './engine/api.js';
//
// 這一份對應 iOS 上由 Swift 提供的 host functions（見 12_NATIVE_APP_DEV_PLAN.md §3.1）。
// 兩邊必須實作完全相同的契約，尤其是 http() 的四種標籤。

import { setPlatform } from '../platform.js';

// ── 網路 ────────────────────────────────────────────────────────
// 契約見 platform.js：絕不 throw，只回傳標籤。
async function http({ url, method = 'GET', headers = {}, body = null, timeoutMs = 90000 }) {
  let r;
  try {
    r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // AbortSignal.timeout() 拋的是 DOMException，name 為 'TimeoutError'，
    // 但訊息是「aborted due to timeout」——不含「timed out」。
    // 這正是 handbook §4.4 第一條 bug 的來源，所以這裡只看 name，不看訊息文字。
    // 本模組只使用逾時訊號，因此任何 abort 都必然是逾時。
    const name = e?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', timeoutMs };
    return { kind: 'network', detail: e?.message || String(e) };
  }

  let text = '';
  try { text = await r.text(); } catch (e) { return { kind: 'network', detail: `讀取回應失敗：${e?.message || e}` }; }
  return { kind: r.ok ? 'ok' : 'http', status: r.status, text };
}

// ── 時間 ────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 日誌 ────────────────────────────────────────────────────────
function log(level, message) {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

// ── 位元組與編碼 ────────────────────────────────────────────────
const utf8Decode = bytes => new TextDecoder('utf-8').decode(bytes);
const base64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// raw deflate 解壓（docx / pptx 內部的壓縮方式）
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ── 儲存：IndexedDB ─────────────────────────────────────────────
// 可存數十 MB，且資料永遠留在使用者自己的裝置上。
// 對應 iOS 的 SwiftData（handbook §5：store.js 需重寫，這裡把它隔離成一份 shim）。
const DB = 'aicoach', STORE = 'docs';
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

const store = {
  all: async () => (await tx('readonly', s => s.getAll())) || [],
  put: async doc => { await tx('readwrite', s => s.put(doc)); },
  del: async id => { await tx('readwrite', s => s.delete(id)); },
  get: async id => (await tx('readonly', s => s.get(id))) || null,
};

setPlatform({ http, sleep, log, utf8Decode, base64ToBytes, inflateRaw, store });
