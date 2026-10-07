// 平台實作：Node.js —— 供 tests/selftest.mjs 使用。
//
// 這一份的存在理由：讓 handbook §10.1 的端到端行為驗證（60+ 斷言）
// 在引擎重構後仍然能對「iOS 實際執行的那一份程式碼」跑回歸測試。
// 沒有它，重寫後就沒有任何自動化方式能證明行為沒變。
//
//   import '../engine/shims/node.js';     // ← 必須在其他引擎模組之前
//
// 儲存採記憶體版本：測試不該在開發機留下殘留資料（handbook §9.4 第 18 條）。

import { inflateRawSync } from 'node:zlib';
import { setPlatform } from '../platform.js';

// ── 網路 ────────────────────────────────────────────────────────
// 契約見 platform.js：絕不 throw，只回傳標籤。
async function http({ url, method = 'GET', headers = {}, body = null, timeoutMs = 90000 }) {
  let r;
  try {
    r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // Node 的 undici 與瀏覽器措辭不同（例：'fetch failed'、ENOTFOUND、ECONNREFUSED），
    // 但必須回報同樣的標籤，上層的分類邏輯才能三平台共用一份。
    const name = e?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout', timeoutMs };
    // undici 把真正原因塞在 cause 裡，訊息本身只有無用的 'fetch failed'
    const detail = e?.cause?.message || e?.message || String(e);
    return { kind: 'network', detail };
  }

  let text = '';
  try { text = await r.text(); } catch (e) { return { kind: 'network', detail: `讀取回應失敗：${e?.message || e}` }; }
  return { kind: r.ok ? 'ok' : 'http', status: r.status, text };
}

// ── 時間 ────────────────────────────────────────────────────────
// ⚠️ 不要在這裡加 .unref()。unref 過的計時器不維持事件迴圈，
// Node 會在它觸發前就退出，於是 sleep() 的 promise 永遠不會 settle
// （表現為「重試退避時整支測試無聲卡死」）。
// 原版引擎裡有 unref 的是 session.js 的背景清理 setInterval——那是週期性計時器，
// 本來就不該讓行程活著；sleep 是必須完成的等待，用途完全相反。
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 日誌 ────────────────────────────────────────────────────────
function log(level, message) {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

// ── 位元組與編碼 ────────────────────────────────────────────────
const utf8Decode = bytes => new TextDecoder('utf-8').decode(bytes);
const base64ToBytes = b64 => new Uint8Array(Buffer.from(b64, 'base64'));

// zlib 是 Node 內建，比繞 Blob/Response/DecompressionStream 直接且不需 await
const inflateRaw = async bytes => new Uint8Array(inflateRawSync(bytes));

// ── 儲存：記憶體 ────────────────────────────────────────────────
const mem = new Map();
const store = {
  all: async () => [...mem.values()],
  put: async doc => { mem.set(doc.id, doc); },
  del: async id => { mem.delete(id); },
  get: async id => mem.get(id) || null,
};

setPlatform({ http, sleep, log, utf8Decode, base64ToBytes, inflateRaw, store });
