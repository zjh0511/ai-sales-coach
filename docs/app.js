import { Voice, supported, voiceInfo, MIC_AFTER_TTS_MS } from './voice.js';
import { TtsRotator, nextPacificMidnight, voiceFor, COACH_VOICES } from './engine/tts.js';
import { api, providers, restore, onModelEvent } from './engine/api.js';
import { startOpenRouter, oauthSupported } from './engine/oauth.js';
import * as acct from './engine/account.js';

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const LS = 'aicoach.history';

const S = {
  fn: 'call',            // 目前功能：pain | call | needs | product | claim | chat
  sessionId: null, persona: null, ended: false, busy: false,
  docPick: null,         // 進入文件頁的目的：null=管理 / 'product'（選商品教材）
  uploadTo: null,        // 從理賠諮詢的「客戶的保單」上傳時為 'cp'，上傳完回到那一頁
  doc: null,             // 已選定的文件 {id,title}
  claim: null,           // 理賠諮詢這一件：{ client, situation, policies, extra, result }
  chatHistory: [],
  lastCustomer: null,    // 痛點分析用過的客戶資料，可直接接去演練
};

const MODE_TITLE = { call: '電話邀約語音對練', needs: '發掘需求角色扮演', product: '商品行銷語音演練' };

// ── 畫面切換 ────────────────────────────────────────────────
function show(name) {
  if (name !== 'chat') chatVoiceOff();
  vmode = name === 'chat' ? 'chat' : 'play';
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + name));
  if (name === 'history') renderHistory();
  if (name === 'docs') renderDocs();
  if (name === 'models') renderModels();
  syncInstallBtn();                                    // 三個畫面都有「加到主畫面」
  if (name === 'home') {
    // 強制登入的把關點。帳號在使用途中失效（管理者停用、token 被撤銷）時，
    // 不在演練中硬切畫面，而是在下一次回到首頁時擋下來。
    if (acct.configured() && !acct.user()) { initAuth(); return show('auth'); }
    updateAccount(); updateWho();
  }
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (!g) return;
  const to = g.dataset.go;
  if (to === 'home') { abort(); S.docPick = null; }
  if (to === 'intake') return openIntake(S.fn);
  show(to);
});

let toastT;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

// ── 金鑰 ────────────────────────────────────────────────────
// 全部運算都在這台裝置完成，金鑰只存在瀏覽器，不會送到任何伺服器。
const PROV_KEY = 'aicoach.provider';
const AKEY_KEY = 'aicoach.apikey';

const cred = () => ({ provider: localStorage.getItem(PROV_KEY), key: localStorage.getItem(AKEY_KEY) });

// api() 由 engine/api.js 提供；認證失敗會帶 e.auth，統一在這裡退回登入畫面
window.addEventListener('unhandledrejection', e => { if (e.reason?.auth) logout(e.reason.message); });

// ── 登入畫面 ────────────────────────────────────────────────
let PROVIDERS = {};

async function initLogin() {
  PROVIDERS = providers();

  // 目前只開放 Google AI Studio。之前用 Groq、OpenRouter 等登入的人，
  // 存著的金鑰不能再用了——清掉並說明原因，而不是讓他看到一個看不懂的錯誤。
  const oldProvider = localStorage.getItem(PROV_KEY);
  let migrated = false;
  if (oldProvider && !PROVIDERS[oldProvider]) {
    localStorage.removeItem(AKEY_KEY);
    localStorage.removeItem(PIN_KEY);           // 別家的模型名稱在 Gemini 上不存在
    localStorage.setItem(PROV_KEY, 'gemini');
    migrated = true;
  }

  const sel = $('#lg-provider');
  sel.innerHTML = '';
  for (const [k, p] of Object.entries(PROVIDERS)) {
    const o = el('option', null, p.label + (p.verified ? '（已實測）' : ''));
    o.value = k;
    sel.append(o);
  }
  sel.value = localStorage.getItem(PROV_KEY) || Object.keys(PROVIDERS)[0] || 'gemini';
  syncProvider();
  if (migrated) {
    $('#lg-msg').className = 'note err';
    $('#lg-msg').textContent = '現在只支援 Google AI Studio 的 API 金鑰，請貼上你的 Gemini 金鑰（申請免費）。';
  }

  // 重新整理後用已存的金鑰靜默恢復，失敗就回登入畫面
  const { provider, key } = cred();
  if (provider && key) {
    $('#lg-msg').textContent = '正在恢復上次的連線…';
    if (await restore(provider, key, loadPin())) {
      return show(localStorage.getItem('aicoach.seen') ? 'home' : 'welcome');
    }
    localStorage.removeItem(AKEY_KEY);
    $('#lg-msg').className = 'note err';
    $('#lg-msg').textContent = '上次的金鑰已失效，請重新輸入';
  }
  show('login');
}

function syncProvider() {
  const p = PROVIDERS[$('#lg-provider').value] || {};
  $('#lg-note').textContent = [p.note, p.hint ? `金鑰${p.hint}` : '', p.file ? '' : '（此服務商無法直接讀取 PDF）']
    .filter(Boolean).join('　·　');
  $('#lg-link').href = p.url || '#';
  $('#lg-oauth').hidden = !(p.oauth && oauthSupported());
}
$('#lg-provider').onchange = syncProvider;

$('#lg-oauth-go').onclick = async () => {
  const b = $('#lg-oauth-go'); b.disabled = true; b.textContent = '前往 OpenRouter…';
  try { await startOpenRouter(); }
  catch (e) {
    $('#lg-msg').className = 'note err'; $('#lg-msg').textContent = e.message;
    b.disabled = false; b.textContent = '用 OpenRouter 帳號登入';
  }
};
$('#lg-show').onchange = e => { $('#lg-key').type = e.target.checked ? 'text' : 'password'; };

$('#lg-go').onclick = async () => {
  const provider = $('#lg-provider').value;
  const key = $('#lg-key').value.trim();
  const msg = $('#lg-msg');
  if (!key) { msg.className = 'note err'; msg.textContent = '請先貼上金鑰'; return; }

  const btn = $('#lg-go'); btn.disabled = true; btn.textContent = '驗證中…';
  msg.className = 'note'; msg.textContent = '正在向服務商確認金鑰…';
  try {
    // 換服務商時舊的模型指定不再適用，清掉
    if (localStorage.getItem(PROV_KEY) !== provider) localStorage.removeItem(PIN_KEY);
    const j = await api('/login', { provider, key, pin: loadPin() });
    localStorage.setItem(PROV_KEY, provider);
    localStorage.setItem(AKEY_KEY, key);
    $('#lg-key').value = '';
    msg.className = 'note ok'; msg.textContent = `已連線：${j.fast}`;
    updateAccount();
    show(localStorage.getItem('aicoach.seen') ? 'home' : 'welcome');
  } catch (e) {
    msg.className = 'note err'; msg.textContent = e.message;
  }
  btn.disabled = false; btn.textContent = '驗證並登入';
};

// 首頁顯示目前的服務商與正在使用的模型，並提供明顯的入口去更換
async function updateAccount() {
  const { provider } = cred();
  const box = $('#home-acct');
  box.hidden = !provider;
  $('#home-logout').hidden = !provider;
  if (!provider) return;

  $('#acct-provider').textContent = PROVIDERS[provider]?.label || provider;
  $('#acct-fast').textContent = '載入中…';
  $('#acct-judge').textContent = '';
  try {
    const st = await api('/models/status');
    if (st.pinned) {
      $('#acct-fast').textContent = `模型　${st.pinned}`;
      $('#acct-judge').textContent = '';
    } else if (st.active.fast === st.active.judge) {
      $('#acct-fast').textContent = `模型　${st.active.fast || '—'}（自動）`;
      $('#acct-judge').textContent = '';
    } else {
      $('#acct-fast').textContent = `模型　${st.active.fast || '—'}（自動）`;
      $('#acct-judge').textContent = `分析時改用　${st.active.judge}`;
    }
  } catch {
    $('#acct-fast').textContent = '模型　—';
    $('#acct-judge').textContent = '';
  }
}

$('#home-logout').onclick = () => {
  if (confirm('登出後需要重新輸入 API 金鑰，訓練紀錄不會被刪除。確定登出？')) logout();
};

// ── 模型設定 ────────────────────────────────────────────────
const PIN_KEY = 'aicoach.models';
let modelFilter = '';

// 指定的模型；null 代表自動。舊版存的是 {fast,judge} 物件，這裡順便遷移
function loadPin() {
  try {
    const v = JSON.parse(localStorage.getItem(PIN_KEY));
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {          // 舊的 {fast,judge} 格式 → 就地正規化
      const one = v.fast || v.judge || null;
      savePin(one);
      return one;
    }
  } catch { /* 格式壞掉就當沒設定 */ }
  return null;
}
const savePin = m => { m ? localStorage.setItem(PIN_KEY, JSON.stringify(m)) : localStorage.removeItem(PIN_KEY); savePrefs({}); };

