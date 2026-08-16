import { Voice, supported } from './voice.js';

const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const LS = 'aicoach.history';

const S = {
  fn: 'call',            // 目前功能：pain | call | needs | product | claim | chat
  sessionId: null, persona: null, ended: false, busy: false,
  docPick: null,         // 進入文件頁的目的：null=管理 / 'product' / 'policy'
  doc: null,             // 已選定的文件 {id,title}
  claimHistory: [], chatHistory: [],
  lastCustomer: null,    // 痛點分析用過的客戶資料，可直接接去演練
};

const MODE_TITLE = { call: '電話邀約語音對練', needs: '發掘需求角色扮演', product: '商品行銷語音演練' };

// ── 畫面切換 ────────────────────────────────────────────────
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + name));
  if (name === 'history') renderHistory();
  if (name === 'docs') renderDocs();
}

document.addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if (!g) return;
  const to = g.dataset.go;
  if (to === 'docs-policy') { S.docPick = 'policy'; return show('docs'); }
  if (to === 'home') { abort(); S.docPick = null; }
  if (to === 'intake') return openIntake(S.fn);
  show(to);
});

let toastT;
function toast(msg, ms = 2800) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms);
}

// ── API ────────────────────────────────────────────────────
// 共用金鑰部署時，伺服器會要求通行碼；本機自己跑則不會啟用。
const CODE_KEY = 'aicoach.code';

async function api(path, body, retried = false) {
  const code = localStorage.getItem(CODE_KEY);
  const r = await fetch('/api' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code ? { 'x-access-code': code } : {}) },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401 && !retried) {          // 通行碼被改掉或過期 → 重問一次
    localStorage.removeItem(CODE_KEY);
    await ensureAuth();
    return api(path, body, true);
  }
  const j = await r.json().catch(() => ({ error: '連線失敗' }));
  if (!r.ok) throw new Error(j.error || '發生錯誤');
  return j;
}

async function ensureAuth() {
  const h = await fetch('/api/health').then(r => r.json()).catch(() => ({}));
  if (!h.auth) return;                          // 沒啟用通行碼
  for (;;) {
    const code = localStorage.getItem(CODE_KEY);
    if (code) {
      const ok = await fetch('/api/auth', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      }).then(r => r.json()).then(j => j.ok).catch(() => false);
      if (ok) return;
      localStorage.removeItem(CODE_KEY);
    }
    const input = prompt('請輸入團隊通行碼');
    if (input === null) { toast('需要通行碼才能使用'); return; }
    localStorage.setItem(CODE_KEY, input.trim());
  }
}

const busy = (msg, on = true) => { $('#wait-msg').textContent = msg; if (on) show('wait'); };

// ── 首頁六大功能 ────────────────────────────────────────────
document.querySelectorAll('[data-fn]').forEach(b => b.onclick = () => {
  const fn = b.dataset.fn;
  S.fn = fn;
  if (fn === 'product') { S.docPick = 'product'; return show('docs'); }
  if (fn === 'claim') { S.docPick = 'policy'; return show('docs'); }
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
  show('intake');
}

for (const id of ['#f-gender', '#f-diff', '#f-ctx']) {
  $(id).addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    $(id).querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
  });
}
const pick = id => $(id).querySelector('.chip.on')?.dataset.v;

