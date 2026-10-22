// AI業務教練 ＋ AI招募教練 使用報表：按「📊 更新報表 → 立即更新」才抓最新資料
// （使用者 2026-10-22 要的方式：需要時打開、按一下才更新；不定時、不自動、不放在 App 裡）。
// 用「按按鈕的人自己的 Google 帳號」讀 Firebase——專案擁有者本來就有權限，不需要服務帳戶與金鑰檔。
// 兩個 App 共用同一個 Firebase 專案與登入帳號：業務教練存在 /users/<uid>，招募教練存在 /recruit/<uid>。
// 欄位與兩個 repo 各自的 tools/report.mjs 相同；那邊改了，這裡要一起改（備份在 AiCoach/tools/sheet-button/）。
//
// ⚠️ 這份試算表含同事的演練評分與教練回饋（個人表現資料），分享權限請自己控管。

const PROJECT = 'ai-sales-coach-4b4cb';
const DB = 'https://ai-sales-coach-4b4cb-default-rtdb.asia-southeast1.firebasedatabase.app';
const TZ = 'Asia/Taipei';
const DAY = 864e5;
const NO_SRC = '未標記（舊用戶或直接開啟）';
const DEVICE_NAMES = {
  iphone: 'iPhone', ipad: 'iPad', 'android-phone': 'Android 手機', 'android-tablet': 'Android 平板',
  windows: 'Windows 電腦', mac: 'Mac', other: '其他',
};
// AI業務教練
const S_NAMES = { fluency: '流暢度', friendliness: '親和力', professionalism: '專業度', confidence: '自信度', awareness: '需求敏感度' };
const S_MODE = { call: '電話邀約', needs: '發掘需求', product: '商品行銷' };
// AI招募教練
const R_NAMES = { fluency: '說話流暢度', friendliness: '聲音語調的親切感', awareness: '談話內容的掌握', confidence: '自信心', professionalism: '專業度' };
const R_MODE = { call: '招募邀約電訪', meet: '招募面談', system: '招募制度說明' };
const R_DIFF = { 1: '新手友善', 2: '一般', 3: '挑戰', 4: '高難度', 5: '實戰' };

const TAB_ORDER = ['總覽', '業務｜成員總表', '業務｜演練明細', '業務｜來源與裝置統計',
  '招募｜成員總表', '招募｜演練明細', '招募｜來源與裝置統計', '更新紀錄'];
const OLD_TABS = ['成員總表', '演練明細', '來源與裝置統計'];          // 只有業務教練時的舊分頁名稱
const LOG_HEAD = ['更新時間', '登入帳號', '業務教練人數', '業務教練演練次數', '招募教練人數', '招募教練演練次數', '孤兒資料', '方式'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📊 更新報表').addItem('立即更新', 'updateReport').addToUi();
}

function api_(url) {
  const r = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      // 用 Firebase 專案本身記額度——試算表背後那個自動建立的專案沒有開 Identity Toolkit
      'x-goog-user-project': PROJECT,
    },
    muteHttpExceptions: true,
  });
  const code = r.getResponseCode(), t = r.getContentText();
  if (code >= 300) throw new Error(url.split('?')[0] + ' → ' + code + '\n' + t.slice(0, 300));
  return t ? JSON.parse(t) : null;
}

const when_ = ms => (Number(ms) ? Utilities.formatDate(new Date(Number(ms)), TZ, 'yyyy-MM-dd HH:mm') : '');
const avg_ = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : '');
const pct_ = (x, n) => (n ? Math.round(x / n * 100) + '%' : '—');
const nums_ = o => Object.values(o || {}).filter(n => typeof n === 'number');
const nameOf_ = a => a.displayName || (a.email || '').split('@')[0];
const login_ = a => ((a.providerUserInfo || [])[0] || {}).providerId === 'google.com' ? 'Google' : 'E-mail';
const devs_ = c => Object.entries((c.meta || {}).devices || {});
const devText_ = (devs, onlyHome) => devs.filter(([, v]) => !onlyHome || (v && v.home)).map(([k]) => DEVICE_NAMES[k] || k).join('、');

