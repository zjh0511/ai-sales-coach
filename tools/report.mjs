// 產生成員與演練紀錄的報表（CSV，可直接丟進 Google 雲端硬碟開成 Sheets）。
//
//   node tools/report.mjs                      → 輸出到 ./報表/
//   node tools/report.mjs --out "G:/我的雲端硬碟/AI業務教練"
//   node tools/report.mjs --no-detail          → 只出總表，不出逐筆明細
//
// 資料來源有兩個，靠 uid 對起來：
//   1. firebase auth:export      → 誰註冊了、什麼時候、用什麼方式、最後登入
//   2. firebase database:get /users → 每個人的演練紀錄（同步上雲的那些）
//
// 為什麼用 CLI 而不是打 REST：安全規則對所有人都是拒絕，
// 只有專案擁有者的憑證有管理權限，而那份憑證就在 firebase CLI 裡
// （`firebase login` 存下來的）。所以這支腳本只有你自己跑得動。
//
// ⚠️ 這份報表包含同事的演練評分與教練回饋，是**個人表現資料**。
//    產出之後放在哪裡、給誰看，請比照公司的人事資料處理。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROJECT = 'ai-sales-coach-4b4cb';
const args = process.argv.slice(2);
const argOf = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const DETAIL = !args.includes('--no-detail');

// 裝了 Google 雲端硬碟桌面版的話直接寫進去，檔案會自動同步上雲端。
// 沒裝就寫到專案底下的 報表/。
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DRIVE = [
  'G:/我的雲端硬碟', 'G:/My Drive', 'H:/我的雲端硬碟', 'H:/My Drive',
  HOME && path.join(HOME, 'My Drive'),
  HOME && path.join(HOME, 'Google Drive'),
].find(d => d && fs.existsSync(d));
const OUT = argOf('--out') || (DRIVE ? path.join(DRIVE, 'AI業務教練報表') : '報表');

const NAMES = {
  fluency: '流暢度', friendliness: '親和力',
  professionalism: '專業度', confidence: '自信度', awareness: '需求敏感度',
};
const MODE = { call: '電話邀約', needs: '發掘需求', product: '商品行銷' };

// 直接跑 firebase-tools 的 JS 入口，不經過 firebase.cmd。
// 原因：Node 24 起為了安全性不允許直接 spawn .cmd（EINVAL），
// 而改用 shell: true 又要自己處理路徑轉義（含中文與空白）。跑 .js 兩個問題都沒有。
const CLI = [
  path.join(process.env.APPDATA || '', 'npm/node_modules/firebase-tools/lib/bin/firebase.js'),
  '/usr/local/lib/node_modules/firebase-tools/lib/bin/firebase.js',
  path.join(process.env.HOME || '', '.npm-global/lib/node_modules/firebase-tools/lib/bin/firebase.js'),
].find(p => p && fs.existsSync(p));

if (!CLI) {
  console.error('找不到 firebase-tools。請先執行：npm install -g firebase-tools && firebase login');
  process.exit(1);
}

// firebase CLI 會噴 url.parse 的 DeprecationWarning，那是它自己的問題，
// 吞掉 stderr 讓報表輸出乾淨；真的失敗時 execFileSync 仍會丟例外，不會被藏起來。
const fb = (...a) => execFileSync(process.execPath, [CLI, ...a, '--project', PROJECT], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
});

// ── 取資料 ──────────────────────────────────────────────────
const tmp = path.join(os.tmpdir(), `aicoach-auth-${Date.now()}.json`);
let accounts = [], cloud = {};
try {
  fb('auth:export', tmp, '--format=json');
  accounts = JSON.parse(fs.readFileSync(tmp, 'utf8')).users || [];
} finally {
  fs.rmSync(tmp, { force: true });
}
try {
  cloud = JSON.parse(fb('database:get', '/users')) || {};
} catch {
  console.log('  （提醒）讀不到雲端演練紀錄，只產出註冊名單。');
}

