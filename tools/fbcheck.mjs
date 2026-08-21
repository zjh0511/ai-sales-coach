// 帳號同步的端到端檢查：註冊 → 寫入 → 讀回 → 合併 → **安全規則隔離** → 刪除測試帳號。
//
// 為什麼需要這支：安全規則改壞了不會有任何錯誤訊息，只會變成
// 「所有人都看得到彼此的訓練紀錄」。這種 bug 只有主動去撞才發現得到。
// 每次改 database.rules.json 之後都該跑一次。
//
//   node tools/fbcheck.mjs
//
// 會在正式專案裡建立一個 zz-selftest-<時間戳>@example.com 的帳號，
// 跑完自動刪除（含它寫進資料庫的資料）。若中途當掉，請到
// Firebase 主控台 → Authentication 手動移除殘留的 zz-selftest 帳號。
import { FB } from '../docs/firebase-config.js';
import * as acct from '../docs/engine/account.js';

if (!FB.apiKey || !FB.dbUrl) {
  console.error('firebase-config.js 還沒填，帳號功能目前是關閉的。設定步驟見 docs/account-setup.html。');
  process.exit(1);
}
const DB = FB.dbUrl.replace(/\/+$/, '');

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${x ? ' → ' + x : ''}`); };

const email = `zz-selftest-${Date.now()}@example.com`;
const pw = 'test-' + Math.random().toString(36).slice(2, 10);
let uid = null, idToken = null;

try {
  console.log('\n=== 註冊 ===');
  const u = await acct.signUpEmail(email, pw);
  uid = u.uid;
  ok(!!uid, '註冊成功', uid);
  ok(u.email === email, '回傳的 E-mail 正確');
  idToken = await acct.token();
  ok(!!idToken, '取得 idToken');

  console.log('\n=== 寫入與讀回 ===');
  const data = {
    history: [{ at: 1700000001, mode: 'call', name: '測試客戶', scores: { fluency: 4 } }],
    prefs: { diff: '2', ctx: 'referral', provider: 'gemini', models: '', updatedAt: 1700000000 },
  };
  ok(await acct.push(data), '寫入雲端');
  const back = await acct.pull();
  ok(back?.history?.length === 1, '讀回訓練紀錄', JSON.stringify(back?.history?.[0]?.name));
  ok(back?.prefs?.diff === '2', '讀回偏好設定');

  console.log('\n=== 合併（模擬第二台裝置）===');
  const local = { history: [{ at: 1700000002, name: '手機上練的' }], prefs: { diff: '5', updatedAt: 1700000009 } };
  const merged = acct.merge(local, back);
  ok(merged.history.length === 2, '兩台裝置的紀錄都留著', String(merged.history.length));
  ok(merged.prefs.diff === '5', '較新的偏好勝出');
  ok(await acct.push(merged), '合併後寫回');
  ok((await acct.pull()).history.length === 2, '雲端確實有 2 筆');

  // 這一節是這支腳本存在的理由
  console.log('\n=== 安全規則：能不能偷看別人的資料 ===');
  const g = (p, o) => fetch(`${DB}${p}`, o).then(r => r.status);
  ok(await g(`/users/somebody-elses-uid.json?auth=${idToken}`) === 401, '讀別人的資料被拒');
  ok(await g(`/users/somebody-elses-uid.json?auth=${idToken}`, { method: 'PUT', body: '"hack"' }) === 401, '寫別人的資料被拒');
  ok(await g(`/.json?auth=${idToken}`) === 401, '讀整個資料庫被拒');
  ok(await g(`/users/${uid}.json`) === 401, '未登入讀我的資料被拒');
} catch (e) {
  fail++;
  console.log(' FAIL  例外：' + e.message);
} finally {
  if (idToken) {
    await fetch(`${DB}/users/${uid}.json?auth=${idToken}`, { method: 'DELETE' }).catch(() => {});
    const d = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${FB.apiKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }).catch(() => null);
    console.log(`\n  清理：測試帳號 ${email} ${d?.ok ? '已刪除' : '刪除失敗，請手動移除'}`);
  }
}

console.log(`\n———— 通過 ${pass}，失敗 ${fail} ————\n`);
process.exitCode = fail ? 1 : 0;
