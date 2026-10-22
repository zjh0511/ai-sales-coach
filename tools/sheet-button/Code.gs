// AI業務教練 使用報表：按「📊 更新報表 → 立即更新」才抓最新資料（使用者 2026-10-22 要的方式：不定時、不自動）。
// 用「按按鈕的人自己的 Google 帳號」讀 Firebase——專案擁有者本來就有權限，不需要服務帳戶與金鑰檔。
// 內容與 tools/report.mjs 相同（D049）；那邊的欄位有改，這裡要一起改。
//
// ⚠️ 這份試算表含同事的演練評分與教練回饋（個人表現資料），分享權限請自己控管。

const PROJECT = 'ai-sales-coach-4b4cb';
const DB = 'https://ai-sales-coach-4b4cb-default-rtdb.asia-southeast1.firebasedatabase.app';
const TZ = 'Asia/Taipei';

const NAMES = { fluency: '流暢度', friendliness: '親和力', professionalism: '專業度', confidence: '自信度', awareness: '需求敏感度' };
const MODE = { call: '電話邀約', needs: '發掘需求', product: '商品行銷' };
const DEVICE_NAMES = {
  iphone: 'iPhone', ipad: 'iPad', 'android-phone': 'Android 手機', 'android-tablet': 'Android 平板',
  windows: 'Windows 電腦', mac: 'Mac', other: '其他',
};
const NO_SRC = '未標記（舊用戶或直接開啟）';
const DAY = 864e5;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📊 更新報表').addItem('立即更新', 'updateReport').addToUi();
}

function api_(url, opt) {
  const r = UrlFetchApp.fetch(url, Object.assign({
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      // 用 Firebase 專案本身記額度——試算表背後那個自動建立的專案沒有開 Identity Toolkit
      'x-goog-user-project': PROJECT,
    },
    muteHttpExceptions: true,
  }, opt || {}));
  const code = r.getResponseCode(), t = r.getContentText();
  if (code >= 300) throw new Error(url.split('?')[0] + ' → ' + code + '\n' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}

const when_ = ms => (Number(ms) ? Utilities.formatDate(new Date(Number(ms)), TZ, 'yyyy-MM-dd HH:mm') : '');
const avg_ = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : '');
const pct_ = (x, n) => (n ? Math.round(x / n * 100) + '%' : '—');

