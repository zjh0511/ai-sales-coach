// 來源與裝置統計（使用者 2026-10-22 決定，D049）。
//
// 目的：App 公開到 YouTube 後，要用真實數據決定「要不要上架商店、先上 App Store 還是 Play」。
// 所以只記兩件事——從哪條連結來的、用什麼裝置——存在使用者自己的雲端資料
// （/users/<uid>/meta，安全規則與訓練紀錄相同：只有本人讀寫得到；報表只有專案擁有者跑得動）。
//
// 刻意不記：IP、瀏覽器指紋、精確時間（只記到「日」）、對話內容、客戶資料、金鑰、文件。
// 隱私說明見 privacy.html——這裡的欄位有變，那一頁要一起改。

export const SRC_KEY = 'aicoach.src';          // 這台裝置第一次帶著 ?src= 進來的紀錄（還沒歸給任何帳號）
export const META_KEY = 'aicoach.meta';        // 個人的統計（依帳號分開，見 owner.js）
const SRC_RE = /^[a-z0-9-]{1,32}$/;            // 只收英文小寫、數字、減號——網址參數可以被任何人亂塞

export const today = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 裝置分類。iPadOS 13 之後 UA 自稱 Mac，只能靠觸控點數分辨（與 app.js 的 platform() 同一套判斷）。
export function deviceOf(ua = '', platform = '', touchPoints = 0) {
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (platform === 'MacIntel' && touchPoints > 1)) return 'ipad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'android-phone' : 'android-tablet';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  return 'other';
}
export const DEVICE_NAMES = {
  iphone: 'iPhone', ipad: 'iPad', 'android-phone': 'Android 手機', 'android-tablet': 'Android 平板',
  windows: 'Windows 電腦', mac: 'Mac', other: '其他',
};

// 網址帶 ?src= 進來時：記在這台裝置上（很多人會先「加到主畫面」才註冊，
// 從桌面圖示打開時網址上的來源已經不在了），然後把它從網址拿掉——
// 使用者再分享這個網址時，不會把來源一起傳出去。
// 只記第一次（first touch）：同一台裝置後來又從別的連結進來，不覆蓋。
// 回傳拿掉 src 之後的網址；網址上本來就沒有 src 時回傳 null。
export function captureSrc(href, storage, now = Date.now()) {
  const u = new URL(href);
  if (!u.searchParams.has('src')) return null;
  const src = (u.searchParams.get('src') || '').trim().toLowerCase();
  u.searchParams.delete('src');
  if (SRC_RE.test(src) && !storage.getItem(SRC_KEY)) {
    try { storage.setItem(SRC_KEY, JSON.stringify({ src, at: today(now) })); } catch { /* 無痕模式 */ }
  }
  return u.pathname + (u.search || '') + u.hash;
}

export function pendingSrc(storage) {
  try { const v = JSON.parse(storage.getItem(SRC_KEY) || 'null'); return v && SRC_RE.test(v.src) ? v : null; }
  catch { return null; }
}

// 登入中的人在這台裝置上用了 App：更新他的統計。
// 回傳 { meta, changed }——同一天同一台裝置重複打開不算變動，不用每次都同步。
export function touch(meta, { device, home, src, now = Date.now() }) {
  const m = { src: meta?.src || '', srcAt: meta?.srcAt || '', devices: { ...(meta?.devices || {}) } };
  const d = today(now);
  let changed = false;
  if (!m.src && src?.src) { m.src = src.src; m.srcAt = src.at; changed = true; }
  const cur = m.devices[device];
  const next = { first: cur?.first || d, last: d, home: !!(cur?.home || home) };
  if (!cur || cur.last !== next.last || cur.home !== next.home) changed = true;
  m.devices[device] = next;
  return { meta: m, changed };
}

// 兩台裝置的統計合併（雲端同步用）：
//   首次來源：比較早的那一筆贏（同一天就保留已在雲端的）；裝置：取聯集，first 取早、last 取晚、home 任一為真。
export function mergeMeta(local, remote) {
  const a = local || {}, b = remote || {};
  const pick = !b.src ? a : !a.src ? b : (a.srcAt && b.srcAt && a.srcAt < b.srcAt ? a : b);
  const devices = {};
  for (const src of [b.devices || {}, a.devices || {}]) {
    for (const [k, v] of Object.entries(src)) {
      if (!v || typeof v !== 'object') continue;
      const c = devices[k];
      devices[k] = !c ? { first: v.first || '', last: v.last || '', home: !!v.home } : {
        first: [c.first, v.first].filter(Boolean).sort()[0] || '',
        last: [c.last, v.last].filter(Boolean).sort().at(-1) || '',
        home: !!(c.home || v.home),
      };
    }
  }
  return { src: pick.src || '', srcAt: pick.srcAt || '', devices };
}