$('#btn-go').onclick = async () => {
  const background = $('#f-bg').value.trim();
  const age = $('#f-age').value.trim();
  if (!background) return toast('請先描述一下客戶背景');
  const customer = { gender: pick('#f-gender'), age, background };
  S.lastCustomer = customer;

  if (S.fn === 'pain') {
    busy('正在分析這位客戶可能的痛點…');
    try { renderPain(await api('/analyze/pain', customer)); show('pain'); }
    catch (e) { toast(e.message); show('intake'); }
    return;
  }

  busy('正在建立客戶…');
  try {
    const d = await api('/session/start', {
      ...customer, mode: S.fn, difficulty: pick('#f-diff'), docId: S.doc?.id,
      context: pick('#f-ctx'), contextNote: $('#f-ctxnote').value.trim(),
    });
    S.sessionId = d.sessionId; S.persona = d.persona; S.ended = false;
    $('#b-title').textContent = MODE_TITLE[S.fn] || '演練前準備';
    $('#b-name').textContent = d.persona.name;
    $('#b-summary').textContent = d.persona.summary + (d.contextLabel ? `　·　${d.contextLabel}` : '');
    $('#b-obj').textContent = d.scenario?.objective || '';
    $('#b-open').textContent = d.demo?.opening || '';
    $('#b-q').textContent = d.demo?.key_question || '';
    $('#b-oc').textContent = '客戶：' + (d.demo?.objection_handling?.customer || '');
    $('#b-oy').textContent = '你：' + (d.demo?.objection_handling?.you || '');
    show('brief');
  } catch (e) { toast(e.message); show('intake'); }
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
  $('#d-title').textContent = kind === 'product' ? '選擇商品教材' : kind === 'policy' ? '選擇保單條款' : '我的文件';
  $('#d-hint').textContent = kind === 'policy'
    ? '上傳保單條款或商品說明書。支援 PDF、DOCX、PPTX、TXT，單檔 18MB 以內。'
    : '支援 PDF、Word（.docx）、PowerPoint（.pptx）、純文字，單檔 18MB 以內。';

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
  if (S.docPick === 'product') { S.docPick = null; openIntake('product'); }
  else { S.docPick = null; S.claimHistory = []; $('#c-title').textContent = S.doc.title; renderClaim(); show('claim'); }
}

$('#btn-upload').onclick = () => $('#f-file').click();

$('#f-file').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 18 * 1024 * 1024) return toast('檔案超過 18MB，請壓縮或分割');

  let kind = S.docPick;
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
    S.docPick = kind;
  } catch (e) { toast(e.message, 5000); }
  show('docs');
};

