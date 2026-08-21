// 帳號與雲端同步。
//
// 刻意不用 Firebase SDK——全部走 REST，維持整個專案零 node_modules。
// 唯一的外部腳本相依是 Google 與 Apple 的官方登入元件，而且都是「按下去才載入」。
//
// 同步範圍是刻意收窄的（使用者決定）：只有訓練紀錄與偏好設定。
// **API 金鑰與上傳的教材／條款一律不上雲端**，只留在這台裝置。
import { FB } from '../firebase-config.js';

const IDP = 'https://identitytoolkit.googleapis.com/v1/accounts:';
const TOKEN = 'https://securetoken.googleapis.com/v1/token';
const ACCT = 'aicoach.acct';

export const configured = () => !!(FB.apiKey && FB.dbUrl);
export const appleReady = () => !!(FB.apple && FB.appleClientId);
export const googleReady = () => !!FB.googleClientId;

// 在 Node 底下沒有 localStorage。留一個空殼讓這個模組仍然 import 得進來，
// selftest 才測得到 merge()——那是唯一會弄丟使用者資料的地方。
const LSS = typeof localStorage !== 'undefined' ? localStorage
  : { getItem: () => null, setItem() {}, removeItem() {} };

let A = null;   // { uid, email, name, photo, idToken, refreshToken, expAt }
try { A = JSON.parse(LSS.getItem(ACCT) || 'null'); } catch { /* 壞資料當沒登入 */ }

const save = () => A ? LSS.setItem(ACCT, JSON.stringify(A)) : LSS.removeItem(ACCT);
export const user = () => A && { uid: A.uid, email: A.email, name: A.name, photo: A.photo };

// Firebase 的錯誤碼直接給使用者看是災難（EMAIL_EXISTS、INVALID_LOGIN_CREDENTIALS…），
// 一律翻成「看完知道下一步該做什麼」的中文。
const ERR = {
  EMAIL_EXISTS: '這個 E-mail 已經註冊過了，直接登入就好',
  EMAIL_NOT_FOUND: '查不到這個 E-mail，需要先註冊',
  INVALID_PASSWORD: 'E-mail 或密碼不對',
  INVALID_LOGIN_CREDENTIALS: 'E-mail 或密碼不對',
  INVALID_EMAIL: 'E-mail 的格式看起來不對',
  MISSING_PASSWORD: '請輸入密碼',
  MISSING_EMAIL: '請輸入 E-mail',
  WEAK_PASSWORD: '密碼至少要 6 個字',
  TOO_MANY_ATTEMPTS_TRY_LATER: '嘗試太多次了，請等幾分鐘再試',
  OPERATION_NOT_ALLOWED: '這個登入方式還沒在 Firebase 後台開啟',
  USER_DISABLED: '這個帳號已被停用',
};
const friendly = m => {
  for (const k in ERR) if (m.startsWith(k)) return ERR[k];
  return '登入失敗：' + m;
};