async function renderModels() {
  const b = $('#m-body'); b.innerHTML = '';
  let st;
  try { st = await api('/models/status'); } catch (e) { return void b.append(el('p', 'note', e.message)); }

  const cooling = new Map(st.cooling.map(c => [c.id, c.minutes]));

  b.append(el('p', 'note',
    '不確定選哪個就用「自動」。若模型額度用盡，系統會自動改用下一個可用模型，'
    + '十分鐘後再回頭嘗試，練習不會中斷。'));

  // OpenRouter 有 300 多個模型，沒有搜尋根本找不到
  if (st.models.length > 30) {
    const f = el('input');
    f.id = 'm-filter'; f.type = 'search'; f.placeholder = `搜尋模型（共 ${st.models.length} 個）`;
    f.value = modelFilter;
    f.oninput = () => { modelFilter = f.value; renderModels().then(() => $('#m-filter')?.focus()); };
    b.append(f);
  }

  const pick = async id => {
    savePin(id);
    await api('/models/set', { model: id });
    toast(id ? `已改用 ${id}` : '已改為自動選擇');
    renderModels();
  };

  const row = (id, label, extra) => {
    const on = st.pinned === id;                      // id 為 null 時代表「自動」
    const r = el('button', 'doc' + (on ? ' on' : ''));
    r.style.cssText = 'width:100%;text-align:left;font:inherit;color:inherit';
    const info = el('div', 'info');
    info.append(el('b', null, (on ? '● ' : '○ ') + label));
    if (extra) info.append(el('small', null, extra));
    r.append(info);
    if (on) r.append(el('span', 'badge', '使用中'));
    r.onclick = () => pick(id);
    return r;
  };

  const c = el('div', 'card');
  c.append(el('h4', null, '選擇模型'));
  const auto = st.auto.fast === st.auto.judge
    ? `目前會用 ${st.auto.fast || '—'}`
    : `演練用 ${st.auto.fast || '—'}，評分用 ${st.auto.judge || '—'}`;
  c.append(row(null, '自動（推薦）', auto));

  // 推薦的排前面，其餘按名稱排序——原始模型代號隨機排列沒人選得下去
  const rec = st.recommended || [];
  const q = modelFilter.trim().toLowerCase();
  let sorted = st.models
    .filter(m => !q || m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const ra = rec.indexOf(a.id), rb = rec.indexOf(b.id);
      if (ra !== rb) return (ra < 0 ? 999 : ra) - (rb < 0 ? 999 : rb);
      return a.id.localeCompare(b.id);
    });

  // 沒搜尋時不要一次塞幾百列，DOM 會很慢
  const LIMIT = 30;
  const hidden = Math.max(0, sorted.length - LIMIT);
  if (!q && hidden) sorted = sorted.slice(0, LIMIT);

  for (const m of sorted) {
    const cd = cooling.get(m.id);
    c.append(row(m.id, m.id + (m.free ? ' (Free)' : ''), [
      rec.includes(m.id) ? '★ 推薦' : null,
      m.label !== m.id ? m.label : null,
      cd ? `⚠️ 額度用盡，約 ${cd} 分鐘後恢復` : null,
    ].filter(Boolean).join('　·　')));
  }
  if (hidden) c.append(el('p', 'note', `另有 ${hidden} 個模型未顯示，請用上方搜尋框尋找。`));
  if (q && !sorted.length) c.append(el('p', 'note', '找不到符合的模型。'));
  b.append(c);

  const freeCount = st.models.filter(m => m.free).length;
  b.append(el('p', 'note',
    `共偵測到 ${st.models.length} 個可用模型（其中 ${freeCount} 個免費），清單來自你的金鑰實際查詢結果。`));

  if (freeCount) {
    const w = el('div', 'card warn');
    w.append(el('h4', null, '關於標「(Free)」的免費模型'));
    w.append(el('p', null, '免費模型不會產生費用，但實測有三個明顯限制：'));
    w.append(list([
      '慢。實測約 7～20 秒才回一句話，語音對練會覺得客戶反應遲鈍。',
      '常排不進去。所有人共用同一個流量池，經常回「使用的人太多」，跟你的額度無關。',
      '中文品質不穩。部分模型會回簡體字或夾雜其他語言。',
    ]));
    w.append(el('p', 'note', '結論：免費模型適合先試試看功能。要真的拿來練語音對談，建議用 Google Gemini 的免費金鑰，或在 OpenRouter 儲值後改用付費模型。'));
    b.append(w);
  }
  b.scrollTop = 0;
}

function logout(reason) {
  abort();
  localStorage.removeItem(AKEY_KEY);
  if (reason) { $('#lg-msg').className = 'note err'; $('#lg-msg').textContent = reason; }
  show('login');
}

const busy = (msg, on = true) => {
  $('#wait-msg').textContent = msg;
  $('#wait-spin').hidden = false; $('#eval-fail').hidden = true;
  if (on) show('wait');
};

// ── 首頁六大功能 ────────────────────────────────────────────
document.querySelectorAll('[data-fn]').forEach(b => b.onclick = () => {
  const fn = b.dataset.fn;
  S.fn = fn;
  if (fn === 'product') { S.docPick = 'product'; return show('docs'); }
  if (fn === 'claim') return openClaim();
  if (fn === 'chat') { renderChat(); return show('chat'); }
  openIntake(fn);
});

// ── 客戶資料表單 ────────────────────────────────────────────
const CTX_LABEL = {
  call: '這通電話的情境',
  needs: '這次見面的由來',
  product: '這次談商品的由來',
};

function openIntake(fn) {
  S.fn = fn;
  $('#i-title').textContent = fn === 'pain' ? '客戶潛在痛點分析' : (MODE_TITLE[fn] || '設定客戶');
  $('#i-diff-wrap').hidden = fn === 'pain';
  $('#i-ctx-wrap').hidden = fn === 'pain';
  $('#i-ctx-label').firstChild.nodeValue = CTX_LABEL[fn] || '接觸情境';
  $('#i-product').hidden = fn !== 'product';
  if (fn === 'product' && S.doc) $('#i-product-name').textContent = S.doc.title;
  $('#btn-go').textContent = fn === 'pain' ? '分析痛點' : '建立客戶';
  const p = prefs();                       // 沿用上次的難度與情境，不用每次重選
  if (p.diff) setChip('#f-diff', p.diff);
  if (p.ctx) setChip('#f-ctx', p.ctx);
  syncDifficulty();
  show('intake');
}

for (const id of ['#f-gender', '#f-diff', '#f-ctx']) {
  $(id).addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $(id).querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    if (id === '#f-diff') syncDifficulty();
  });
}
const pick = id => $(id).querySelector('.chip.on')?.dataset.v;
const setChip = (id, v) => { const c = v && $(id).querySelector(`.chip[data-v="${v}"]`); if (c) c.click(); };

// 偏好設定。原本難度與情境每次都要重選，新進夥伴常常忘了調回「新手友善」。
const PREFS_KEY = 'aicoach.prefs';
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } };
function savePrefs(p) {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...p, updatedAt: Date.now() }));
  syncSoon();
}

// 讓使用者選難度前就知道會遇到什麼樣的客戶
const DIFF_HINT = {
  1: '客戶溫和有耐心，你講不順時他會善意幫你接話，不會掛電話。第一次練習建議從這裡開始。',
  2: '客戶態度正常，需要一個合理的理由才願意聽下去。',
  3: '客戶在忙、講話簡短，並且有一個明確的異議要你處理。',
  4: '客戶防備心強，回答很短，會接連丟出兩到三個異議。',
  5: '接近真實的難搞客戶：連續拒絕、資訊給得少，隨時可能結束對話。',
};
const syncDifficulty = () => { $('#diff-hint').textContent = DIFF_HINT[pick('#f-diff')] || ''; };

$('#btn-go').onclick = async () => {
  const background = $('#f-bg').value.trim();
  const age = $('#f-age').value.trim();
  if (!background) return toast('請先描述一下客戶背景');
  const customer = { gender: pick('#f-gender'), age, background };
  S.lastCustomer = customer;

  if (S.fn === 'pain') {
    busy('正在分析這位客戶可能的痛點…');
    try { renderPain(await api('/analyze/pain', customer)); show('pain'); }
    catch (e) { if (e.auth) return logout(e.message); toast(e.message); show('intake'); }
    return;
  }

  busy('正在建立客戶…');
  try {
    const d = await api('/session/start', {
      ...customer, mode: S.fn, difficulty: pick('#f-diff'), docId: S.doc?.id,
      context: pick('#f-ctx'), contextNote: $('#f-ctxnote').value.trim(),
    });
    savePrefs({ diff: pick('#f-diff'), ctx: pick('#f-ctx') });
    S.sessionId = d.sessionId; S.persona = d.persona; S.ended = false;
    $('#b-title').textContent = MODE_TITLE[S.fn] || '演練前準備';
    $('#b-name').textContent = d.persona.name;
    $('#b-summary').textContent = [d.persona.summary, d.contextLabel, d.persona.difficultyLabel]
      .filter(Boolean).join('　·　');
    $('#b-obj').textContent = d.scenario?.objective || '';
    $('#b-open').textContent = d.demo?.opening || '';
    $('#b-q').textContent = d.demo?.key_question || '';
    $('#b-oc').textContent = '客戶：' + (d.demo?.objection_handling?.customer || '');
    $('#b-oy').textContent = '你：' + (d.demo?.objection_handling?.you || '');
    $('#b-learn').hidden = S.fn !== 'product' || !S.doc;
    show('brief');
  } catch (e) { if (e.auth) return logout(e.message); toast(e.message); show('intake'); }
};

// ── 功能一：痛點分析結果 ────────────────────────────────────
function renderPain(d) {
  const b = $('#pain-body'); b.innerHTML = '';
  if (d.profile) { const c = el('div', 'card'); c.append(el('h4', null, '對這位客戶的理解'), el('p', null, d.profile)); b.append(c); }

  const c1 = el('div', 'card'); c1.append(el('h4', null, '三個可能的潛在痛點'));
  d.points.forEach((p, i) => {
    const w = el('div', 'pt');
    w.append(el('b', null, `${i + 1}. ${p.pain}`));
    w.append(el('p', 'ev', '推測原因：' + (p.reason || '')));
    w.append(el('p', null, '可能需求：' + (p.need || '')));
    w.append(el('p', 'lbl', '你可以這樣問'), el('p', 'quote', p.question || ''));
    c1.append(w);
  });
  b.append(c1);

  if (d.approach) {
    const c2 = el('div', 'card'); c2.append(el('h4', null, '建議的接觸方式'));
    if (d.approach.channel) { c2.append(el('p', 'lbl', '管道與時機'), el('p', null, d.approach.channel)); }
    if (d.approach.opening) { c2.append(el('p', 'lbl', '開場可以這樣說'), el('p', 'quote', d.approach.opening)); }
    if (d.approach.avoid) { c2.append(el('p', 'lbl', '要避免'), el('p', null, d.approach.avoid)); }
    b.append(c2);
  }
  b.append(el('p', 'note', '以上皆為依有限資訊所做的推測，實際情況仍須透過提問確認。'));
  b.scrollTop = 0;
}

$('#btn-pain2call').onclick = () => openIntake('call');

// ── 文件知識庫 ──────────────────────────────────────────────
async function renderDocs() {
  const kind = S.docPick;
  $('#d-title').textContent = kind === 'product' ? '選擇商品教材' : '我的文件';
  $('#d-hint').textContent = '支援 PDF、Word（.docx）、PowerPoint（.pptx）、純文字，單檔 18MB 以內。';

  const b = $('#doc-body'); b.innerHTML = '';
  let docs = [];
  try { docs = (await api('/doc/list', { kind })).docs; } catch (e) { return toast(e.message); }

  if (!docs.length) {
    b.append(el('p', 'upl', kind ? '還沒有文件，先上傳一份吧。' : '還沒有上傳任何文件。'));
  }

  for (const d of docs) {
    const row = el('div', 'doc');
    const info = el('div', 'info');
    info.append(el('b', null, d.title || d.name));
    const meta = [d.kind === 'policy' ? '保單條款' : '商品教材', d.name,
      d.pages ? `${d.pages} 頁` : null, new Date(d.at).toLocaleDateString('zh-TW')].filter(Boolean).join('　');
    info.append(el('small', null, meta));
    row.append(info);

    if (kind) {
      const use = el('button', 'btn sm', '使用');
      use.onclick = () => chooseDoc(d);
      row.append(use);
    }
    const del = el('button', 'del', '🗑');
    del.onclick = async ev => {
      ev.stopPropagation();
      if (!confirm(`刪除「${d.title || d.name}」？`)) return;
      await api('/doc/delete', { id: d.id }); renderDocs();
    };
    row.append(del);
    b.append(row);
  }
}

function chooseDoc(d) {
  S.doc = { id: d.id, title: d.title || d.name };
  S.docPick = null;
  openLearn('pick');           // 文件頁只有選商品教材時才有「使用」；保單在理賠諮詢的第二步勾選
}

// ── 商品重點教學 ────────────────────────────────────────────
// 每份教材第一次選用時一定會出現；看過之後按鈕變成「跳過，直接演練」，
// 老手不用每次被擋。演練前準備頁可以「回看」（review），看完回到準備頁，演練不中斷。
let learnFrom = 'pick', learnView = null;