function updateReport() {
  const ss = SpreadsheetApp.getActive();
  ss.toast('正在讀取 Firebase 的最新資料…', '更新報表', 30);

  const accounts = [];
  let page = '';
  do {
    const j = api_('https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT + '/accounts:batchGet?maxResults=500'
      + (page ? '&nextPageToken=' + encodeURIComponent(page) : ''));
    (j.users || []).forEach(u => accounts.push(u));
    page = j.nextPageToken || '';
  } while (page);
  const sales = api_(DB + '/users.json') || {};
  const recruit = api_(DB + '/recruit.json') || {};
  const known = new Set(accounts.map(a => a.localId));
  const orphans = Object.keys(sales).concat(Object.keys(recruit)).filter(u => !known.has(u)).length;
  const now = Date.now();

  // ── AI業務教練（只列在業務教練有資料的人）──
  const sA = accounts.filter(a => sales[a.localId]);
  const sSum = [['姓名', 'E-mail', '登入方式', '註冊時間', '最後登入', '演練次數', '最後演練', '平均星等',
    ...Object.values(S_NAMES), '最常練的模式', '目前難度', '指定模型', '首次來源', '使用過的裝置', '加到主畫面']];
  const sDet = [];
  sA.forEach(a => {
    const c = sales[a.localId], h = c.history || [], prefs = c.prefs || {}, devs = devs_(c);
    const modes = {};
    h.forEach(x => { const m = x.modeName || S_MODE[x.mode] || x.mode; modes[m] = (modes[m] || 0) + 1; });
    const top = Object.entries(modes).sort((x, y) => y[1] - x[1])[0];
    sSum.push([nameOf_(a), a.email, login_(a), when_(a.createdAt), when_(a.lastLoginAt || a.lastSignedInAt),
      h.length, when_(h[0] && h[0].at), avg_(h.flatMap(x => nums_(x.scores))),
      ...Object.keys(S_NAMES).map(k => avg_(h.map(x => (x.scores || {})[k]).filter(n => typeof n === 'number'))),
      top ? top[0] + '（' + top[1] + ' 次）' : '', prefs.diff || '', String(prefs.models || '').replace(/^"|"$/g, ''),
      (c.meta || {}).src || NO_SRC, devText_(devs), devText_(devs, true)]);
    h.forEach(x => sDet.push([nameOf_(a), a.email, when_(x.at), x.modeName || S_MODE[x.mode] || x.mode, x.name || '',
      ...Object.keys(S_NAMES).map(k => { const v = (x.scores || {})[k]; return v == null ? '' : v; }),
      avg_(nums_(x.scores)), x.summary || '', x.next || '']));
  });
  sDet.sort((x, y) => String(y[2]).localeCompare(String(x[2])));
  sDet.unshift(['姓名', 'E-mail', '演練時間', '模式', '客戶', ...Object.values(S_NAMES), '本次平均', '教練總結', '下次挑戰']);

  // ── AI招募教練（只列在招募教練有資料的人）──
  const rA = accounts.filter(a => recruit[a.localId]);
  const rSum = [['姓名', 'E-mail', '登入方式', '註冊時間', '最後登入（兩個 App 合計）', '演練次數', '最後演練', '平均星等',
    ...Object.values(R_NAMES), '成功約到下一步', '願意考照', '合規提醒次數',
    R_MODE.call + '次數', R_MODE.meet + '次數', R_MODE.system + '次數', '目前難度', '首次來源', '使用過的裝置', '加到主畫面']];
  const rDet = [];
  rA.forEach(a => {
    const c = recruit[a.localId], h = c.history || [], prefs = c.prefs || {}, devs = devs_(c);
    const count = m => h.filter(x => x.mode === m).length;
    rSum.push([nameOf_(a), a.email, login_(a), when_(a.createdAt), when_(a.lastLoginAt || a.lastSignedInAt),
      h.length, when_(h[0] && h[0].at), avg_(h.flatMap(x => nums_(x.scores))),
      ...Object.keys(R_NAMES).map(k => avg_(h.map(x => (x.scores || {})[k]).filter(n => typeof n === 'number'))),
      h.filter(x => x.tier > 0).length, h.filter(x => x.tier === 2).length, h.reduce((s, x) => s + (x.violations || 0), 0),
      count('call'), count('meet'), count('system'), R_DIFF[prefs.diff] || '',
      (c.meta || {}).src || NO_SRC, devText_(devs), devText_(devs, true)]);
    h.forEach(x => rDet.push([nameOf_(a), a.email, when_(x.at), x.modeName || R_MODE[x.mode] || x.mode || '', x.name || '', x.outcome || '',
      ...Object.keys(R_NAMES).map(k => { const v = (x.scores || {})[k]; return v == null ? '' : v; }),
      avg_(nums_(x.scores)), Array.isArray(x.kp) ? x.kp[0] + '／' + x.kp[1] : '', x.wrong || '', x.violations || '',
      x.summary || '', x.next || '']));
  });
  rDet.sort((x, y) => String(y[2]).localeCompare(String(x[2])));
  rDet.unshift(['姓名', 'E-mail', '演練時間', '模式', '招募對象', '結果', ...Object.values(R_NAMES), '本次平均',
    '必講重點', '講錯幾處', '合規提醒', '教練總結', '下次挑戰']);

  // ── 總覽：一人一列，兩個 App 都看 ──
  const overview = [['姓名', 'E-mail', '註冊時間', '最後登入', '用過的 App', '業務教練演練次數', '招募教練演練次數', '最後一次演練']];
  accounts.forEach(a => {
    const s = sales[a.localId], r = recruit[a.localId];
    if (!s && !r) return;                                        // 兩邊都沒有資料（例如都刪除了）就不列
    const sh = (s && s.history) || [], rh = (r && r.history) || [];
    const last = Math.max(0, sh[0] ? sh[0].at : 0, rh[0] ? rh[0].at : 0);
    overview.push([nameOf_(a), a.email, when_(a.createdAt), when_(a.lastLoginAt || a.lastSignedInAt),
      [s && '業務教練', r && '招募教練'].filter(Boolean).join('＋'), s ? sh.length : '', r ? rh.length : '', when_(last)]);
  });

  write_(ss, '總覽', overview);
  write_(ss, '業務｜成員總表', sSum);
  write_(ss, '業務｜演練明細', sDet);
  write_(ss, '業務｜來源與裝置統計', sourceStats_(sA, sales, now));
  write_(ss, '招募｜成員總表', rSum);
  write_(ss, '招募｜演練明細', rDet);
  write_(ss, '招募｜來源與裝置統計', sourceStats_(rA, recruit, now));

  // 更新紀錄：欄位和只有業務教練時不同，舊的那一份改名保留，從新的開始記
  let log = ss.getSheetByName('更新紀錄');
  if (log && log.getLastRow() && log.getRange(1, 1, 1, log.getLastColumn()).getValues()[0].join() !== LOG_HEAD.join()) {
    log.setName('更新紀錄（舊）');
    log = null;
  }
  log = log || ss.insertSheet('更新紀錄');
  if (!log.getLastRow()) { log.appendRow(LOG_HEAD); log.getRange(1, 1, 1, LOG_HEAD.length).setFontWeight('bold'); log.setFrozenRows(1); }
  log.appendRow([when_(now), accounts.length, sA.length, sDet.length - 1, rA.length, rDet.length - 1, orphans, '按鈕手動更新']);

  // 舊分頁（只有業務教練時的名稱）已經被「業務｜」開頭的取代
  OLD_TABS.forEach(n => { const sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); });
  TAB_ORDER.forEach((n, i) => { const sh = ss.getSheetByName(n); if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); } });
  ss.setActiveSheet(ss.getSheetByName('總覽'));

  ss.toast('業務教練 ' + sA.length + ' 人．招募教練 ' + rA.length + ' 人', '✅ 已更新到最新', 8);
}