// ── Voice Engine ────────────────────────────────────────────
const voice = new Voice({
  onPartial: t => { if (t) setStatus('🎙️ ' + t, 'live'); },
  onFinal: t => submit(t),
  onState: s => {
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

const setStatus = (t, cls = '') => { const n = $('#p-status'); n.textContent = t; n.className = 'status ' + cls; };

function push(log, speaker, text) {
  const n = $(log);
  n.appendChild(el('div', 'msg ' + speaker, text));
  n.scrollTop = n.scrollHeight;
}

// ── 開始演練 ────────────────────────────────────────────────
$('#btn-start').onclick = async () => {
  voice.unlock();                                    // 必須在使用者手勢中
  $('#p-log').innerHTML = ''; $('#p-name').textContent = S.persona.name;
  $('#p-found').hidden = S.fn !== 'needs';
  if (S.fn === 'needs') $('#p-found').textContent = '已挖到 0 項';
  S.ended = false; show('play');
  if (!supported.stt) toast('這個瀏覽器不支援語音辨識，請用下方文字輸入', 4000);
  try {
    const d = await api('/session/begin', { sessionId: S.sessionId });
    push('#p-log', 'customer', d.opening);
    await voice.speak(d.opening, S.persona.voice);
    nextTurn();
  } catch (e) { toast(e.message); }
};

function nextTurn() {
  if (S.ended) return;
  if (supported.stt) { if (!voice.listen()) setStatus('點一下麥克風開始說話'); }
  else setStatus('請用下方輸入框回覆');
}

$('#btn-mic').onclick = () => {
  voice.unlock();
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
  S.busy = true;
  push('#p-log', 'user', text);
  setStatus('思考中…', 'think');
  try {
    const d = await api('/session/turn', { sessionId: S.sessionId, text });

    if (d.type === 'compliance') {
      push('#p-log', 'system', d.text);
      setStatus(''); S.busy = false;
      toast('偵測到合規風險，演練已暫停');
      return nextTurn();
    }

    push('#p-log', 'customer', d.text);
    if (S.fn === 'needs') $('#p-found').textContent = `已挖到 ${d.revealed}／${d.totalHidden} 項`;
    if (d.warn) toast('注意用語：' + d.warn[0], 3600);
    S.busy = false;
    await voice.speak(d.text, S.persona.voice);

    if (d.ended) { S.ended = true; setStatus('這次談話結束了'); setTimeout(finish, 900); }
    else nextTurn();
  } catch (e) {
    S.busy = false; setStatus(''); toast(e.message);
    if (/逾時/.test(e.message)) { S.sessionId = null; show('home'); }
  }
}

$('#btn-end').onclick = () => { S.ended = true; voice.reset(); finish(); };

async function finish() {
  if (!S.sessionId) return show('home');
  voice.reset(); busy('正在分析你剛才的表現…');
  const id = S.sessionId; S.sessionId = null;
  try {
    const fb = await api('/session/end', { sessionId: id });
    renderFeedback(fb); saveHistory(fb); show('fb');
  } catch (e) { toast(e.message); show('home'); }
}

function abort() {
  if (S.sessionId) api('/session/abort', { sessionId: S.sessionId }).catch(() => {});
  S.sessionId = null; S.ended = true; voice.reset();
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
  b.append(el('p', 'note', `回合數 ${m.turns}｜對談 ${m.durationSec} 秒｜客戶最終信任度 ${m.finalTrust}/100｜AI 平均回應 ${fb.avgLatencyMs} ms`));
  b.scrollTop = 0;
}

// ── 功能五：理賠諮詢 ────────────────────────────────────────
function renderClaim() {
  const b = $('#c-log'); b.innerHTML = '';
  if (!S.claimHistory.length) {
    const m = el('div', 'msg coach');
    m.append(el('h5', null, `已載入：${S.doc?.title || ''}`));
    m.append(el('p', null, '描述客戶遇到的狀況，我會依這份條款判斷可能可以申請的項目。例如：'));
    m.append(list(['客戶因為車禍住院五天，做了手術', '客戶確診乳癌，目前住院化療中', '客戶小孩發燒門診三次，有健保住院兩天']));
    b.append(m);
  }
  for (const t of S.claimHistory) {
    if (t.role === 'user') push('#c-log', 'user', t.text);
    else b.append(claimCard(t.data));
  }
  b.scrollTop = b.scrollHeight;
}

function claimCard(d) {
  const m = el('div', 'msg coach');
  if (d.understanding) m.append(el('h5', null, '我理解的狀況'), el('p', null, d.understanding));

  if (d.likely?.length) {
    m.append(el('h5', null, '可能可以申請'));
    for (const x of d.likely) {
      const w = el('div', 'pt');
      const t = el('b'); t.append(document.createTextNode(x.item || ''));
      if (x.confidence) { const g = el('span', 'tag ' + x.confidence, { high: '把握高', medium: '需確認', low: '不確定' }[x.confidence] || x.confidence); t.append(g); }
      w.append(t);
      if (x.amount) w.append(el('p', null, '給付：' + x.amount));
      if (x.why) w.append(el('p', 'ev', x.why));
      if (x.source) w.append(el('p', 'ev', '依據：' + x.source));
      m.append(w);
    }
  } else m.append(el('h5', null, '可能可以申請'), el('p', 'ev', '依這份條款，目前判斷不到符合的給付項目。'));

  if (d.unlikely?.length) {
    m.append(el('h5', null, '可能不賠或有爭議'));
    m.append(list(d.unlikely.map(x => `${x.item}：${x.why}`)));
  }
  if (d.need_to_confirm?.length) { m.append(el('h5', null, '還需要確認')); m.append(list(d.need_to_confirm)); }
  if (d.next_steps?.length) { m.append(el('h5', null, '建議的下一步')); m.append(list(d.next_steps)); }
  m.append(el('p', 'dim', '⚠️ ' + (d.disclaimer || '') + (d.grounded ? '' : '（本次僅依摘要判斷，未回頭比對原文）')));
  return m;
}

$('#c-send').onclick = async () => {
  const q = $('#c-text').value.trim();
  if (!q || S.busy) return;
  $('#c-text').value = '';
  S.busy = true;
  push('#c-log', 'user', q);
  const th = el('div', 'msg coach'); th.textContent = '查詢條款中…';
  $('#c-log').append(th); $('#c-log').scrollTop = 1e9;
  try {
    const d = await api('/claim/ask', { docId: S.doc.id, question: q, history: S.claimHistory.map(h => ({ role: h.role, text: h.role === 'user' ? h.text : JSON.stringify(h.data).slice(0, 600) })) });
    th.replaceWith(claimCard(d));
    S.claimHistory.push({ role: 'user', text: q }, { role: 'ai', data: d });
  } catch (e) { th.textContent = '查詢失敗：' + e.message; }
  S.busy = false; $('#c-log').scrollTop = 1e9;
};
$('#c-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('#c-send').click(); });

// ── 功能六：行銷諮詢 ────────────────────────────────────────
// 模型偶爾還是會冒出 Markdown 記號，純文字氣泡顯示會很醜，統一清掉
const clean = s => (s || '')
  .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '')
  .replace(/^>\s?/gm, '').replace(/^[-*]\s+/gm, '・').trim();

function renderChat() {
  const b = $('#ch-log'); b.innerHTML = '';
  if (!S.chatHistory.length) {
    const m = el('div', 'msg coach');
    m.append(el('p', null, '把你手上遇到的客戶狀況講給我聽，我們一起想怎麼處理。例如：'));
    m.append(list(['客戶說要跟老婆商量，之後就不回訊息了', '客戶覺得保費太貴，但我看他其實有預算', '轉介紹來的客戶很客氣，可是都不講真話']));
    b.append(m);
  }
  for (const t of S.chatHistory) push('#ch-log', t.role === 'user' ? 'user' : 'coach', t.role === 'user' ? t.text : clean(t.text));
  b.scrollTop = b.scrollHeight;
}

$('#ch-send').onclick = async () => {
  const q = $('#ch-text').value.trim();
  if (!q || S.busy) return;
  $('#ch-text').value = '';
  S.busy = true;
  push('#ch-log', 'user', q);
  const th = el('div', 'msg coach'); th.textContent = '思考中…';
  $('#ch-log').append(th); $('#ch-log').scrollTop = 1e9;
  try {
    const d = await api('/coach/chat', { history: S.chatHistory, message: q });
    th.className = 'msg coach'; th.textContent = clean(d.reply);
    if (d.compliance) toast('⚠️ ' + d.compliance[0], 5000);
    S.chatHistory.push({ role: 'user', text: q }, { role: 'ai', text: d.reply });
  } catch (e) { th.textContent = '發生錯誤：' + e.message; }
  S.busy = false; $('#ch-log').scrollTop = 1e9;
};
$('#ch-text').addEventListener('keydown', e => { if (e.key === 'Enter') $('#ch-send').click(); });
$('#chat-clear').onclick = () => { S.chatHistory = []; renderChat(); };

// ── 訓練紀錄（Local storage）────────────────────────────────
function saveHistory(fb) {
  try {
    const h = JSON.parse(localStorage.getItem(LS) || '[]');
    h.unshift({
      at: Date.now(), mode: fb.mode, modeName: fb.modeName,
      persona: fb.persona?.summary || '', name: fb.persona?.name || '',
      scores: Object.fromEntries(Object.entries(fb.scores || {}).map(([k, v]) => [k, v.score])),
      summary: fb.summary, next: fb.next_challenge,
    });
    localStorage.setItem(LS, JSON.stringify(h.slice(0, 50)));
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
    if (tot.length) c.append(el('p', null, '平均 ' + (tot.reduce((a, x) => a + x, 0) / tot.length).toFixed(1) + ' 星'));
    if (r.summary) c.append(el('p', 'ev', r.summary));
    b.append(c);
  }
  const clr = el('button', 'link', '清除所有紀錄');
  clr.onclick = () => { if (confirm('確定要刪除全部訓練紀錄？')) { localStorage.removeItem(LS); renderHistory(); } };
  b.append(clr);
}

// ── 啟動 ────────────────────────────────────────────────────
$('#btn-welcome').onclick = () => { localStorage.setItem('aicoach.seen', '1'); show('home'); };
show(localStorage.getItem('aicoach.seen') ? 'home' : 'welcome');
window.addEventListener('pagehide', abort);
ensureAuth();