async function openLearn(from) {
  learnFrom = from;
  busy('正在載入商品重點…');
  try { learnView = await api('/doc/lesson', { id: S.doc.id }); }
  catch (e) { if (e.auth) return logout(e.message); toast(e.message); return show(from === 'review' ? 'brief' : 'docs'); }
  $('#l-go').textContent = from === 'review' ? '回到演練前準備'
    : learnView.seen ? '跳過，直接演練' : '看完了，開始設定客戶';
  renderLearn(!learnView.seen && from === 'pick');
  show('learn');
}

// 展開式卡片：手機上內容很長，一次只看一塊
function fold(title, open, ...kids) {
  const d = el('details', 'card fold'); d.open = open;
  d.append(el('summary', null, title), ...kids);
  return d;
}

function renderLearn(first) {
  const v = learnView, g = v.digest || {}, b = $('#l-body');
  b.innerHTML = '';
  const has = x => x && !/^教材未載明/.test(String(x).trim());

  const top = el('div', 'card');
  top.append(el('h3', null, v.title));
  if (has(g.overview)) top.append(el('p', null, g.overview));
  if (has(g.target)) top.append(el('p', 'lbl', '最適合的客戶'), el('p', null, g.target));
  b.append(top);

  if (v.keyPoints?.length) {
    const c = el('div', 'card key');
    c.append(el('h4', null, '🎯 演練時要講到的重點'));
    const ol = el('ol'); v.keyPoints.forEach(k => ol.append(el('li', null, k))); c.append(ol);
    c.append(el('p', 'note', '演練結束後，教練回饋會逐點檢查你有沒有把這幾點講給客戶聽。'));
    b.append(c);
  }

  b.append(coachCard());

  if (g.coverages?.length) {
    const u = el('ul');
    g.coverages.forEach(x => { const li = el('li'); li.append(el('b', null, x.name || ''), document.createTextNode('：' + (x.detail || ''))); u.append(li); });
    b.append(fold('保障內容', false, u));
  }
  if (g.selling_points?.length) {
    const w = el('div');
    g.selling_points.forEach(s => {
      const d = el('div', 'fabe');
      d.append(el('b', null, s.feature || ''));
      if (has(s.advantage)) d.append(el('p', null, '優勢：' + s.advantage));
      if (has(s.benefit)) d.append(el('p', null, '對客戶的好處：' + s.benefit));
      d.append(el('p', 'muted', '教材佐證：' + (s.evidence || '教材未提供佐證')));
      w.append(d);
    });
    b.append(fold('賣點（FABE）', first, w));
  }
  if (g.objections?.length) {
    const w = el('div');
    g.objections.forEach(o => {
      const d = el('div', 'fabe');
      d.append(el('p', 'quote', '客戶：' + (o.q || '')), el('p', null, '你：' + (o.a || '')));
      w.append(d);
    });
    b.append(fold('客戶常見疑慮與回應', first, w));
  }
  if (g.compliance?.length) b.append(fold('合規注意事項', false, list(g.compliance)));
  if (g.missing?.length) {
    const f = fold('⚠️ 教材沒寫、不能亂講', false, el('p', 'note', '客戶問到這些，老實說「我回去確認後再跟您說明」。'), list(g.missing));
    f.classList.add('warn');
    b.append(f);
  }
  b.scrollTop = 0;
}

// 第二層：教練講解。按了才產生，存起來之後直接顯示
function coachCard() {
  const L = learnView.lesson;
  if (!L) {
    const c = el('div', 'card');
    c.append(el('h4', null, '✨ 教練講解'));
    c.append(el('p', 'muted', '30 秒介紹稿、必講重點怎麼講、怎麼從客戶需求帶到商品、常見的講錯。'));
    const btn = el('button', 'btn', '產生教練講解');
    const note = el('p', 'note', '會使用你的 API 額度。每份教材只產生一次，之後會存起來重複看。');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '教練準備中…約 10～20 秒';
      try {
        const r = await api('/doc/coach', { id: S.doc.id });
        learnView.lesson = r.lesson; learnView.keyPoints = r.keyPoints;
        renderLearn(false);
        $('#l-body .coach')?.scrollIntoView({ block: 'start' });
      } catch (e) {
        if (e.auth) return logout(e.message);
        toast(e.message, 5000); btn.disabled = false; btn.textContent = '產生教練講解';
      }
    };
    c.append(btn, note);
    return c;
  }

  const c = el('div', 'card coach');
  c.append(el('h4', null, '✨ 教練講解'));
  if (L.pitch) c.append(el('p', 'lbl', '30 秒介紹稿'), el('p', null, L.pitch));
  if (L.key_points?.length) {
    c.append(el('p', 'lbl', '必講重點怎麼講'));
    L.key_points.forEach((k, i) => {
      const d = el('div', 'fabe');
      d.append(el('b', null, `${i + 1}. ${k.point}`));
      if (k.why) d.append(el('p', 'muted', '客戶在意的是：' + k.why));
      if (k.say) d.append(el('p', null, '「' + k.say.replace(/^「|」$/g, '') + '」'));
      c.append(d);
    });
  }
  if (L.bridges?.length) {
    c.append(el('p', 'lbl', '從客戶需求帶到商品'));
    L.bridges.forEach(x => {
      const d = el('div', 'fabe');
      if (x.need) d.append(el('b', null, x.need));
      d.append(el('p', null, '問：「' + x.ask.replace(/^「|」$/g, '') + '」'));
      if (x.link) d.append(el('p', 'muted', '接著：' + x.link));
      c.append(d);
    });
  }
  if (L.order?.length) {
    c.append(el('p', 'lbl', '建議的講解順序'));
    const ol = el('ol'); L.order.forEach(x => ol.append(el('li', null, x))); c.append(ol);
  }
  if (L.pitfalls?.length) c.append(el('p', 'lbl', '常見的講錯'), list(L.pitfalls));
  return c;
}

$('#l-go').onclick = () => {
  if (learnFrom === 'review') return show('brief');
  if (!learnView.seen) api('/doc/seen', { id: S.doc.id }).catch(() => {});
  openIntake('product');
};
$('#l-back').onclick = () => {
  if (learnFrom === 'review') return show('brief');
  S.docPick = 'product'; show('docs');
};
$('#b-learn').onclick = () => openLearn('review');

$('#btn-upload').onclick = () => { S.uploadTo = null; $('#f-file').click(); };

$('#f-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 18 * 1024 * 1024) return toast('檔案超過 18MB，請壓縮或分割');

  const toCase = S.uploadTo === 'cp';
  let kind = toCase ? 'policy' : S.docPick;
  if (!kind) kind = confirm('這份文件是「保單條款」嗎？\n\n確定＝保單條款（理賠查詢用）\n取消＝商品教材（行銷演練用）') ? 'policy' : 'product';

  busy(`正在解析「${f.name}」…\n文件較長時可能需要一兩分鐘`);
  try {
    const base64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('檔案讀取失敗'));
      r.readAsDataURL(f);
    });
    const d = await api('/doc/upload', { name: f.name, kind, base64 });
    toast(d.warning ? `已建立「${d.title}」，但⚠️ ${d.warning}` : `已建立知識庫：${d.title}`, d.warning ? 7000 : 2800);
    if (toCase) {                 // 理賠諮詢裡上傳的，直接幫他勾起來
      S.uploadTo = null;
      if (S.claim.policies.length < MAX_POL) S.claim.policies.push({ docId: d.id, plan: '', start: '' });
      return openPolicies(false);
    }
    S.docPick = kind === 'product' ? 'product' : null;
  } catch (e) {
    if (e.auth) return logout(e.message);
    toast(e.message, 5000);
    if (toCase) { S.uploadTo = null; return show('cp'); }
  }
  show('docs');
};

// ── Voice Engine ────────────────────────────────────────────
// 自動收音的排程。用 epoch 擋掉過期的排程：使用者自己按了麥克風、
// 打字送出、或演練結束之後，先前排定的「幾秒後開麥克風」都必須作廢，
// 否則會在 AI 正在思考時突然開始收音。
let listenTimer = 0, listenEpoch = 0, emptyTries = 0, stallTries = 0;
const cancelListen = () => { clearTimeout(listenTimer); listenEpoch++; };

// 語音引擎只有一個（iOS 上多開 AudioContext／辨識器很容易互相卡住），
// 演練與「問問其他問題」共用；callback 依目前畫面分派。
let vmode = 'play';
const voice = new Voice({
  onPartial: t => { if (vmode === 'chat') return chatV.partial(t); if (t) setStatus('🎙️ ' + t, 'live'); },
  onFinal: t => { if (vmode === 'chat') return chatV.final(t); emptyTries = 0; stallTries = 0; submit(t); },
  // 沒聽到話：手機上很常見（使用者在想、在看畫面），自動再聽幾輪
  onEmpty: () => {
    if (vmode === 'chat') return chatV.empty();
    if (++emptyTries <= 3) return nextTurn(600);
    emptyTries = 0;
    setStatus('沒有聽到聲音，點一下麥克風再說');
  },
  // 收音卡住：重接兩次，還不行就交給使用者
  onStall: () => {
    if (vmode === 'chat') return chatV.stall();
    if (++stallTries <= 2) { setStatus('麥克風重新連接中…'); return nextTurn(800); }
    stallTries = 0;
    setStatus('麥克風沒有反應，點一下麥克風再試；也可以直接打字');
  },
  onState: s => {
    // 真人語音失敗、改用內建朗讀。只提示一次——每句都跳會很煩，
    // 而之後幾句通常也會走內建（有冷卻），使用者知道原因就好。
    if (s === 'tts-quota-day') return quotaNotice();
    if (s === 'tts-fallback') {
      if (!ttsNotice) { ttsNotice = true; toast('真人語音暫時無法使用，先改用手機內建語音', 3500); }
      return;
    }
    if (vmode === 'chat') return chatV.state(s);
    const m = $('#btn-mic');
    m.classList.toggle('rec', s === 'listening');
    m.classList.toggle('talk', s === 'speaking');
    if (s === 'listening') setStatus('🎙️ 請說話…', 'live');
    else if (s === 'speaking') setStatus('客戶正在說話（點麥克風可打斷）');
    else if (typeof s === 'string' && s.startsWith('error:')) {
      setStatus('');
      toast(s.includes('not-allowed') ? '麥克風權限被拒絕，請到 Safari 設定開啟' : '沒聽清楚，再說一次或直接打字');
    }
  },
});

