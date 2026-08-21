// 把成員與演練報表寫進一張 Google Sheet。設計成本機與 GitHub Actions 都能跑。
//
//   本機測試：
//     SA_KEY_FILE="C:/path/to/serviceAccount.json" SHEET_ID="1AbC..." node tools/report-sheet.mjs
//   GitHub Actions：
//     GOOGLE_SA_KEY（整份 JSON 字串）＋ SHEET_ID 兩個 secret
//
// 為什麼用服務帳戶而不是 firebase CLI 的憑證：CLI 憑證綁在某台電腦上，
// 雲端跑不到。服務帳戶是專案自己的身分，可以放在 CI 的 secret 裡。
//
// 零外部相依：JWT 用 node:crypto 自己簽，HTTP 用內建 fetch。
//
// ⚠️ 這份報表包含同事的演練評分與教練回饋，是個人表現資料。
//    Sheet 的共用權限請自己控管；服務帳戶金鑰洩漏等於整個專案的資料外洩。
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY = process.env.GOOGLE_SA_KEY
  ? JSON.parse(process.env.GOOGLE_SA_KEY)
  : JSON.parse(fs.readFileSync(process.env.SA_KEY_FILE || (() => {
      console.error('請設定 GOOGLE_SA_KEY（JSON 內容）或 SA_KEY_FILE（JSON 檔路徑）');
      process.exit(1);
    })(), 'utf8'));

const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) { console.error('請設定 SHEET_ID'); process.exit(1); }

const PROJECT = KEY.project_id;
const DB = process.env.DB_URL || `https://${PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`;

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',      // Identity Toolkit 管理 API
  'https://www.googleapis.com/auth/firebase.database',   // 讀 Realtime Database
  'https://www.googleapis.com/auth/userinfo.email',      // RTDB 要求一併帶著
  'https://www.googleapis.com/auth/spreadsheets',        // 寫 Sheet
].join(' ');

// ── 服務帳戶 → access token（自己簽 RS256 JWT，不用任何套件）─────
const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
  .toString('base64url');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: KEY.client_email, scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  };
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claim)}`;
  const sig = crypto.createSign('RSA-SHA256').update(body).end()
    .sign(KEY.private_key).toString('base64url');

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${body}.${sig}`,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('取得 access token 失敗：' + JSON.stringify(j).slice(0, 300));
  return j.access_token;
}

const TOKEN = await accessToken();
const api = async (url, init = {}) => {
  const r = await fetch(url, {
    ...init,
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...init.headers },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${url.split('?')[0]} → ${r.status}\n${t.slice(0, 400)}`);
  return t ? JSON.parse(t) : {};
};

// ── 取資料 ──────────────────────────────────────────────────
const accounts = [];
let pageToken = '';
do {
  const q = new URLSearchParams({ maxResults: '500', ...(pageToken ? { nextPageToken: pageToken } : {}) });
  const j = await api(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet?${q}`);
  accounts.push(...(j.users || []));
  pageToken = j.nextPageToken || '';
} while (pageToken);

const cloud = await api(`${DB}/users.json`) || {};

// ── 表格 ────────────────────────────────────────────────────
const NAMES = {
  fluency: '流暢度', friendliness: '親和力',
  professionalism: '專業度', confidence: '自信度', awareness: '需求敏感度',
};
const MODE = { call: '電話邀約', needs: '發掘需求', product: '商品行銷' };

// GitHub 的機器是 UTC。時間一定要明確指定台北，不然報表上的「最後登入」會差 8 小時。
const TZ = 'Asia/Taipei';
const when = ms => {
  const n = Number(ms);
  if (!n) return '';
  const p = new Intl.DateTimeFormat('zh-TW', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(n)).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : '';

const known = new Set(accounts.map(a => a.localId));
const orphans = Object.keys(cloud).filter(u => !known.has(u));

const summary = [[
  '姓名', 'E-mail', '登入方式', '註冊時間', '最後登入',
  '演練次數', '最後演練', '平均星等', ...Object.values(NAMES),
  '最常練的模式', '目前難度', '指定模型',
]];
const detail = [[
  '姓名', 'E-mail', '演練時間', '模式', '客戶',
  ...Object.values(NAMES), '本次平均', '教練總結', '下次挑戰',
]];

for (const a of accounts) {
  const h = cloud[a.localId]?.history || [];
  const prefs = cloud[a.localId]?.prefs || {};
  const all = h.flatMap(x => Object.values(x.scores || {})).filter(n => typeof n === 'number');
  const modes = {};
  for (const x of h) {
    const m = x.modeName || MODE[x.mode] || x.mode;
    modes[m] = (modes[m] || 0) + 1;
  }
  const top = Object.entries(modes).sort((x, y) => y[1] - x[1])[0];
  const name = a.displayName || (a.email || '').split('@')[0];

  summary.push([
    name, a.email, a.providerUserInfo?.[0]?.providerId === 'google.com' ? 'Google' : 'E-mail',
    when(a.createdAt), when(a.lastLoginAt || a.lastSignedInAt),
    h.length, when(h[0]?.at), avg(all),
    ...Object.keys(NAMES).map(k => avg(h.map(x => x.scores?.[k]).filter(n => typeof n === 'number'))),
    top ? `${top[0]}（${top[1]} 次）` : '', prefs.diff || '',
    String(prefs.models || '').replace(/^"|"$/g, ''),
  ]);

  for (const x of h) {
    detail.push([
      name, a.email, when(x.at), x.modeName || MODE[x.mode] || x.mode, x.name,
      ...Object.keys(NAMES).map(k => x.scores?.[k] ?? ''),
      avg(Object.values(x.scores || {}).filter(n => typeof n === 'number')),
      x.summary, x.next,
    ]);
  }
}
detail.sort((a, b) => a === detail[0] ? -1 : b === detail[0] ? 1 : String(b[2]).localeCompare(String(a[2])));

// ── 寫進 Sheet ──────────────────────────────────────────────
const S = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
const TABS = { 成員總表: summary, 演練明細: detail };
const LOG = '更新紀錄';

const meta = await api(`${S}?fields=sheets.properties.title`);
const have = new Set(meta.sheets.map(s => s.properties.title));
const missing = [...Object.keys(TABS), LOG].filter(t => !have.has(t));
if (missing.length) {
  await api(`${S}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) }),
  });
}

for (const [tab, rows] of Object.entries(TABS)) {
  // 先清空：上一次的資料比這次多的時候，殘列會留在下面變成幽靈紀錄
  await api(`${S}/values/${encodeURIComponent(tab)}:clear`, { method: 'POST', body: '{}' });
  await api(`${S}/values/${encodeURIComponent(tab)}!A1?valueInputOption=RAW`, {
    method: 'PUT', body: JSON.stringify({ values: rows }),
  });
}

// 附一行執行紀錄，這樣一眼就看得出排程到底有沒有在跑
await api(`${S}/values/${encodeURIComponent(LOG)}!A1:append?valueInputOption=RAW`, {
  method: 'POST',
  body: JSON.stringify({
    values: [[when(Date.now()), accounts.length, detail.length - 1, orphans.length,
      process.env.GITHUB_RUN_ID ? 'GitHub Actions' : '手動']],
  }),
});

console.log(`  註冊 ${accounts.length} 人　·　演練 ${detail.length - 1} 次　·　孤兒資料 ${orphans.length} 筆`);
console.log(`  已寫入 https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
