// Platform Capability Layer — 引擎唯一的 I/O 出入口。
//
// 為什麼需要這一層：
//   JavaScriptCore（iOS 用來執行本引擎的環境）只提供 ECMAScript 標準內建物件，
//   **完全沒有任何 Web API** —— 沒有 fetch、setTimeout、TextDecoder、console、
//   indexedDB、DecompressionStream。若引擎直接呼叫這些，在 iOS 上會全數失敗。
//
// 因此：engine/*.js 一律不得直接使用任何 Web API，全部經由本模組。
//   宿主環境（瀏覽器 / Node / iOS Swift）在引擎執行前呼叫 setPlatform() 注入實作。
//
// 對應 handbook §2.3「Model Gateway 抽象」的同一個原則往下推一層：
//   上層完全不知道背後是瀏覽器、Node 還是 Swift。
//
// ⚠️ 本模組不得 import 任何其他引擎模組，以免產生循環相依。

let impl = null;

// 宿主必須提供的能力。缺任何一項就拒絕啟動——
// 「安靜地少一個能力」會變成執行到某個功能才爆掉，那是最難查的失敗方式。
const REQUIRED = [
  'http',           // (req) → Promise<Result>   網路請求，絕不 throw，見下方契約
  'sleep',          // (ms) → Promise<void>      重試退避用
  'log',            // (level, message) → void   level: 'warn' | 'error' | 'info'
  'utf8Decode',     // (Uint8Array) → string
  'base64ToBytes',  // (string) → Uint8Array
  'inflateRaw',     // (Uint8Array) → Promise<Uint8Array>   raw deflate 解壓（docx/pptx）
  'store',          // { all, put, del, get }    文件持久化
];

const STORE_REQUIRED = ['all', 'put', 'del', 'get'];

export function setPlatform(p) {
  if (!p || typeof p !== 'object') throw new Error('platform: 沒有收到實作');
  const missing = REQUIRED.filter(k => typeof p[k] !== (k === 'store' ? 'object' : 'function'));
  if (missing.length) throw new Error(`platform: 缺少必要能力 ${missing.join(', ')}`);
  const badStore = STORE_REQUIRED.filter(k => typeof p.store[k] !== 'function');
  if (badStore.length) throw new Error(`platform: store 缺少 ${badStore.join(', ')}`);
  impl = p;
  return impl;
}

export const isPlatformReady = () => !!impl;

function need() {
  if (!impl) {
    throw new Error(
      'platform: 尚未注入平台實作。'
      + '瀏覽器請先 import engine/shims/web.js，Node 請先 import engine/shims/node.js，'
      + 'iOS 請在建立 JSContext 後由 Swift 注入。'
    );
  }
  return impl;
}

// ── 網路 ────────────────────────────────────────────────────────
//
// 契約：http() **絕不 throw**，一律回傳帶標籤的結果物件。
//
//   { kind: 'ok',      status, text }        2xx
//   { kind: 'http',    status, text }        非 2xx（text 為回應內容，供上層取錯誤碼）
//   { kind: 'timeout', timeoutMs }           逾時
//   { kind: 'network', detail }              連不上、DNS 失敗、憑證問題等
//
// 為什麼是「回傳標籤」而不是「拋出錯誤」：
//   handbook §4.4 記錄了三次同類型 bug —— 用錯誤訊息的文字內容來分類錯誤。
//   例：`AbortSignal.timeout()` 的訊息是「aborted due to timeout」，不含「timed out」，
//   於是逾時被誤判成一般錯誤。§9.2 第 6 條明寫「這個坑我踩了三次」。
//
//   把分類責任從「上層猜措辭」改成「下層回報型別」，
//   誤判就從「很容易發生」變成「結構上不可能發生」：
//   shim 沒辦法「忘記某個關鍵字」，它只能在四個標籤中挑一個。
//
//   三個平台（URLSession / 瀏覽器 fetch / Node fetch）的錯誤措辭完全不同，
//   但都必須回報同樣的四種標籤。上層的分類邏輯因此三平台共用同一份。
//
// req: { url, method = 'GET', headers = {}, body = null, timeoutMs = 90000 }
export function http(req) {
  return need().http(req);
}

// ── 時間 ────────────────────────────────────────────────────────
export const sleep = ms => need().sleep(ms);

// ── 日誌 ────────────────────────────────────────────────────────
// 注意：不得記錄任何可能含金鑰或客戶個資的內容。
// 呼叫端有義務先經過 gateway.scrubKey()。
export function log(level, message) {
  try { need().log(level, String(message)); } catch { /* 日誌失敗不該影響主流程 */ }
}
export const warn = m => log('warn', m);
export const error = m => log('error', m);

// ── 位元組與編碼 ────────────────────────────────────────────────
export const utf8Decode = bytes => need().utf8Decode(bytes);
export const base64ToBytes = b64 => need().base64ToBytes(b64);
export const inflateRaw = bytes => need().inflateRaw(bytes);

// ── 儲存 ────────────────────────────────────────────────────────
// 文件知識庫的持久化。資料一律留在使用者自己的裝置（規格 §38 Local-first）。
//   all()      → Promise<doc[]>
//   put(doc)   → Promise<void>     以 doc.id 為主鍵，存在則覆寫
//   del(id)    → Promise<void>
//   get(id)    → Promise<doc|null>
export const store = {
  all: () => need().store.all(),
  put: doc => need().store.put(doc),
  del: id => need().store.del(id),
  get: id => need().store.get(id),
};