// 真人語音（Gemini TTS）：用使用者同一把 Google AI Studio 金鑰。
// 金鑰每次呼叫時才讀——使用者換金鑰或登出後，不會拿著舊的去呼叫。
let ttsNotice = false;
// 同一把金鑰、三個語音模型輪流（免費額度每個模型各自算）。
// 哪個模型被擋、到什麼時候，記在手機裡，關掉 App 再打開也不會重複去撞。
const TTSQ_KEY = 'aicoach.ttsq';
const tts = new TtsRotator({ store: {
  load: () => JSON.parse(localStorage.getItem(TTSQ_KEY) || '{}'),
  save: st => localStorage.setItem(TTSQ_KEY, JSON.stringify(st)),
} });
voice.cloud = {
  // hint.cloudVoice：指定聲線（教練）；沒有就依性別挑（演練客戶）
  stream: (text, gender, signal, hint) => {
    const { provider, key } = cred();
    if (provider !== 'gemini' || !key) throw new Error('tts no key');
    return tts.stream(key, text, hint?.cloudVoice || voiceFor(gender), signal);
  },
};
// 三個語音模型今天的免費額度都用完了。學員突然聽到機械聲，會以為 App 壞了——
// 所以講清楚原因、幾點恢復，順便教 iPhone 下載好聽一點的內建語音。每天只講一次。
const QUOTA_NOTICE_KEY = 'aicoach.ttsq.notice';
function quotaNotice() {
  const reset = nextPacificMidnight();
  if (localStorage.getItem(QUOTA_NOTICE_KEY) === String(reset)) return;
  localStorage.setItem(QUOTA_NOTICE_KEY, String(reset));
  // 台灣時間下午 3～4 點重算：過了這個時間才用完的話，要等到「明天」
  const day = new Date(reset).toDateString() === new Date().toDateString() ? '今天' : '明天';
  const at = new Date(reset).toLocaleTimeString('zh-TW', { hour: 'numeric', minute: '2-digit' });
  const lead = `Google 免費的真人語音每天有上限，今天的已經用完，<b>${day}${at}會恢復</b>。`
    + '在那之前 AI 對話照常，只是聲音先改用手機內建的朗讀。';
  if (!platform().ios) return sheet('今天的免費真人語音用完了', lead, [], { why: false });
  sheet('今天的免費真人語音用完了', lead + '<br>iPhone 內建的聲音可以免費換成好聽很多的版本：', [
    ['打開「設定」→「輔助使用」→「朗讀內容」→「聲音」'],
    ['選「中文（台灣）」→「美佳」，下載<b>加強版</b>', '檔案約一兩百 MB，建議連 Wi-Fi 下載'],
    ['下載完回到 App，之後的內建聲音就會自然很多'],
  ], { why: false });
}

const speakHint = () => ({ ...(S.persona?.voice || {}), gender: S.persona?.gender });

const setStatus = (t, cls = '') => { const n = $('#p-status'); n.textContent = t; n.className = 'status ' + cls; };

// iOS 預設給網頁用的中文語音是壓縮版，聽起來明顯是機器聲。
// 下載加強版之後音質差距很大，而這件事使用者不會自己知道——所以提示一次。
const VOICE_HINT_KEY = 'aicoach.voicehint';
function hintVoiceQuality() {
  if (voice.cloud) return;                       // 用真人語音時，內建語音的音質就不重要了
  if (localStorage.getItem(VOICE_HINT_KEY)) return;
  const v = voiceInfo();
  if (!v || v.enhanced) return;                 // 已經是加強版就不用囉唆
  localStorage.setItem(VOICE_HINT_KEY, '1');
  toast('想讓客戶的聲音更像真人？iPhone：設定 → 輔助使用 → 旁白 → 語音 → 中文 → 下載「加強版」', 9000);
}

function push(log, speaker, text) {
  const n = $(log);
  n.appendChild(el('div', 'msg ' + speaker, text));
  n.scrollTop = n.scrollHeight;
}

// ── 開始演練 ────────────────────────────────────────────────
$('#btn-start').onclick = async () => {
  voice.unlock();                                    // 必須在使用者手勢中
  voice.resetStats();
  $('#p-log').innerHTML = ''; $('#p-name').textContent = S.persona.name;
  $('#p-found').hidden = S.fn !== 'needs';
  if (S.fn === 'needs') $('#p-found').textContent = '已挖到 0 項';
  S.ended = false; show('play');
  if (!supported.stt) toast('這個瀏覽器不支援語音辨識，請用下方文字輸入', 4000);
  else hintVoiceQuality();
  try {
    const d = await api('/session/begin', { sessionId: S.sessionId });
    push('#p-log', 'customer', d.opening);
    await voice.speak(d.opening, speakHint());
    nextTurn();
  } catch (e) { toast(e.message); }
};

// delay：剛播完朗讀就用 MIC_AFTER_TTS_MS（iOS 要等音訊通道釋放），
// 其他情況（沒有朗讀、自動重試）用短一點的值。
function nextTurn(delay = MIC_AFTER_TTS_MS) {
  if (S.ended) return;
  if (!supported.stt) return setStatus('請用下方輸入框回覆');
  // 使用者在客戶講話時就點了麥克風插話——麥克風已經在他手上，不必再排
  if (voice.state === 'listening') return;
  clearTimeout(listenTimer);
  const ep = ++listenEpoch;
  if (delay > 1000) setStatus('正在切回麥克風…（點麥克風可以直接開始）');
  listenTimer = setTimeout(() => {
    if (ep !== listenEpoch || S.ended || S.busy) return;
    if (!document.querySelector('#s-play.on')) return;     // 已經離開演練畫面
    if (voice.state !== 'idle') return;                    // 等待期間使用者自己開了麥克風
    if (!voice.listen()) setStatus('點一下麥克風開始說話');
  }, delay);
}

$('#btn-mic').onclick = () => {
  voice.unlock();
  cancelListen();                    // 使用者自己按了：取消排定的自動收音（也就是跳過等待）
  emptyTries = 0; stallTries = 0;
  if (voice.state === 'speaking') { voice.stopSpeaking(); voice.listen(); }
  else if (voice.state === 'listening') voice.stopListening();
  else voice.listen();
};

$('#btn-send').onclick = () => {
  const t = $('#p-text').value.trim();
  if (t) { $('#p-text').value = ''; voice.abortListening(); submit(t); }
};
$('#p-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-send').click(); });

async function submit(text) {
  if (S.busy || S.ended || !S.sessionId) return;
  cancelListen();
  S.busy = true;
  push('#p-log', 'user', text);
  setStatus('思考中…', 'think');
  try {
    const d = await api('/session/turn', { sessionId: S.sessionId, text });

    if (d.type === 'compliance') {
      push('#p-log', 'system', d.text);
      setStatus(''); S.busy = false;
      toast('偵測到合規風險，演練已暫停');
      return nextTurn(300);
    }

    push('#p-log', 'customer', d.text);
    if (S.fn === 'needs') $('#p-found').textContent = `已挖到 ${d.revealed}／${d.totalHidden} 項`;
    if (d.warn) toast('注意用語：' + d.warn[0], 3600);
    S.busy = false;
    await voice.speak(d.text, speakHint());

    if (d.ended) { S.ended = true; setStatus('這次談話結束了'); setTimeout(finish, 900); }
    else nextTurn();
  } catch (e) {
    S.busy = false; setStatus('');
    if (e.auth) { S.sessionId = null; return logout(e.message); }
    toast(e.message);
    if (/逾時/.test(e.message)) { S.sessionId = null; show('home'); }
  }
}

$('#btn-end').onclick = () => { S.ended = true; cancelListen(); voice.reset(); finish(); };

async function finish() {
  if (!S.sessionId) return show('home');
  cancelListen(); voice.reset(); busy('正在分析你剛才的表現…');
  const id = S.sessionId;
  try {
    const fb = await api('/session/end', { sessionId: id });
    S.sessionId = null;                     // 評分成功才放掉——之前是呼叫前就清掉，
    fb.voiceStats = voice.stats();          // 評分一失敗整場逐字稿就跟著消失
    renderFeedback(fb); saveHistory(fb); show('fb');
  } catch (e) {
    if (e.auth) return logout(e.message);          // 金鑰失效：和其他畫面一樣回登入頁
    // 逐字稿還在引擎裡（也存在 sessionStorage），留在這個畫面讓使用者重試。
    // 最常見的原因是免費額度一時用完（Groq 每分鐘 8000 tokens、Gemini 429），
    // 等一下再按通常就好了。
    $('#wait-spin').hidden = true;
    $('#wait-msg').textContent = '評分沒有完成';
    $('#eval-why').textContent = e.message.replace(/[。.！!\s]+$/, '')
      + '。你的對話紀錄都還在，稍等一下再按「重新評分」就可以。';
    $('#eval-fail').hidden = false;
  }
}

$('#eval-retry').onclick = () => finish();
$('#eval-drop').onclick = () => {
  if (!confirm('放棄之後，這場演練的對話紀錄就不會留下。確定？')) return;
  abort(); show('home');
};

function abort() {
  if (S.sessionId) api('/session/abort', { sessionId: S.sessionId }).catch(() => {});
  S.sessionId = null; S.ended = true; cancelListen(); voice.reset();
}

$('#btn-again').onclick = () => openIntake(S.fn);

// ── 回饋畫面 ────────────────────────────────────────────────
const NAMES = {
  fluency: '說話流暢度', friendliness: '聲音親切感', awareness: '內容掌握',
  confidence: '自信心', professionalism: '專業度',
};

function starRow(name, score, ev) {
  const w = el('div');
  const r = el('div', 'row');
  r.append(el('span', 'nm', name));
  const st = el('span', 'stars', '★★★★★');
  st.setAttribute('aria-label', `${name} ${score} 顆星`);
  const fill = el('i', null, '★★★★★');
  fill.setAttribute('aria-hidden', 'true');
  fill.style.width = (score / 5 * 100) + '%';
  st.append(fill); r.append(st);
  r.append(el('span', 'sc', score.toFixed(1)));
  w.append(r);
  if (ev) w.append(el('p', 'ev', ev));
  return w;
}

const card = (title, ...kids) => { const c = el('div', 'card'); if (title) c.append(el('h4', null, title)); c.append(...kids); return c; };
const list = arr => { const u = el('ul'); arr.forEach(x => u.append(el('li', null, x))); return u; };