async function idp(path, body) {
  let r;
  try {
    r = await fetch(IDP + path + '?key=' + FB.apiKey, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch { throw new Error('連不上 Firebase，請確認網路'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(friendly(j.error?.message || 'HTTP ' + r.status));
  return j;
}

function adopt(j) {
  A = {
    uid: j.localId || j.user_id,
    email: j.email || '',
    name: j.displayName || (j.email || '').split('@')[0] || '夥伴',
    photo: j.photoUrl || '',
    idToken: j.idToken || j.id_token,
    refreshToken: j.refreshToken || j.refresh_token,
    expAt: Date.now() + (Number(j.expiresIn || j.expires_in || 3600) - 60) * 1000,
  };
  save();
  return user();
}

// 取一把還沒過期的 idToken；過期就用 refreshToken 換新的。
// Firebase 的 idToken 只有一小時，不換就會在使用者練到一半時同步失敗。
export async function token() {
  if (!A) return null;
  if (Date.now() < A.expAt) return A.idToken;
  let j = null;
  try {
    const r = await fetch(TOKEN + '?key=' + FB.apiKey, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(A.refreshToken),
    });
    if (r.ok) j = await r.json();
  } catch { /* 沒網路：當作這次拿不到 token，本機功能照用 */ }
  if (!j?.id_token) return null;
  A.idToken = j.id_token;
  A.refreshToken = j.refresh_token || A.refreshToken;
  A.expAt = Date.now() + (Number(j.expires_in || 3600) - 60) * 1000;
  save();
  return A.idToken;
}

export const signUpEmail = (email, password) =>
  idp('signUp', { email, password, returnSecureToken: true }).then(adopt);
export const signInEmail = (email, password) =>
  idp('signInWithPassword', { email, password, returnSecureToken: true }).then(adopt);
export const resetEmail = email =>
  idp('sendOobCode', { requestType: 'PASSWORD_RESET', email }).then(() => true);
export function signOut() { A = null; save(); }

// ── 外部登入元件：按下去才載入 ──────────────────────────────
const loaded = {};
const loadScript = src => loaded[src] ||= new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.async = true;
  s.onload = res;
  s.onerror = () => { loaded[src] = null; rej(new Error('載入登入元件失敗，請確認網路')); };
  document.head.append(s);
});

// Google：用官方 GIS 按鈕。自己刻 OAuth 也做得到（oauth.js 已經有 PKCE），
// 但 Google 對純前端取 id_token 的規定變動頻繁，用官方元件最不容易在
// 某次政策調整後突然壞掉——這是刻意付出的一個外部相依。
export async function googleButton(box, onDone) {
  if (!googleReady()) return false;
  await loadScript('https://accounts.google.com/gsi/client');
  google.accounts.id.initialize({
    client_id: FB.googleClientId,
    callback: async ({ credential }) => {
      try {
        onDone(null, adopt(await idp('signInWithIdp', {
          postBody: 'id_token=' + credential + '&providerId=google.com',
          requestUri: location.origin, returnIdpCredential: true, returnSecureToken: true,
        })));
      } catch (e) { onDone(e); }
    },
  });
  google.accounts.id.renderButton(box, {
    theme: 'filled_blue', size: 'large', shape: 'pill',
    text: 'continue_with', locale: 'zh_TW',
    width: Math.min(Math.max(box.clientWidth || 320, 200), 400),
  });
  return true;
}

// Apple：用 Apple 官方的 Sign in with Apple JS，popup 模式，全程在瀏覽器完成。
//
// ⚠️ 這條路我無法測試——申請 Services ID 需要付費的 Apple Developer 帳號。
// 程式碼依 Apple 與 Firebase 的文件撰寫，預設關閉（firebase-config.js 的 apple: false），
// 所以就算有錯也不會影響任何現有功能。啟用時請先確認 nonce 的處理：
// Apple 端與 Firebase 端必須看到「同一個」nonce，這一點各家文件寫法不一致。
export async function signInApple() {
  if (!appleReady()) throw new Error('Apple 登入尚未設定');
  await loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  AppleID.auth.init({
    clientId: FB.appleClientId, scope: 'name email',
    redirectURI: location.origin + location.pathname,
    usePopup: true, nonce,
  });
  const r = await AppleID.auth.signIn();
  const t = r?.authorization?.id_token;
  if (!t) throw new Error('Apple 沒有回傳憑證');
  return adopt(await idp('signInWithIdp', {
    postBody: 'id_token=' + t + '&providerId=apple.com&nonce=' + nonce,
    requestUri: location.origin, returnIdpCredential: true, returnSecureToken: true,
  }));
}

// ── 同步：Realtime Database REST ───────────────────────────
// 用 Realtime Database 而不是 Firestore：REST 進出都是純 JSON。
// Firestore 的 REST 要包 stringValue／arrayValue 這種型別外殼，
// 同樣的功能程式碼會多一倍，而我們要存的東西本來就只是一包 JSON。
async function dbUrl() {
  const t = await token();
  return t && FB.dbUrl.replace(/\/+$/, '') + '/users/' + A.uid + '.json?auth=' + t;
}

export async function pull() {
  const u = await dbUrl(); if (!u) return null;
  const r = await fetch(u);
  if (r.status === 401 || r.status === 403) throw new Error('雲端拒絕存取，請確認 Realtime Database 的安全規則');
  if (!r.ok) throw new Error('讀取雲端資料失敗（HTTP ' + r.status + '）');
  return (await r.json()) || {};
}

export async function push(data) {
  const u = await dbUrl(); if (!u) return false;
  const r = await fetch(u, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error('寫入雲端資料失敗（HTTP ' + r.status + '）');
  return true;
}

// 合併規則刻意簡單，但兩邊都不會弄丟東西：
// - 訓練紀錄用 at（時間戳）當識別碼取「聯集」。用覆蓋的話，
//   在手機練完、電腦一開就會把手機那幾筆整批蓋掉。
// - 偏好設定比 updatedAt，晚的贏。同一個人不會真的同時在兩台裝置改設定。
export function merge(local, remote) {
  const byAt = new Map();
  for (const r of [...(remote?.history || []), ...(local?.history || [])]) if (r?.at) byAt.set(r.at, r);
  const lp = local?.prefs || {}, rp = remote?.prefs || {};
  return {
    history: [...byAt.values()].sort((a, b) => b.at - a.at).slice(0, 100),
    prefs: (lp.updatedAt || 0) >= (rp.updatedAt || 0) ? lp : rp,
  };
}
