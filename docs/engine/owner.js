// 個人資料依帳號分開存放。
//
// 同一台裝置可能有不同同事輪流登入（單位的訓練機、借來的手機）。原本訓練紀錄、偏好、
// 金鑰、理賠客戶、教練對話都存在固定的鍵名——下一位登入的人會直接用上前一位的金鑰、
// 看到前一位的客戶，同步時還會把前一位的訓練紀錄合併進自己的雲端帳號。
// 使用者 2026-10-07 決定：每個帳號各存一份（鍵名後面接「#uid」），上傳的文件也一樣（見 store.js）。
//
// 沒有帳號功能時（firebase-config.js 留空）uid 是 null，維持原本的鍵名，行為與以前完全相同。

export const HISTORY = 'aicoach.history';
export const APIKEY = 'aicoach.apikey';
export const TTSQ = 'aicoach.ttsq';
export const CLIENTS = 'aicoach.clients';
export const PERSONAL = [HISTORY, 'aicoach.prefs', 'aicoach.models', APIKEY, CLIENTS, 'aicoach.chat', TTSQ];

// 有帳號功能、但目前沒有人登入時用的「無主」空間：登出後殘留的寫入不會落進任何人的資料，
// 也不會被誤認成更新前的舊資料。
export const NOBODY = '-';

export const scopedKey = (k, uid) => (uid ? `${k}#${uid}` : k);

// uidFn 每次存取時才呼叫——登入狀態隨時會變，不能在建立時就把 uid 固定下來。
export function scoped(storage, uidFn) {
  return {
    get: k => storage.getItem(scopedKey(k, uidFn())),
    set: (k, v) => storage.setItem(scopedKey(k, uidFn()), v),
    del: k => storage.removeItem(scopedKey(k, uidFn())),
  };
}

const count = (storage, k) => {
  try { const v = JSON.parse(storage.getItem(k) || '[]'); return Array.isArray(v) ? v.length : 0; } catch { return 0; }
};

// 更新前存在固定鍵名、還沒歸屬任何帳號的資料
export function legacyInfo(storage) {
  return {
    any: PERSONAL.some(k => storage.getItem(k) != null),
    records: count(storage, HISTORY),
    clients: count(storage, CLIENTS),
  };
}

// 訓練紀錄用 at 當識別碼取聯集（與 account.js 的 merge 同一個規則）
function unionByAt(a, b) {
  const m = new Map();
  for (const s of [a, b]) {
    let list = [];
    try { list = JSON.parse(s || '[]'); } catch { /* 壞資料當空的 */ }
    for (const r of Array.isArray(list) ? list : []) if (r?.at) m.set(r.at, r);
  }
  return [...m.values()].sort((x, y) => y.at - x.at).slice(0, 50);
}

// 把舊資料歸給某個帳號。
//   withKey：金鑰（以及跟著金鑰的語音額度狀態）要不要一起沿用。只有「確定是同一個人」——
//   更新當下就是他登入著——才沿用；登入後才詢問「這是你的嗎？」時一律不沿用，
//   否則按一下「是」就能拿到別人的金鑰。
// 那個帳號在這台裝置上已經有資料時：訓練紀錄取聯集，其他項目以帳號自己的為準。
export function adoptLegacy(storage, uid, { withKey = false } = {}) {
  for (const k of PERSONAL) {
    const v = storage.getItem(k);
    if (v == null) continue;
    storage.removeItem(k);
    if (!withKey && (k === APIKEY || k === TTSQ)) continue;
    const dst = scopedKey(k, uid), cur = storage.getItem(dst);
    if (cur == null) storage.setItem(dst, v);
    else if (k === HISTORY) storage.setItem(dst, JSON.stringify(unionByAt(cur, v)));
  }
}

// 不認領舊資料時：資料留給原本的人，但金鑰一定拿掉，不能讓下一位登入的人用到
export function dropLegacyKey(storage) {
  storage.removeItem(APIKEY);
  storage.removeItem(TTSQ);
}

// 「這不是我的」答過一次就記住，不要每次登入都問
const declinedKey = uid => `aicoach.legacy.no#${uid}`;
export const declined = (storage, uid) => storage.getItem(declinedKey(uid)) === '1';
export const decline = (storage, uid) => storage.setItem(declinedKey(uid), '1');