function renderFeedback(fb) {
  const b = $('#fb-body'); b.innerHTML = '';
  b.append(card(fb.modeName ? `總評（${fb.modeName}）` : '總評', el('p', null, fb.summary || '')));

  const c2 = el('div', 'card'); c2.append(el('h4', null, '五項能力評分'));
  for (const k of Object.keys(NAMES)) {
    const s = fb.scores?.[k]; if (!s) continue;
    c2.append(starRow(NAMES[k], s.score, s.evidence));
  }
  b.append(c2);

  if (fb.key_points?.length) {
    const got = fb.key_points.filter(k => k.covered).length;
    const c = el('div', 'card key');
    c.append(el('h4', null, `🎯 商品必講重點（講到 ${got}／${fb.key_points.length}）`));
    fb.key_points.forEach(k => {
      const d = el('div', 'kp');
      d.append(el('b', null, (k.covered ? '✅ ' : '⬜ ') + k.point));
      if (k.note) d.append(el('p', 'ev', k.note));
      c.append(d);
    });
    b.append(c);
  }

  if (fb.positives?.length) b.append(card('你做得好的地方', list(fb.positives)));

  if (fb.improvements?.length) {
    const c = el('div', 'card'); c.append(el('h4', null, '最值得調整的地方'));
    fb.improvements.forEach(i => {
      const d = el('div', 'imp');
      d.append(el('b', null, i.point || ''), el('p', 'ev', i.why || ''), el('p', null, i.how || ''));
      c.append(d);
    });
    b.append(c);
  }

  if (fb.example_script) b.append(card('示範話術', el('p', null, fb.example_script)));

  if (fb.compliance_note) {
    const bad = !/未發現|沒有|無違規/.test(fb.compliance_note);
    const c = el('div', 'card' + (bad ? ' warn' : ''));
    c.append(el('h4', null, '合規檢查'), el('p', null, fb.compliance_note)); b.append(c);
  }

  if (fb.next_challenge) b.append(card('下一次的挑戰', el('p', null, fb.next_challenge)));

  if (fb.hidden_needs?.length) {
    const got = new Set(fb.revealed || []);
    const c = el('div', 'card');
    c.append(el('h4', null, `這位客戶心裡真正在意的事（挖到 ${got.size}／${fb.hidden_needs.length}）`));
    const u = el('ul');
    fb.hidden_needs.forEach(h => u.append(el('li', null, (got.has(h) ? '✅ ' : '⬜ ') + h)));
    c.append(u); b.append(c);
  }

  const m = fb.metrics || {};
  const vs = fb.voiceStats;
  b.append(el('p', 'note',
    `回合數 ${m.turns}｜對談 ${m.durationSec} 秒｜客戶最終信任度 ${m.finalTrust}/100`
    + `｜AI 生成 ${fb.avgLatencyMs} ms`
    + (vs ? `｜你說完到客戶開口 平均 ${vs.avg} ms（最快 ${vs.best}／最慢 ${vs.worst}）` : '')));
  b.scrollTop = 0;
}

// ── 功能五：理賠諮詢 ────────────────────────────────────────
// 情境是客戶打電話來問「這個有沒有賠、賠多少」：
//   ① 客戶的狀況 → ② 客戶的保單（可多張、各填保額）→ ③ 分析結果（可補充後重新分析）
// 「記住這位客戶」只存稱呼＋保單＋保額，存在這支手機；病況一律不存。
const CL_KEY = 'aicoach.clients';
const MAX_POL = 5;                         // 與 engine/advisor.js 的 MAX_POLICIES 一致
const fmt = n => Number(n).toLocaleString('en-US');

const savedClients = () => { try { return JSON.parse(localStorage.getItem(CL_KEY) || '[]'); } catch { return []; } };
function storeClient(name, policies, keep) {
  try {
    const list = savedClients().filter(c => c.name !== name);
    if (keep && name) list.unshift({ name, at: Date.now(), policies: policies.map(({ docId, plan, start }) => ({ docId, plan, start })) });
    localStorage.setItem(CL_KEY, JSON.stringify(list.slice(0, 30)));
  } catch { /* 容量滿時忽略 */ }
}

const caseTags = () => [...$('#cs-tags').querySelectorAll('.chip.on')].map(c => c.dataset.v);
function syncCaseFields() {
  const t = caseTags();
  $('#cs-f-days').hidden = !t.includes('住院');
  $('#cs-f-surgery').hidden = !t.includes('手術');
}

function openClaim() {
  S.claim = { client: {}, situation: {}, policies: [], extra: [], result: null };
  for (const id of ['#cs-name', '#cs-age', '#cs-text', '#cs-days', '#cs-surgery', '#cs-selfpay', '#cs-date']) $(id).value = '';
  document.querySelectorAll('#s-cs .chip.on').forEach(c => c.classList.remove('on'));
  syncCaseFields();
  renderSavedClients();
  show('cs');
}

function renderSavedClients() {
  const list = savedClients(), box = $('#cs-saved');
  box.innerHTML = '';
  $('#cs-saved-wrap').hidden = !list.length;
  for (const c of list) {
    const b = el('button', 'chip', c.name);
    b.onclick = () => {
      $('#cs-name').value = c.name;
      S.claim.policies = (c.policies || []).map(p => ({ ...p }));
      box.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
    };
    box.append(b);
  }
}

// 性別、門診／住院手術：單選，但可以再點一下取消（選填）
for (const id of ['#cs-gender', '#cs-outpt']) {
  $(id).addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    const was = c.classList.contains('on');
    $(id).querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
    if (!was) c.classList.add('on');
  });
}
$('#cs-tags').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  c.classList.toggle('on');
  syncCaseFields();
});

function readCase() {
  const t = caseTags(), outpt = pick('#cs-outpt');
  return {
    client: { name: $('#cs-name').value.trim(), age: $('#cs-age').value.trim(), gender: pick('#cs-gender') || '' },
    situation: {
      tags: t, text: $('#cs-text').value.trim(),
      days: t.includes('住院') ? $('#cs-days').value : '',
      surgery: t.includes('手術') ? $('#cs-surgery').value.trim() : '',
      outpatient: t.includes('手術') && outpt != null ? outpt === '1' : null,
      selfPay: $('#cs-selfpay').value, date: $('#cs-date').value,
    },
  };
}

$('#cs-next').onclick = () => {
  const c = readCase();
  if (!c.situation.tags.length && !c.situation.text) return toast('先選擇狀況，或寫下客戶怎麼說');
  Object.assign(S.claim, c);
  openPolicies(true);
};

// ② 客戶的保單
let policyDocs = [];
async function openPolicies(fresh) {
  try { policyDocs = (await api('/doc/list', { kind: 'policy' })).docs; }
  catch (e) { if (e.auth) return logout(e.message); return toast(e.message); }
  // 存著的客戶可能指到已經刪掉的條款
  const ids = new Set(policyDocs.map(d => d.id));
  S.claim.policies = S.claim.policies.filter(p => ids.has(p.docId));
  if (fresh) {
    const name = S.claim.client.name;
    $('#cp-remember').disabled = !name;
    $('#cp-remember').checked = !!name;
  }
  renderPolicies();
  show('cp');
}

function renderPolicies() {
  const b = $('#cp-list');
  b.innerHTML = '';
  if (!policyDocs.length) b.append(el('p', 'upl', '還沒有保單條款，先上傳一份吧。'));
  for (const d of policyDocs) {
    const sel = S.claim.policies.find(p => p.docId === d.id);
    const row = el('div', 'card sm pol' + (sel ? ' on' : ''));
    const head = el('label', 'inline pol-h');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!sel;
    head.append(cb, el('b', null, d.title || d.name));
    row.append(head);
    if (sel) {
      const plan = el('input'); plan.type = 'text'; plan.value = sel.plan || '';
      plan.placeholder = '例如：計劃 2、日額 2,000、保額 100 萬';
      plan.oninput = () => { sel.plan = plan.value; };
      const start = el('input'); start.type = 'date'; start.value = sel.start || '';
      start.onchange = () => { sel.start = start.value; };
      row.append(el('p', 'lbl', '投保計劃／保額'), plan, el('p', 'lbl', '契約生效日（選填）'), start);
    }
    cb.onchange = () => {
      if (cb.checked) {
        if (S.claim.policies.length >= MAX_POL) { cb.checked = false; return toast(`一次最多分析 ${MAX_POL} 張保單`); }
        S.claim.policies.push({ docId: d.id, plan: '', start: '' });
      } else S.claim.policies = S.claim.policies.filter(p => p.docId !== d.id);
      renderPolicies();
    };
    b.append(row);
  }
}

$('#cp-back').onclick = () => show('cs');
$('#cp-upload').onclick = () => { S.uploadTo = 'cp'; $('#f-file').click(); };
$('#cp-go').onclick = () => {
  if (!S.claim.policies.length) return toast('請勾選至少一張客戶的保單');
  storeClient(S.claim.client.name, S.claim.policies, $('#cp-remember').checked);
  runClaim();
};

// ③ 分析
async function runClaim() {
  const c = S.claim;
  busy(`正在對照 ${c.policies.length} 張保單的條款…\n通常需要 10～30 秒`);
  try {
    c.result = await api('/claim/case', { client: c.client, situation: c.situation, extra: c.extra, policies: c.policies });
    renderClaimResult();
    show('claim');
    return true;
  } catch (e) {
    if (e.auth) return logout(e.message);
    toast(e.message, 5000);
    show(c.result ? 'claim' : 'cp');
    return false;
  }
}

function renderClaimResult() {
  const r = S.claim.result, b = $('#c-log');
  b.innerHTML = '';

  const c0 = card('我理解的狀況', el('p', null, r.understanding || S.claim.situation.text || S.claim.situation.tags.join('、')));
  if (S.claim.extra.length) c0.append(el('p', 'lbl', '補充'), list(S.claim.extra));
  b.append(c0);

  const c1 = el('div', 'card key');
  c1.append(el('h4', null, '初步試算合計'), el('p', 'big', r.total ? `約 ${fmt(r.total)} 元` : '目前算不出金額'));
  if (r.uncounted) {
    const noPlan = S.claim.policies.some(p => !p.plan?.trim());
    c1.append(el('p', 'note', `另有 ${r.uncounted} 個項目沒有算進合計（金額待確認，或把握不高）。`
      + (noPlan ? '回上一步填上投保計劃／保額，可以算得更完整。' : '')));
  }
  b.append(c1);

  if (r.reply) {
    const c = el('div', 'card');
    c.append(el('h4', null, '📞 可以這樣回覆客戶'), el('p', null, r.reply));
    const cp = el('button', 'btn sm', '複製');
    cp.onclick = async () => {
      try { await navigator.clipboard.writeText(r.reply); toast('已複製，可以貼到 LINE'); }
      catch { toast('這個瀏覽器不支援複製，請長按文字選取'); }
    };
    c.append(cp);
    b.append(c);
  }

  for (const p of r.policies) {
    const c = el('div', 'card');
    c.append(el('h4', null, p.title));
    if (p.plan) c.append(el('p', 'muted', '投保計劃／保額：' + p.plan));
    if (p.error) {
      c.append(el('p', 'ev', '這張保單這次分析失敗。可以在下面輸入框補充任何內容後送出，會再分析一次。'));
      b.append(c); continue;
    }
    if (!p.likely.length) c.append(el('p', 'ev', '依這張條款，目前判斷不到符合的給付項目。'));
    for (const x of p.likely) {
      const w = el('div', 'pt');
      const t = el('b', null, x.item);
      t.append(el('span', 'tag ' + x.confidence, { high: '把握高', medium: '需確認', low: '不確定' }[x.confidence]));
      w.append(t, el('p', x.amount != null ? 'amt' : 'ev', x.amount != null ? `初步試算：約 ${fmt(x.amount)} 元` : '金額：待確認'));
      if (x.amount_text) w.append(el('p', 'ev', '給付方式：' + x.amount_text));
      if (x.why) w.append(el('p', 'ev', x.why));
      if (x.source) w.append(el('p', 'ev', '依據：' + x.source));
      c.append(w);
    }
    if (p.unlikely.length) c.append(el('p', 'lbl', '可能不賠或有爭議'), list(p.unlikely.map(x => `${x.item}：${x.why}`)));
    if (!p.grounded) c.append(el('p', 'note', '（這張只依摘要判斷，沒有回頭比對條款原文）'));
    b.append(c);
  }

  if (r.need_to_confirm.length) b.append(card('還需要問客戶', list(r.need_to_confirm), el('p', 'note', '問到答案後，在下面輸入框補充，會重新分析。')));
  if (r.documents.length) b.append(card('要準備的文件', list(r.documents)));
  b.append(el('p', 'note', '⚠️ ' + r.disclaimer));
  b.scrollTop = 0;
}