// 每個來源帶來多少人、用什麼裝置、留不留得住（一個人用過兩類裝置就兩類各算一次）
function sourceStats_(list, cloud, now) {
  const by = {};
  list.forEach(a => {
    const c = cloud[a.localId], h = c.history || [], devs = devs_(c);
    const src = (c.meta || {}).src || NO_SRC;
    const g = by[src] || (by[src] = { n: 0, dev: {}, home: 0, any: 0, w1: 0, w4base: 0, w4: 0 });
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
  const DEV = Object.keys(DEVICE_NAMES);
  const row = (label, g) => [label, g.n, ...DEV.map(k => g.dev[k] || 0), pct_(g.home, g.n), pct_(g.any, g.n),
    pct_(g.w1, g.n), g.w4base, pct_(g.w4, g.w4base)];
  const rows = [['來源', '人數', ...DEV.map(k => DEVICE_NAMES[k]), '加到主畫面', '有練習過', '第 1 週有練習', '註冊滿 4 週的人數', '第 4 週仍在練']];
  const T = { n: 0, dev: {}, home: 0, any: 0, w1: 0, w4base: 0, w4: 0 };
  Object.keys(by).sort((x, y) => (x === NO_SRC) - (y === NO_SRC) || by[y].n - by[x].n).forEach(s => {
    const g = by[s];
    rows.push(row(s, g));
    ['n', 'home', 'any', 'w1', 'w4base', 'w4'].forEach(k => { T[k] += g[k]; });
    DEV.forEach(k => { T.dev[k] = (T.dev[k] || 0) + (g.dev[k] || 0); });
  });
  rows.push(row('合計', T));
  return rows;
}

// 先清空再寫：上一次資料比這次多的時候，殘列會留在下面變成幽靈紀錄
function write_(ss, name, rows) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  const w = Math.max(...rows.map(r => r.length));
  const vals = rows.map(r => r.concat(Array(w - r.length).fill('')));
  sh.getRange(1, 1, vals.length, w).setValues(vals);
  sh.getRange(1, 1, 1, w).setFontWeight('bold');
  sh.setFrozenRows(1);
}