// ── CSV：中文在 Excel 開啟需要 BOM，否則會變亂碼 ─────────────
const cell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = rows => '\uFEFF' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
const when = ms => {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : '';

// ── 組報表 ──────────────────────────────────────────────────
const byUid = new Set(accounts.map(a => a.localId));
const orphans = Object.keys(cloud).filter(u => !byUid.has(u));

const summary = [[
  '姓名', 'E-mail', '登入方式', '註冊時間', '最後登入',
  '演練次數', '最後演練', '平均星等',
  ...Object.values(NAMES), '最常練的模式', '目前難度', '指定模型',
]];
const detail = [[
  '姓名', 'E-mail', '演練時間', '模式', '客戶',
  ...Object.values(NAMES), '本次平均', '教練總結', '下次挑戰',
]];

const rows = accounts.map(a => {
  const h = (cloud[a.localId]?.history) || [];
  const prefs = cloud[a.localId]?.prefs || {};
  const per = {};
  for (const k of Object.keys(NAMES)) per[k] = avg(h.map(x => x.scores?.[k]).filter(n => typeof n === 'number'));
  const all = h.flatMap(x => Object.values(x.scores || {})).filter(n => typeof n === 'number');
  const modes = {};
  for (const x of h) modes[x.modeName || MODE[x.mode] || x.mode] = (modes[x.modeName || MODE[x.mode] || x.mode] || 0) + 1;
  const top = Object.entries(modes).sort((x, y) => y[1] - x[1])[0];
  const name = a.displayName || (a.email || '').split('@')[0];

  summary.push([
    name, a.email, (a.providerUserInfo?.[0]?.providerId === 'google.com' ? 'Google' : 'E-mail'),
    when(a.createdAt), when(a.lastSignedInAt),
    h.length, when(h[0]?.at), avg(all),
    ...Object.keys(NAMES).map(k => per[k]),
    top ? `${top[0]}（${top[1]} 次）` : '', prefs.diff || '',
    (prefs.models || '').replace(/^"|"$/g, ''),
  ]);

  for (const x of h) {
    const s = Object.values(x.scores || {}).filter(n => typeof n === 'number');
    detail.push([
      name, a.email, when(x.at), x.modeName || MODE[x.mode] || x.mode, x.name,
      ...Object.keys(NAMES).map(k => x.scores?.[k] ?? ''),
      avg(s), x.summary, x.next,
    ]);
  }
  return { name, email: a.email, sessions: h.length, avg: avg(all) };
});

// ── 寫檔 ────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const f1 = path.join(OUT, 'AI業務教練_成員總表.csv');
fs.writeFileSync(f1, csv(summary));
let f2 = null;
if (DETAIL) {
  f2 = path.join(OUT, 'AI業務教練_演練明細.csv');
  fs.writeFileSync(f2, csv(detail));
}

// ── 畫面摘要 ────────────────────────────────────────────────
console.log(`\n  註冊人數 ${accounts.length}　·　演練總次數 ${detail.length - 1}\n`);
const w = Math.max(6, ...rows.map(r => [...r.name].length * 2));
for (const r of rows.sort((a, b) => b.sessions - a.sessions)) {
  console.log(`  ${r.name.padEnd(w - ([...r.name].length))}  ${String(r.sessions).padStart(3)} 次   平均 ${r.avg || '—'} 星   ${r.email}`);
}
if (!rows.some(r => r.sessions)) console.log('  （還沒有人的演練紀錄同步上來）');
if (orphans.length) {
  console.log(`\n  ⚠️ 雲端有 ${orphans.length} 筆孤兒資料（帳號已刪但資料還在），已從報表排除：`);
  for (const u of orphans) console.log(`     ${u}`);
  console.log('     要清掉的話：firebase database:remove /users/<uid> --project ' + PROJECT);
}
console.log(`\n  已寫出：\n    ${f1}${f2 ? '\n    ' + f2 : ''}`);
console.log(DRIVE && !argOf('--out')
  ? '  （在 Google 雲端硬碟資料夾裡，會自動同步上雲端）\n'
  : '  提示：裝了 Google 雲端硬碟桌面版之後這支腳本會自動寫進去，\n'
    + '        也可以用 --out "資料夾路徑" 自己指定。\n');