$('#c-edit').onclick = () => show('cs');
$('#c-send').onclick = async () => {
  const q = $('#c-text').value.trim();
  if (!q || S.busy) return;
  S.claim.extra.push(q);
  if (await runClaim()) $('#c-text').value = '';
  else S.claim.extra.pop();               // 失敗就不要留下這筆補充，使用者可以直接再按一次
};
$('#c-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('#c-send').click(); });

// ── 功能六：行銷諮詢（可以打字，也可以語音對談）────────────────
// 模型偶爾還是會冒出 Markdown 記號，純文字氣泡顯示會很醜，統一清掉
const clean = s => (s || '')
  .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '')
  .replace(/^>\s?/gm, '').replace(/^[-*]\s+/gm, '・').trim();

// 目前這一串對話存在這支手機，下次打開還在；按「清除」才刪。不同步到雲端。
const CHAT_KEY = 'aicoach.chat';
function saveChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(S.chatHistory.slice(-60))); } catch { /* 容量滿時忽略 */ }
}
try { S.chatHistory = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch { S.chatHistory = []; }

// 教練聲音：學員自己選，存在偏好設定（會跟著帳號同步到其他裝置）
const coachGender = () => (prefs().coach === '女' ? '女' : '男');
const coachHint = () => ({ rate: 1, cloudVoice: COACH_VOICES[coachGender()] });

function coachBubble(text) {
  const m = el('div', 'msg coach', text);
  const b = el('button', 'say', '🔊 聽');
  b.onclick = () => {
    voice.unlock();
    if (voice.state === 'speaking') return voice.stopSpeaking();
    CV.ep++; clearTimeout(CV.hold); voice.abortListening();
    voice.speak(text, coachHint()).then(() => { if (CV.on) chatListen(); });
  };
  m.append(b);
  return m;
}

function renderChat() {
  const b = $('#ch-log'); b.innerHTML = '';
  if (!S.chatHistory.length) {
    const m = el('div', 'msg coach');
    m.append(el('p', null, '把你手上遇到的客戶狀況講給我聽，我們一起想怎麼處理。可以打字，也可以按 🎙️ 用講的。例如：'));
    m.append(list(['客戶說要跟老婆商量，之後就不回訊息了', '客戶覺得保費太貴，但我看他其實有預算', '轉介紹來的客戶很客氣，可是都不講真話']));
    b.append(m);
  }
  for (const t of S.chatHistory) {
    if (t.role === 'user') b.append(el('div', 'msg user' + (t.voice ? ' spoken' : ''), t.text));
    else b.append(coachBubble(clean(t.text)));
  }
  $('#ch-coach').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.v === coachGender()));
  b.scrollTop = b.scrollHeight;
}

async function sendChat(q, spoken = false) {
  if (!q || S.busy) return;
  S.busy = true;
  const log = $('#ch-log');
  log.append(el('div', 'msg user' + (spoken ? ' spoken' : ''), q));
  const th = el('div', 'msg coach', '思考中…');
  log.append(th); log.scrollTop = 1e9;
  if (CV.on) chatStatus('教練思考中…', 'think');
  try {
    const d = await api('/coach/chat', { history: S.chatHistory, message: q, voice: CV.on });
    const text = clean(d.reply);
    th.replaceWith(coachBubble(text));
    S.chatHistory.push({ role: 'user', text: q, ...(spoken ? { voice: 1 } : {}) }, { role: 'ai', text: d.reply });
    saveChat();
    if (d.compliance) toast('⚠️ ' + d.compliance[0], 5000);
    S.busy = false; log.scrollTop = 1e9;
    if (CV.on) { await voice.speak(text, coachHint()); chatListen(); }
  } catch (e) {
    S.busy = false;
    if (e.auth) return logout(e.message);
    th.textContent = '發生錯誤：' + e.message;
    if (CV.on) chatStatus('剛剛沒有成功，點麥克風再說一次');
  }
}

$('#ch-send').onclick = () => {
  const q = $('#ch-text').value.trim();
  if (!q || S.busy) return;
  $('#ch-text').value = '';
  sendChat(q);
};
$('#ch-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('#ch-send').click(); });
$('#chat-clear').onclick = () => {
  if (S.chatHistory.length && !confirm('清除這段對話？清除後就找不回來了。')) return;
  S.chatHistory = []; saveChat(); renderChat();
};

$('#ch-coach').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  savePrefs({ coach: c.dataset.v });
  renderChat();
  // 選了就讓他聽一下，比看名字更準。試聽是事先錄好的音檔，不花學員的語音額度
  // （免費額度每分鐘只有 3 句，原本試聽一次就用掉三分之一）。
  voice.unlock();
  CV.ep++; clearTimeout(CV.hold); voice.abortListening(); voice.stopSpeaking();
  previewAudio?.pause();
  previewAudio = new Audio(`audio/coach-${c.dataset.v === '女' ? 'female' : 'male'}.mp3`);
  const after = () => { if (CV.on) chatListen(); };
  previewAudio.onended = after;
  previewAudio.play().catch(after);
});
let previewAudio = null;

// ── 語音對談 ──
// 問教練常常要描述一整段狀況、邊想邊講。辨識器停頓一下就會結束一句，
// 所以一句結束後不馬上送出：繼續聽，CHAT_HOLD_MS 內沒有再開口才送。
// 也可以按「講完了」立刻送出。
const CHAT_HOLD_MS = 2500;
const CV = { on: false, buf: [], pending: '', ep: 0, hold: 0, timer: 0, empty: 0, stall: 0, flushNow: false };

// 分好幾輪聽到的句子接起來。辨識結果常常沒有標點，直接黏在一起會變成「商量結果就…」
const joinSaid = parts => parts.reduce((a, t) => (a && !/[，。！？、,.!?]$/.test(a) ? a + '，' : a) + t, '');

const chatStatus = (t, cls = '') => { const n = $('#ch-status'); n.textContent = t; n.className = 'status ' + cls; };

function chatVoiceOn() {
  if (!supported.stt) return toast('這個瀏覽器不支援語音辨識，請用打字的', 4000);
  voice.unlock();
  CV.on = true; CV.buf = []; CV.pending = ''; CV.empty = 0; CV.stall = 0; CV.flushNow = false;
  $('#s-chat').classList.add('voice');
  chatListen(0);
}

function chatVoiceOff() {
  if (!CV.on) return;
  CV.on = false; CV.ep++;
  clearTimeout(CV.hold); clearTimeout(CV.timer);
  voice.abortListening(); voice.stopSpeaking();
  // 還沒送出的話不要丟掉，放回輸入框
  if (CV.pending) CV.buf.push(CV.pending);
  if (CV.buf.length) $('#ch-text').value = joinSaid(CV.buf);
  CV.buf = []; CV.pending = '';
  $('#s-chat').classList.remove('voice');
  chatStatus('');
}

function chatListen(delay = MIC_AFTER_TTS_MS) {
  if (!CV.on) return;
  clearTimeout(CV.timer);
  const ep = ++CV.ep;
  if (delay > 1000) chatStatus('正在切回麥克風…（點麥克風可以直接開始）');
  CV.timer = setTimeout(() => {
    if (ep !== CV.ep || !CV.on || S.busy || !$('#s-chat.on')) return;
    if (voice.state !== 'idle') return;
    if (!voice.listen()) chatStatus('點一下麥克風開始說話');
  }, delay);
}

function chatFlush() {
  clearTimeout(CV.hold);
  CV.flushNow = false;
  // 按「講完了」時，這一句可能還在辨識中（畫面上看得到、但還沒定稿）。
  // 有些手機停止收音時不會再補送定稿，所以把看得到的那段也算進去。
  if (CV.pending) { CV.buf.push(CV.pending); CV.pending = ''; }
  const t = joinSaid(CV.buf).trim();
  CV.buf = [];
  if (!t) return;
  CV.ep++; clearTimeout(CV.timer);
  voice.abortListening();
  sendChat(t, true);
}

const chatV = {
  partial(t) {
    if (!t || !CV.on) return;
    clearTimeout(CV.hold);                       // 又開口了：還沒講完
    CV.pending = t;
    chatStatus('🎙️ ' + joinSaid([...CV.buf, t]), 'live');
  },
  final(t) {
    if (!CV.on) return;
    CV.buf.push(t); CV.pending = ''; CV.empty = 0; CV.stall = 0;
    if (CV.flushNow) return chatFlush();
    chatStatus('🎙️ ' + joinSaid(CV.buf) + '　（停一下就會送出）', 'live');
    clearTimeout(CV.hold);
    CV.hold = setTimeout(chatFlush, CHAT_HOLD_MS);
    chatListen(0);                               // 繼續聽，他可能還沒講完
  },
  empty() {
    if (!CV.on) return;
    if (CV.buf.length || CV.pending) return chatFlush();
    CV.flushNow = false;                         // 按了「講完了」但其實什麼都沒說
    if (++CV.empty <= 3) return chatListen(600);
    CV.empty = 0;
    chatStatus('沒有聽到聲音，點一下麥克風再說');
  },
  stall() {
    if (!CV.on) return;
    if (CV.buf.length) return chatFlush();
    if (++CV.stall <= 2) { chatStatus('麥克風重新連接中…'); return chatListen(800); }
    CV.stall = 0;
    chatStatus('麥克風沒有反應，點一下麥克風再試；也可以改用打字');
  },
  state(s) {
    const m = $('#ch-mic');
    m.classList.toggle('rec', s === 'listening');
    m.classList.toggle('talk', s === 'speaking');
    if (!CV.on) return;
    if (s === 'listening' && !CV.buf.length) chatStatus('🎙️ 請說話…', 'live');
    else if (s === 'speaking') chatStatus('教練正在說話（點麥克風可打斷）');
    else if (typeof s === 'string' && s.startsWith('error:')) {
      chatStatus('');
      toast(s.includes('not-allowed') ? '麥克風權限被拒絕，請到 Safari 設定開啟' : '沒聽清楚，再說一次或改用打字');
    }
  },
};

$('#ch-voice').onclick = chatVoiceOn;
$('#ch-kb').onclick = chatVoiceOff;
$('#ch-mic').onclick = () => {
  voice.unlock();
  CV.ep++; clearTimeout(CV.timer);
  if (voice.state === 'speaking') { voice.stopSpeaking(); voice.listen(); }
  else if (voice.state === 'listening') { CV.flushNow = true; voice.stopListening(); }   // 講到一半按＝講完了
  else if (CV.buf.length) chatFlush();
  else voice.listen();
};
$('#ch-done').onclick = () => {
  if (voice.state === 'listening') { CV.flushNow = true; voice.stopListening(); }
  else chatFlush();
};

