const encoder = new TextEncoder();
export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function assert(ok, code, message, status = 400) { if (!ok) throw new AppError(code, message, status); }
export const bytes64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const from64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
export function randomSecret() { return bytes64(crypto.getRandomValues(new Uint8Array(32))); }
export async function encrypt(secret, value, context) {
  const key = await crypto.subtle.importKey('raw', from64(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(JSON.stringify(value)));
  return { version: 1, iv: bytes64(iv), ciphertext: bytes64(ciphertext) };
}
export async function decrypt(secret, sealed, context) {
  assert(sealed.version === 1, 'VAULT_VERSION', '金鑰版本無法讀取，請重新設定。');
  const key = await crypto.subtle.importKey('raw', from64(secret), 'AES-GCM', false, ['decrypt']);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(sealed.iv), additionalData: encoder.encode(context) }, key, from64(sealed.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function fingerprint(secret, uid, value) {
  const key = await crypto.subtle.importKey('raw', from64(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return bytes64(await crypto.subtle.sign('HMAC', key, encoder.encode(uid + '\0' + value)));
}
export function privacyIssues(value) {
  const s = String(value || '').normalize('NFKC');
  const checks = [
    [/\b[A-Z][12]\d{8}\b/i, '身分證字號'],
    [/09[\d\s-]{8,12}/, '手機號碼'],
    [/(?:\+886[-\s]?|0[2-8][-\s]?)[\d-]{7,10}/, '電話號碼'],
    [/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, '電子郵件'],
    [/(?:姓名|客戶叫|名字是|名叫|聯絡人)\s*[:：為是]?\s*[\p{L}]{2,}/u, '真實姓名'],
    [/[\p{Script=Han}]{2,}(?:路|街|大道)[\p{Script=Han}\d段巷弄-]{0,16}\d+號/u, '詳細地址'],
    [/(?:保單號碼|帳號|身分證|身份證|病歷號)\s*[:：]?\s*[a-z\d-]{5,}/i, '識別號碼'],
    [/(?:AIza[\w-]{25,}|sk-or-v1-[\w-]+|gsk_[\w-]{15,})/, 'API Key'],
    [/data:image|<img\b|base64,/i, '圖片資料'],
  ];
  return checks.filter(([pattern]) => pattern.test(s)).map(([, label]) => label);
}
export function safeText(value, max = 1800) {
  assert(typeof value === 'string' && value.trim().length <= max, 'INPUT', `請輸入 ${max} 字以內的文字。`);
  const text = value.trim();
  const issues = privacyIssues(text);
  assert(!issues.length, 'PRIVACY', `請移除${issues.join('、')}，改用概括背景。`);
  return text;
}
export function customerInput(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'INPUT', '請填寫客戶概括資料。');
  assert(Object.keys(value).every(k => ['gender', 'age', 'background'].includes(k)), 'PRIVACY', '客戶資料只接受性別、年齡及概括背景。');
  const customer = { gender: safeText(value.gender || '未提供', 20), age: safeText(value.age || '未提供', 30), background: safeText(value.background || '', 1200) };
  assert(customer.background || customer.age !== '未提供', 'INPUT', '請至少提供年齡或一點概括背景。');
  return customer;
}
export async function fetchChecked(url, options = {}, timeout = 25000, retry = 0) {
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try { response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' }); }
  catch (error) {
    console.error('Upstream fetch failed', new URL(url).hostname, error?.name || 'Error', error?.message || 'unknown');
    throw new AppError('NETWORK', '外部服務連線失敗，請稍後重試。', 503);
  }
  finally { clearTimeout(timer); }
  if (response.status >= 300 && response.status < 400) throw new AppError('NETWORK', '外部服務連線失敗，請稍後重試。', 503);
  if (!response.ok) {
    const code = response.status;
    let body;try{body=await response.json();}catch{}
    const delay=Number(response.headers.get('retry-after'));
    if(code===429 && !retry && new URL(url).hostname==='api.groq.com' && delay>0 && delay<=2 && !/request too large/i.test(String(body?.error?.message||''))) {
      await new Promise(resolve=>setTimeout(resolve,Math.ceil(delay)*1000+250));
      return fetchChecked(url,options,timeout,1);
    }
    throw providerError(code, body, response.headers, new URL(url).hostname);
  }
  return response;
}
export function providerError(status, body, headers = new Headers(), host = '') {
  // Inspect provider text for categories, but never echo keys, prompts or raw responses.
  const detail=String(body?.error?.message||'')+' '+String(body?.error?.metadata?.raw||'');
  const provider=host.includes('groq')?'Groq':host.includes('google')?'Google':host.includes('openrouter')?'OpenRouter':'外部平台';
  if(status===429) {
    if(/upstream|provider.*(?:capacity|overload)|temporarily.*rate.limit/i.test(detail))return new AppError('RATE_LIMIT',`${provider} 的模型供應端目前忙碌或限流（429），不是判定你今天的額度已用完。請稍後重試，或在設定手動選擇另一個免費模型。`,429);
    if(/request too large/i.test(detail))return new AppError('RATE_LIMIT',`${provider} 回報單次請求文字量超過模型限制（429），即使今天尚未使用也可能發生。請縮短背景或改用另一個免費模型；不是每日額度用完。`,429);
    const seconds=Number(headers.get('retry-after'));
    const wait=Number.isFinite(seconds)&&seconds>0?`建議 ${Math.ceil(seconds)} 秒後重試。`:'';
    const kind=/tokens per minute|\btpm\b|request too large|too many tokens/i.test(detail)?'本次文字量或每分鐘 Token 限制':/requests per minute|\brpm\b/i.test(detail)?'每分鐘請求速度限制':/per day|daily|\brpd\b|\btpd\b/i.test(detail)?'每日用量限制':'用量或請求速度限制';
    return new AppError('RATE_LIMIT',`${provider} 回報 ${kind}（429），不代表 Key 輸入錯誤，也不能僅憑此判定免費額度已用完。${wait}請稍後重試或縮短情境；不會自動轉付費。`,429);
  }
  if(status===401 || /API_KEY_INVALID|API key not valid|invalid api key/i.test(detail))return new AppError('PROVIDER_AUTH',`${provider} 未接受這把 Key（${status}）。請確認完整複製、平台選擇及 Key 是否仍有效。`,502);
  if(status===403)return new AppError('PROVIDER_PERMISSION',`${provider} 拒絕此請求（403），可能是專案權限、API 啟用狀態或金鑰限制；不是輸入格式判定。Google 使用者請確認 AI Studio 的授權金鑰與 Gemini API 權限。`,502);
  return new AppError('PROVIDER_ERROR',`${provider} 無法完成請求（${status}）。${status===400?'請求或模型設定不相容，並不一定是 Key 錯誤。':'請稍後重試。'}`,502);
}