function updateReport() {
  const ss = SpreadsheetApp.getActive();
  ss.toast('正在讀取 Firebase 的最新資料…', '更新報表', 30);

  // 註冊名單（每頁最多 500 人）
  const accounts = [];
  let page = '';
  do {
    const j = api_('https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT + '/accounts:batchGet?maxResults=500'
      + (page ? '&nextPageToken=' + encodeURIComponent(page) : ''));
    (j.users || []).forEach(u => accounts.push(u));
    page = j.nextPageToken || '';
  } while (page);
  const cloud = api_(DB + '/users.json') || {};

  const known = new Set(accounts.map(a => a.localId));
  const orphans = Object.keys(cloud).filter(u => !known.has(u));
  const summary = [['姓名', 'E-mail', '登入方式', '註冊時間', '最後登入', '演練次數', '最後演練', '平均星等',
    ...Object.values(NAMES), '最常練的模式', '目前難度', '指定模型', '首次來源', '使用過的裝置', '加到主畫面']];
  const detail = [['姓名', 'E-mail', '演練時間', '模式', '客戶', ...Object.values(NAMES), '本次平均', '教練總結', '下次挑戰']];

  // 來源與裝置統計：一個人用過兩類裝置就兩類各算一次
  const bySrc = {};
  const now = Date.now();

  accounts.forEach(a => {
    const c = cloud[a.localId] || {};
    const h = c.history || [], prefs = c.prefs || {}, meta = c.meta || {};
    const all = h.flatMap(x => Object.values(x.scores || {})).filter(n => typeof n === 'number');
    const modes = {};
    h.forEach(x => { const m = x.modeName || MODE[x.mode] || x.mode; modes[m] = (modes[m] || 0) + 1; });
    const top = Object.entries(modes).sort((x, y) => y[1] - x[1])[0];
    const name = a.displayName || (a.email || '').split('@')[0];
    const devs = Object.entries(meta.devices || {});
    const src = meta.src || NO_SRC;

    summary.push([name, a.email, (a.providerUserInfo || [])[0]?.providerId === 'google.com' ? 'Google' : 'E-mail',
      when_(a.createdAt), when_(a.lastLoginAt || a.lastSignedInAt), h.length, when_(h[0]?.at), avg_(all),
      ...Object.keys(NAMES).map(k => avg_(h.map(x => x.scores?.[k]).filter(n => typeof n === 'number'))),
      top ? top[0] + '（' + top[1] + ' 次）' : '', prefs.diff || '', String(prefs.models || '').replace(/^"|"$/g, ''),
      src, devs.map(([k]) => DEVICE_NAMES[k] || k).join('、'),
      devs.filter(([, v]) => v && v.home).map(([k]) => DEVICE_NAMES[k] || k).join('、')]);

    h.forEach(x => detail.push([name, a.email, when_(x.at), x.modeName || MODE[x.mode] || x.mode, x.name,
      ...Object.keys(NAMES).map(k => x.scores?.[k] ?? ''),
      avg_(Object.values(x.scores || {}).filter(n => typeof n === 'number')), x.summary || '', x.next || '']));

    const g = bySrc[src] || (bySrc[src] = { n: 0, dev: {}, home: 0, any: 0, w1: 0, w4base: 0, w4: 0 });
    const born = Number(a.createdAt) || 0;
    const days = h.map(x => (x.at - born) / DAY);
    g.n++;
    devs.forEach(([k]) => { g.dev[k] = (g.dev[k] || 0) + 1; });
    if (devs.some(([, v]) => v && v.home)) g.home++;
    if (h.length) g.any++;
    if (days.some(d => d >= 0 && d < 7)) g.w1++;                 // 註冊後 7 天內有練習
    if (born && now - born >= 28 * DAY) {                         // 只算註冊滿 4 週的人
      g.w4base++;
      if (days.some(d => d >= 21 && d < 28)) g.w4++;              // 第 4 週（第 22～28 天）還有練習
    }
  });
  const body = detail.slice(1).sort((x, y) => String(y[2]).localeCompare(String(x[2])));

  const DEV = Object.keys(DEVICE_NAMES);
  const srcRows = [['來源', '註冊人數', ...DEV.map(k => DEVICE_NAMES[k]), '加到主畫面', '有練習過',
    '第 1 週有練習', '註冊滿 4 週的人數', '第 4 週仍在練']];
  const order = Object.keys(bySrc).sort((x, y) => (x === NO_SRC) - (y === NO_SRC) || bySrc[y].n - bySrc[x].n);
  const T = { n: 0, dev: {}, home: 0, any: 0, w1: 0, w4base: 0, w4: 0 };
  const row = (label, g) => [label, g.n, ...DEV.map(k => g.dev[k] || 0), pct_(g.home, g.n), pct_(g.any, g.n),
    pct_(g.w1, g.n), g.w4base, pct_(g.w4, g.w4base)];
  order.forEach(s => {
    const g = bySrc[s];
    srcRows.push(row(s, g));
    ['n', 'home', 'any', 'w1', 'w4base', 'w4'].forEach(k => { T[k] += g[k]; });
    DEV.forEach(k => { T.dev[k] = (T.dev[k] || 0) + (g.dev[k] || 0); });
  });
  srcRows.push(row('合計', T));

  write_(ss, '來源與裝置統計', srcRows);
  write_(ss, '成員總表', summary);
  write_(ss, '演練明細', [detail[0], ...body]);
  const log = ss.getSheetByName('更新紀錄') || ss.insertSheet('更新紀錄');
  if (!log.getLastRow()) log.appendRow(['更新時間', '註冊人數', '演練次數', '孤兒資料', '方式']);
  log.appendRow([when_(now), accounts.length, body.length, orphans.length, '按鈕手動更新']);

  ss.toast('註冊 ' + accounts.length + ' 人．演練 ' + body.length + ' 次', '✅ 已更新到最新', 8);
}

// 先清空再寫：上一次資料比這次多的時候，殘列會留在下面變成幽靈紀錄
function write_(ss, name, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  const w = Math.max(...rows.map(r => r.length));
  const vals = rows.map(r => r.concat(Array(w - r.length).fill('')));
  sh.getRange(1, 1, vals.length, w).setValues(vals);
  sh.getRange(1, 1, 1, w).setFontWeight('bold');
  sh.setFrozenRows(1);
}