// ── 訓練紀錄（Local storage）────────────────────────────────
function saveHistory(fb) {
  try {
    const h = JSON.parse(localStorage.getItem(LS) || '[]');
    h.unshift({
      at: Date.now(), mode: fb.mode, modeName: fb.modeName,
      persona: fb.persona?.summary || '', name: fb.persona?.name || '',
      scores: Object.fromEntries(Object.entries(fb.scores || {}).map(([k, v]) => [k, v.score])),
      summary: fb.summary, next: fb.next_challenge,
      kp: fb.key_points?.length ? [fb.key_points.filter(k => k.covered).length, fb.key_points.length] : undefined,
    });
    localStorage.setItem(LS, JSON.stringify(h.slice(0, 50)));
    syncSoon();
  } catch { /* 容量滿時忽略 */ }
}

function renderHistory() {
  const b = $('#h-body'); b.innerHTML = '';
  const h = JSON.parse(localStorage.getItem(LS) || '[]');
  if (!h.length) { b.append(el('p', 'note', '還沒有紀錄，先練一次看看。')); return; }

  const avg = {};
  for (const k of Object.keys(NAMES)) {
    const v = h.map(x => x.scores?.[k]).filter(n => typeof n === 'number');
    if (v.length) avg[k] = v.reduce((a, c) => a + c, 0) / v.length;
  }
  const c0 = el('div', 'card'); c0.append(el('h4', null, `我的業務能力（${h.length} 次平均）`));
  for (const k of Object.keys(avg)) c0.append(starRow(NAMES[k], Math.round(avg[k] * 2) / 2, ''));
  b.append(c0);

  for (const r of h) {
    const c = el('div', 'card');
    const d = new Date(r.at);
    c.append(el('h4', null, `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}　${r.modeName || ''}　${r.name}`));
    c.append(el('p', 'muted', r.persona));
    const tot = Object.values(r.scores || {});
    if (tot.length) c.append(el('p', null, '平均 ' + (tot.reduce((a, x) => a + x, 0) / tot.length).toFixed(1) + ' 星'
      + (Array.isArray(r.kp) ? `｜必講重點 ${r.kp[0]}／${r.kp[1]}` : '')));
    if (r.summary) c.append(el('p', 'ev', r.summary));
    b.append(c);
  }
  const clr = el('button', 'link', '清除所有紀錄');
  clr.onclick = () => { if (confirm('確定要刪除全部訓練紀錄？')) { localStorage.removeItem(LS); renderHistory(); } };
  b.append(clr);
}



// ── 帳號與雲端同步 ──────────────────────────────────────────
// 沒填 firebase-config.js 時整段自動關閉，App 行為與加入帳號功能之前完全相同。
// 同步只涵蓋「訓練紀錄」與「偏好設定」；API 金鑰與上傳的文件永遠留在本機。
// 舊版曾有「先不要登入，直接使用」的出口，按過的人瀏覽器裡會留下這個旗標。
// 現在改成強制登入，所以要主動清掉——只把按鈕拿掉的話，
// 已經按過的人會繼續繞過登入頁。
const LEGACY_SKIP = 'aicoach.noacct';
let syncBadge = null, syncing = false, syncTimer;

function bundle() {
  let history = [];
  try { history = JSON.parse(localStorage.getItem(LS) || '[]'); } catch { /* 壞資料當空的 */ }
  const p = prefs();
  return {
    history,
    prefs: {
      diff: p.diff || '', ctx: p.ctx || '', coach: p.coach || '',
      provider: localStorage.getItem(PROV_KEY) || '',
      models: localStorage.getItem(PIN_KEY) || '',
      updatedAt: p.updatedAt || 0,
    },
  };
}

function applyBundle(b) {
  try { localStorage.setItem(LS, JSON.stringify((b.history || []).slice(0, 50))); } catch { /* 容量滿 */ }
  const p = b.prefs || {};
  // 模型指定只在「服務商相同」時才套用——別家的模型名稱放進來是無效的，
  // 會讓使用者在新裝置上看到一個根本不存在的模型。
  if (p.models && p.provider && p.provider === localStorage.getItem(PROV_KEY)) {
    localStorage.setItem(PIN_KEY, p.models);
  }
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    diff: p.diff || '', ctx: p.ctx || '', coach: p.coach || '', updatedAt: p.updatedAt || 0,
  }));
}

function setSync(state) {
  if (!syncBadge) return;
  const M = { busy: ['sync busy', '同步中…'], ok: ['sync', '已同步'], err: ['sync off', '同步失敗'] };
  const [cls, txt] = M[state] || M.ok;
  syncBadge.className = cls;
  syncBadge.textContent = txt;
}

// 同步失敗絕對不能擋住任何功能——練習比同步重要。
async function syncNow(loud = false) {
  if (!acct.configured() || !acct.user() || syncing) return;
  syncing = true; setSync('busy');
  try {
    const remote = await acct.pull();
    // pull() 回傳 null 代表拿不到 token。原本這裡照樣往下走、最後顯示「已同步」——
    // 離線或帳號失效時都在謊報成功。
    if (remote === null) {
      syncing = false;
      if (!acct.user()) return accountRevoked();   // token() 判定帳號已失效並登出了
      setSync('err');                              // 多半是沒網路，下次再試
      if (loud) toast('目前連不上雲端，紀錄先存在這台裝置，之後會自動同步');
      return;
    }
    const merged = acct.merge(bundle(), remote);
    applyBundle(merged);
    if (!await acct.push(merged)) throw new Error('寫入雲端失敗，稍後會再試');
    setSync('ok');
    if (loud) toast('已與雲端同步，共 ' + merged.history.length + ' 筆紀錄');
  } catch (e) {
    setSync('err');
    if (loud) toast(e.message);
  }
  syncing = false;
}
const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), 2500); };

function accountRevoked() {
  updateWho();
  toast('你的帳號已失效或被停用，請重新登入', 5000);
  const cur = document.querySelector('.screen.on')?.id;
  if (cur === 's-home') { initAuth(); show('auth'); }
}

function updateWho() {
  const u = acct.user();
  const line = $('#home-who');
  $('#home-signout').hidden = !u;
  line.hidden = !u;
  syncBadge = null;
  if (!u) return;
  line.innerHTML = '';
  line.append(el('span', null, '👤'), el('b', null, u.name || u.email));
  syncBadge = el('span', 'sync', '已同步');
  line.append(syncBadge);
}

// ── 註冊／登入畫面 ──────────────────────────────────────────
const authMsg = (cls, t) => { $('#au-msg').className = 'note ' + cls; $('#au-msg').textContent = t; };

async function afterAuth() {
  updateWho();
  await syncNow(true);          // 先把雲端資料拉下來，再進金鑰流程（模型指定才會生效）
  await initLogin();
  updateAccount(); syncInstallBtn(); handleShortcut();
}

function initAuth() {
  authMsg('', '');
  $('#au-pw').value = '';
  $('#au-google').innerHTML = '';        // 可重複呼叫：登出再登入不該疊出兩顆按鈕
  $('#au-apple').hidden = !acct.appleReady();
  if (acct.googleReady()) {
    acct.googleButton($('#au-google'), (e, u) => e ? authMsg('err', e.message) : afterAuth())
      .catch(e => authMsg('err', e.message));
    // Google 的登入元件在某些環境（尤其 iOS 的桌面 App／內建瀏覽器）
    // 會靜靜地不渲染也不報錯。我們現在鼓勵使用者「先加到桌面再登入」，
    // 所以這條路更容易被走到——沒渲染出來就明講，別讓人卡在死路上。
    setTimeout(() => {
      if ($('#au-google').children.length) return;
      $('#au-google').hidden = true;
      authMsg('', '這個環境無法使用 Google 登入，請改用下方的 E-mail 註冊或登入。');
    }, 6000);
  } else {
    $('#au-google').hidden = true;
  }
}

const emailPw = () => [$('#au-email').value.trim(), $('#au-pw').value];

async function emailAuth(btn, label, fn) {
  const [email, pw] = emailPw();
  if (!email) return authMsg('err', '請先輸入 E-mail');
  btn.disabled = true; btn.textContent = '處理中…';
  authMsg('', '');
  try { await fn(email, pw); await afterAuth(); }
  catch (e) { authMsg('err', e.message); }
  btn.disabled = false; btn.textContent = label;
}

$('#au-in').onclick = () => emailAuth($('#au-in'), '登入', acct.signInEmail);
$('#au-up').onclick = () => emailAuth($('#au-up'), '註冊新帳號', acct.signUpEmail);
$('#au-pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#au-in').click(); });

$('#au-reset').onclick = async () => {
  const [email] = emailPw();
  if (!email) return authMsg('err', '請先輸入 E-mail，重設信會寄到這個地址');
  try { await acct.resetEmail(email); authMsg('ok', '重設密碼的信已寄出，請到信箱收信'); }
  catch (e) { authMsg('err', e.message); }
};

$('#au-apple').onclick = async () => {
  try { await acct.signInApple(); await afterAuth(); }
  catch (e) { authMsg('err', e.message); }
};

$('#home-signout').onclick = () => {
  if (!confirm('登出後要重新登入才能使用，本機的訓練紀錄會保留。確定登出？')) return;
  acct.signOut();
  updateWho();
  initAuth();
  show('auth');
};

// ── PWA：註冊 Service Worker 與「加到主畫面」──────────────────
// SW 只負責讓 App 可安裝並在離線時開得起來；演練需要呼叫 AI API，那一定要網路。
// isSecureContext 才對——http://localhost 也是安全來源，SW 在那裡同樣能註冊（本機測試需要）
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 不支援就算了，功能不受影響 */ });
}

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches
  || window.matchMedia('(display-mode: fullscreen)').matches
  || navigator.standalone === true;

// 平台判斷。這裡的細節都是為了「按鈕按下去要有正確的下一步」：
// iPadOS 13 之後 UA 會自稱 Mac，只能靠觸控點數分辨；
// 而台灣同事很常從 LINE 點連結進來，那個內建瀏覽器根本沒有「加入主畫面」。
function platform() {
  const ua = navigator.userAgent;
  const iPhone = /iPhone|iPod/.test(ua);
  const iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /Line\/|FBAN|FBAV|Instagram|MicroMessenger/i.test(ua);   // LINE／FB／IG／微信
  // iOS 上哪個瀏覽器，只影響「分享鍵在哪」。
  // 使用者實測回報：Chrome for iOS 也能建立捷徑（115 版之後有「加入主畫面」），
  // 而且 iOS 限制下它是用 Safari 引擎開啟，結果與 Safari 建的一樣。
  // 先前這裡寫「只有 Safari 能裝」是錯的，會把人擋在門外。
  const browser = /CriOS/.test(ua) ? 'chrome'
    : /EdgiOS/.test(ua) ? 'edge'
    : /FxiOS/.test(ua) ? 'firefox'
    : /OPiOS|OPT\//.test(ua) ? 'opera'
    : 'safari';
  const android = /Android/i.test(ua);
  return { iPhone, iPad, ios: iPhone || iPad, android, inApp, browser };
}

let installEvent = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();               // 由我們自己決定何時提示
  installEvent = e;
  syncInstallBtn();
});
window.addEventListener('appinstalled', () => { installEvent = null; syncInstallBtn(); });

