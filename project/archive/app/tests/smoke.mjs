// 平台層冒煙測試：不呼叫模型、不需要金鑰。
//
// 驗證兩件事：
//   1. 所有引擎模組（含 selftest 沒有涵蓋的 api.js）在注入 shim 後都能正常載入。
//   2. **未注入 shim 時，引擎會明確拋錯而不是安靜地壞掉。**
//
// 第 2 項是刻意驗收的。handbook §9.2 第 9 條：「會安靜給錯答案的 bug 最危險」。
// 平台層若在缺少實作時回傳 undefined 而不拋錯，iOS 橋接漏接一個 host function
// 就會變成「某個功能偶爾回空值」——那是最難查的失敗方式。

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => {
  c ? pass++ : fail++;
  console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${extra ? ' → ' + extra : ''}`);
};

// ── 1. 未注入 shim 時必須明確拒絕 ───────────────────────────────
console.log('\n=== 1. 未注入平台實作時的行為 ===');
{
  const P = await import('../engine/platform.js');
  ok(P.isPlatformReady() === false, '初始狀態為「未就緒」');

  let msg = '';
  try { await P.http({ url: 'https://example.com' }); } catch (e) { msg = e.message; }
  ok(/尚未注入平台實作/.test(msg), 'http() 未注入時明確拋錯（而非回傳 undefined）', msg.slice(0, 40));

  msg = '';
  try { await P.store.all(); } catch (e) { msg = e.message; }
  ok(/尚未注入平台實作/.test(msg), 'store.all() 未注入時明確拋錯');

  // 缺任何一項能力都必須被擋下，不能讓 App 跑到某個功能才爆
  msg = '';
  try { P.setPlatform({ http: () => {}, sleep: () => {} }); } catch (e) { msg = e.message; }
  ok(/缺少必要能力/.test(msg), '注入不完整的實作會被拒絕', msg.slice(0, 60));

  msg = '';
  try {
    P.setPlatform({
      http: () => {}, sleep: () => {}, log: () => {}, utf8Decode: () => {},
      base64ToBytes: () => {}, inflateRaw: () => {}, store: { all: () => {}, put: () => {} },
    });
  } catch (e) { msg = e.message; }
  ok(/store 缺少 del, get/.test(msg), 'store 缺少方法時指名是哪幾個', msg.slice(0, 60));
}

// ── 2. 注入 Node shim 後全模組可載入 ───────────────────────────
console.log('\n=== 2. 注入 Node shim 後載入全部引擎模組 ===');
await import('../engine/shims/node.js');
{
  const P = await import('../engine/platform.js');
  ok(P.isPlatformReady() === true, '平台已就緒');
}

const mods = [
  ['api.js', '../engine/api.js', ['api', 'providers', 'restore', 'onModelEvent']],
  ['gateway.js', '../engine/gateway.js', ['PROVIDERS', 'createAdapter', 'friendlyError', 'scrubKey', 'parseJson']],
  ['session.js', '../engine/session.js', ['startSession', 'beginRoleplay', 'handleTurn', 'evaluate', 'getSession']],
  ['advisor.js', '../engine/advisor.js', ['painPoints', 'claimAdvice', 'coachChat']],
  ['knowledge.js', '../engine/knowledge.js', ['ingest', 'listDocs', 'getDoc', 'deleteDoc']],
  ['docx.js', '../engine/docx.js', ['officeText']],
  ['compliance.js', '../engine/compliance.js', ['checkCompliance']],
  ['prompts.js', '../engine/prompts.js', ['personaPrompt', 'difficultyOf', 'scrubMeta', 'scrubBrands']],
];

for (const [name, spec, exports] of mods) {
  try {
    const m = await import(spec);
    const missing = exports.filter(e => m[e] === undefined);
    ok(missing.length === 0, `${name} 載入成功，${exports.length} 個匯出齊全`,
      missing.length ? `缺 ${missing.join(', ')}` : '');
  } catch (e) {
    ok(false, `${name} 載入失敗`, e.message);
  }
}

// ── 3. 平台能力的基本正確性 ─────────────────────────────────────
console.log('\n=== 3. 平台能力基本正確性 ===');
{
  const P = await import('../engine/platform.js');

  const bytes = new Uint8Array([0xE4, 0xB8, 0xAD, 0xE6, 0x96, 0x87]);   // 「中文」的 UTF-8
  ok(P.utf8Decode(bytes) === '中文', 'utf8Decode 正確處理多位元組字元');

  // 「中文」→ base64 為 5Lit5paH
  const b = P.base64ToBytes('5Lit5paH');
  ok(P.utf8Decode(b) === '中文', 'base64ToBytes 與 utf8Decode 可串接');

  const t0 = Date.now();
  await P.sleep(60);
  ok(Date.now() - t0 >= 50, `sleep(60) 實際等待 ${Date.now() - t0}ms`);

  // http() 契約：絕不 throw，只回傳標籤。用保留給文件用途的網域驗證連線失敗路徑。
  const r = await P.http({ url: 'https://invalid.invalid/nope', timeoutMs: 5000 });
  ok(r && typeof r.kind === 'string', 'http() 連不上時仍回傳物件而非拋錯', `kind=${r?.kind}`);
  ok(r.kind === 'network' || r.kind === 'timeout', `連線失敗歸類為 network 或 timeout`, `kind=${r?.kind}`);
}

// ── 4. gateway 錯誤分類（純函式，不呼叫網路）────────────────────
console.log('\n=== 4. 錯誤訊息分類未因重構改變 ===');
{
  const { friendlyError, scrubKey, parseJson } = await import('../engine/gateway.js');

  // _fetch 產生的四種字樣，必須仍被 friendlyError 正確分類
  ok(/金鑰無效/.test(friendlyError('gemini 400: API key not valid', 'gemini')),
    '400 API key not valid → 金鑰無效');
  ok(/餘額不足/.test(friendlyError('openrouter 402: insufficient credits', 'openrouter')),
    '402 → 餘額不足（而非額度用盡）');
  ok(/共用流量/.test(friendlyError('openrouter 429: temporarily rate-limited upstream', 'openrouter')),
    '429 上游限流 → 共用流量說明');
  ok(/額度已用盡/.test(friendlyError('gemini 429: quota exceeded', 'gemini')),
    '429 額度用盡 → 與上游限流分開');
  ok(/沒有回應/.test(friendlyError('gemini timed out after 25000ms', 'gemini')),
    'timed out after Nms → 逾時（重構後 _fetch 仍產生此字樣）');
  ok(/連不上/.test(friendlyError('gemini fetch failed: ENOTFOUND', 'gemini')),
    'fetch failed → 連線問題');
  ok(friendlyError('gemini invalid json response', 'gemini') === null,
    'JSON 解析失敗刻意不被認出，交由 api.js 收斂成通用訊息');
  ok(friendlyError('something totally unknown', 'gemini') === null,
    '認不出來回傳 null（不回原文）');

  ok(scrubKey('key is AIzaSyABCDEFGHIJKLMN oops', null) === 'key is AIza*** oops',
    'scrubKey 洗掉金鑰特徵字串');
  ok(parseJson('```json\n{"a":1}\n```').a === 1, 'parseJson 容錯處理 markdown 圍籬');
}

console.log(`\n———— 通過 ${pass}，失敗 ${fail} ————\n`);
if (fail) process.exitCode = 1;   // 不用 process.exit()，避免 Windows libuv teardown 斷言
