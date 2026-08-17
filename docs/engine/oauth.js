// OpenRouter OAuth（PKCE）— 讓使用者按一下登入，不必手動複製貼上金鑰。
//
// PKCE 是專門設計給「沒有伺服器的網頁 App」的流程：
// 用一次性亂數（code_verifier）取代 client secret，全程在瀏覽器完成。
//
// 註：其他服務商目前無法這樣做——
// ChatGPT 的登入端點雖然允許瀏覽器呼叫，但拿到 token 之後真正要用的推論端點擋 CORS；
// NVIDIA 則是整個 API 都不允許瀏覽器直連。兩者都需要自架伺服器代轉。

const AUTH = 'https://openrouter.ai/auth';
const EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys';
const VERIFIER = 'aicoach.or_verifier';

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(48)));

async function challengeOf(verifier) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// 回到本頁的網址（不含查詢字串），OpenRouter 會導回這裡
const callbackUrl = () => location.origin + location.pathname;

export function oauthSupported() {
  return !!(window.crypto?.subtle && window.isSecureContext);
}

// 導向 OpenRouter 授權頁
export async function startOpenRouter() {
  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER, verifier);
  const url = new URL(AUTH);
  url.searchParams.set('callback_url', callbackUrl());
  url.searchParams.set('code_challenge', await challengeOf(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  location.href = url.toString();
}

// 授權後被導回本頁時呼叫；沒有 code 就回傳 null
export async function finishOpenRouter() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return null;

  const verifier = sessionStorage.getItem(VERIFIER);
  sessionStorage.removeItem(VERIFIER);
  // 立刻把 code 從網址移除，避免被記錄在瀏覽紀錄裡
  history.replaceState({}, '', callbackUrl());
  if (!verifier) throw new Error('授權流程已過期，請再按一次登入');

  const r = await fetch(EXCHANGE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.key) throw new Error(j.error?.message || j.message || 'OpenRouter 授權失敗，請改用貼上金鑰的方式');
  return j.key;
}