// 已經是獨立 App 就不必再提示——按鈕留著只會讓人困惑。
// 三個畫面都有一顆（註冊／登入、API 金鑰、首頁）：拿到連結的同事
// 應該能「先加到桌面、再從 App 裡登入」。
// iOS 上桌面 App 的儲存空間與 Safari 是分開的，先在瀏覽器登入根本帶不過去，
// 所以「先裝再登入」才是正確順序。
function syncInstallBtn() {
  const hide = standalone();
  document.querySelectorAll('[data-install]').forEach(b => { b.hidden = hide; });
}

// ── 教學浮層 ────────────────────────────────────────────────
// 分享圖示長什麼樣是使用者最容易認錯的地方，所以直接畫出來。
const ICON_SHARE = '<span class="sh-icon"><svg viewBox="0 0 24 24">'
  + '<path d="M12 15V4"/><path d="M8.5 7.5 12 4l3.5 3.5"/>'
  + '<path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg></span>';
const ICON_MORE = '<span class="sh-icon"><svg viewBox="0 0 24 24">'
  + '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'
  + '<circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg></span>';
const ICON_PLUS = '<span class="sh-icon"><svg viewBox="0 0 24 24">'
  + '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.5v7M8.5 12h7"/></svg></span>';

// install：顯示「立即安裝」（Android 有系統安裝事件時）；done：顯示「我已經加過了」
function sheet(title, lead, steps, { why = true, install = false, done = false } = {}) {
  $('#sh-why').hidden = !why;                     // 「裝好之後…」那段只屬於加到主畫面
  $('#sh-install').hidden = !install;
  $('#sh-done').hidden = !done;
  $('#sheet .btn[data-close]').classList.toggle('primary', !install);   // 一次只有一顆藍色主按鈕
  $('#sh-title').textContent = title;
  $('#sh-lead').innerHTML = lead;
  $('#sh-steps').innerHTML = steps.map((s, i) =>
    `<div class="sh-step"><span class="sh-n">${i + 1}</span><div><p>${s[0]}</p>`
    + (s[1] ? `<small>${s[1]}</small>` : '') + '</div></div>').join('');
  $('#sheet').hidden = false;
}
document.querySelectorAll('#sheet [data-close]').forEach(e => {
  e.onclick = () => { $('#sheet').hidden = true; };
});

async function promptInstall() {
  const ev = installEvent;
  if (!ev) return;
  $('#sheet').hidden = true;
  ev.prompt();
  const r = await ev.userChoice.catch(() => null);
  installEvent = null;
  if (r?.outcome === 'accepted') { toast('已加到主畫面'); syncInstallBtn(); }
}
$('#sh-install').onclick = promptInstall;

document.addEventListener('click', e => {
  if (e.target.closest('[data-install]')) installGuide();
});

// 安裝教學。按「加到主畫面」按鈕，或第一次用手機瀏覽器打開時自動跳出（auto）。
async function installGuide({ auto = false } = {}) {
  const p = platform();
  const opt = { done: auto };                    // 自動跳出時多一個「我已經加過了」

  // 1) Android／桌面 Chrome：真的可以一鍵安裝。
  //    按按鈕時直接叫出系統安裝視窗；自動跳出時不行——瀏覽器規定安裝視窗
  //    只能在使用者按了東西之後才叫得出來，所以先顯示說明，讓他按「立即安裝」。
  if (installEvent && !auto) return promptInstall();
  if (installEvent) {
    return sheet('加到主畫面', '把 AI業務教練加到手機桌面，之後點圖示就能開啟，<b>全螢幕、像一般 App 一樣</b>。'
      + '按下面的「立即安裝」，再按系統跳出的「安裝」就完成了。', [], { ...opt, install: true });
  }

  // 2) LINE／FB／IG 的內建瀏覽器：連「加入主畫面」的選項都沒有，
  //    先把人帶到真正的瀏覽器，否則後面教什麼都沒用
  if (p.inApp) {
    return sheet('請先用瀏覽器開啟',
      '你現在是從 <b>LINE／Facebook 之類的 App 內建瀏覽器</b>開啟的，'
      + '這種瀏覽器<b>沒有</b>「加入主畫面」的功能。先換到系統瀏覽器就可以了。',
      [[`點右上角的${ICON_MORE}`, '有些版本在右下角，圖示是三個點或箭頭'],
       ['選「用 Safari 開啟」或「用其他瀏覽器開啟」', 'Safari 或 Chrome 都可以，Android 選 Chrome'],
       ['在瀏覽器裡再按一次這顆「加到主畫面」']], opt);
  }

  // 3) iPhone／iPad：沒有 API 可以自動建立捷徑（Apple 的規定），只能教。
  //    Safari 與 Chrome 都做得到，差別只在「分享鍵在哪」——講錯位置比不講更糟。
  if (p.ios) {
    // 每個瀏覽器給完整句子，不套版——套版會生出
    //「點…選單裡的『分享』的分享鍵」這種讀不下去的句子。
    const STEP1 = {
      safari: [`點${p.iPad ? '螢幕<b>右上角</b>（網址列右邊）' : '螢幕<b>最下方中間</b>'}的分享鍵${ICON_SHARE}`,
        '就是「方形加向上箭頭」那個圖示，不是圓圈裡的箭頭'],
      chrome: [`點<b>網址列右邊</b>的分享鍵${ICON_SHARE}`,
        '找不到的話，點右下角的 ⋯ 再選「分享」'],
      edge: ['點螢幕最下方的 <b>⋯</b> → 選「分享」', '再從系統的分享選單往下找'],
      firefox: ['點網址列右邊的 <b>⋯</b> → 選「分享」', '再從系統的分享選單往下找'],
      opera: ['從瀏覽器選單選「分享」', '再從系統的分享選單往下找'],
    };
    const NAME = { safari: 'Safari', chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', opera: 'Opera' };
    const hint = p.browser === 'safari' ? ''
      : `你現在用的是 <b>${NAME[p.browser]}</b>，它建立的捷徑在 iOS 上一樣是全螢幕開啟，不必換瀏覽器。`;
    return sheet('加到主畫面',
      `iPhone／iPad 不允許網頁自己建立捷徑（Apple 的規定），要你手動按兩下。${hint}`,
      [STEP1[p.browser],
       ['在選單裡往下滑，找「加入主畫面」',
        `圖示是${ICON_PLUS}，通常要滑過一整排 App 圖示才看得到`],
       ['右上角按「新增」', '桌面就會出現 AI業務教練 的圖示']], opt);
  }

  // 4) Android 但瀏覽器沒給安裝事件（還沒準備好，或不是 Chrome）：教選單的位置。
  //    原本這裡會落到下面的桌面說明，Android 使用者看到的是電腦的操作方式。
  if (p.android) {
    return sheet('加到主畫面', '把 AI業務教練加到手機桌面，之後點圖示就能開啟，全螢幕、像一般 App 一樣。',
      [[`點瀏覽器右上角的 <b>⋮</b>`, 'Chrome、Edge、Samsung 瀏覽器都在右上角或右下角'],
       ['選「<b>加到主畫面</b>」或「<b>安裝應用程式</b>」'],
       ['按「安裝」或「新增」', '桌面就會出現 AI業務教練 的圖示']], opt);
  }
  if (auto) return;                              // 桌面電腦不自動跳

  // 5) 桌面瀏覽器但沒有安裝事件（Firefox、Safari，或已經裝過）
  return sheet('加到桌面',
    '這個瀏覽器沒有提供一鍵安裝。可以用網址列的安裝圖示，或直接用瀏覽器的選單。',
    [['看網址列右側有沒有安裝圖示', 'Chrome／Edge 是一個螢幕加箭頭的小圖示'],
     ['或從瀏覽器選單找「安裝」／「建立捷徑」'],
     ['macOS 的 Safari 是「檔案 → 加入 Dock」'],
     ['Firefox 桌面版沒有這個功能', '手機上開這個網址會比較順']]);
}

// 第一次用手機瀏覽器打開：主動教安裝（掃 QR Code 進來的人多半不知道可以這樣做）。
// 從桌面圖示打開的不跳；每個瀏覽器只自動跳一次，之後需要再按按鈕就好。
// 注意瀏覽器沒辦法知道「桌面上已經有圖示」——所以有「我已經加過了」可以關。
const INSTALL_TIP_KEY = 'aicoach.installtip';
async function autoInstallTip() {
  if (standalone()) return;
  const p = platform();
  if (!(p.ios || p.android || p.inApp)) return;
  try { if (localStorage.getItem(INSTALL_TIP_KEY)) return; } catch { return; }
  // Android 的安裝事件通常在載入後一兩秒才來，等一下才知道能不能一鍵安裝
  for (let i = 0; i < 25 && p.android && !installEvent; i++) await new Promise(r => setTimeout(r, 100));
  if (standalone() || !$('#sheet').hidden) return;
  try { localStorage.setItem(INSTALL_TIP_KEY, String(Date.now())); } catch { /* 無痕模式 */ }
  installGuide({ auto: true });
}

// 從桌面圖示的「快速動作」進來時直接開對應功能
function handleShortcut() {
  const go = new URLSearchParams(location.search).get('go');
  if (!go) return;
  history.replaceState({}, '', location.pathname);
  if (['pain', 'call', 'needs'].includes(go)) openIntake(go);
}

// ── 啟動 ────────────────────────────────────────────────────
$('#btn-welcome').onclick = () => { localStorage.setItem('aicoach.seen', '1'); show('home'); };
// 離開頁面時只釋放麥克風與語音，**不要**結束演練——
// 切換 App 也會觸發 pagehide——只停掉麥克風與朗讀，不結束演練，回來還能繼續講。
window.addEventListener('pagehide', () => { chatVoiceOff(); voice.reset(); });
$('#home-acct').hidden = true; $('#home-logout').hidden = true;

// 額度用盡自動降階時，讓使用者知道發生了什麼，而不是默默變慢或變差
let lastEvt = 0;
onModelEvent(e => {
  if (Date.now() - lastEvt < 8000) return;          // 同一波事件不要洗版
  lastEvt = Date.now();
  if (e.type === 'slow') toast(`${e.model} 沒有回應，已換下一個模型`, 4000);
  else if (e.type === 'busy') toast(`${e.model} 目前使用的人太多，暫時換別的模型（約 ${e.minutes} 分鐘後回頭嘗試）`, 5000);
  else if (e.type === 'quota') toast(`${e.model} 額度用盡，已自動改用備援模型（約 ${e.minutes} 分鐘後回頭嘗試）`, 5000);
  else if (e.type === 'fallback') toast(`目前改用 ${e.to}`, 3000);
});

async function boot() {
  localStorage.removeItem(LEGACY_SKIP);
  setTimeout(autoInstallTip, 600);                  // 先讓畫面出來，再跳安裝教學
  // 強制登入：每個使用者都必須有帳號。
  // 判斷依據是本機存的登入狀態，不是連線檢查——沒網路時仍然進得去，
  // 否則一斷線就等於整個 App 被鎖住。
  if (acct.configured() && !acct.user()) {
    initAuth();
    return show('auth');
  }
  if (acct.user()) { updateWho(); syncNow(); }
  await initLogin();
  updateAccount(); syncInstallBtn(); handleShortcut();
}
boot();
