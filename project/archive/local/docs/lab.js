// L0b／L1-a 量測台 —— 只做量測，不含產品邏輯。
//
// 刻意用「真實的提示詞」而不是簡化版：
//   計畫書 §3.6 指出 prompts.js 是 38.8 KB，餵給 0.8B 有兩個後果
//   （prefill 吃掉速度優勢、規則遵循度下降）。如果量測用簡化提示詞，
//   就會量出一組漂亮但不能用來做決策的數字。
//
// 勾選「壓縮提示詞」即切換到 prompts.small.js（含 JSON 前綴與角色輪替示範），
// 取消勾選就是原始 prompts.js —— 兩者可直接 A／B 對照。

import { LocalRuntime } from './engine/local/runtime.js';
import { GgufRuntime, listCached, evictCached } from './engine/local/runtime-gguf.js';
import { downloadMB as modelDownloadMB, MODELS } from './engine/local/models.js';
import { roleplaySystem, roleplayTurn, scrubBrands, validateRoleplay } from './engine/prompts.js';
import {
  roleplaySystemSmall, roleplayMessagesSmall, roleplaySystemPlain, roleplayMessagesPlain,
  cleanPlainSay, ROLEPLAY_PREFILL, promptBudget, roleplayRawPrompt, rawStops,
} from './engine/prompts.small.js';
import { parseJson } from './engine/gateway.js';
import { turnSignals } from './engine/scoring/turn-signals.js';

const $ = id => document.getElementById(id);
// 依模型宣告的 engine 選執行層。兩個執行層的介面完全一致，
// 所以量測台（以及之後的 gateway adapter）不需要知道背後是 ONNX 還是 GGUF。
const rt = engineOf(new URLSearchParams(location.search).get('m')) === 'wllama'
  ? new GgufRuntime({
    mirrorBase: new URLSearchParams(location.search).get('mirror') === '1' ? '/models/' : null,
    // ?dl=self：自己下載並快取到 OPFS，繞過 wllama 的下載器（iPhone 上快很多）
    selfDownload: new URLSearchParams(location.search).get('dl') === 'self',
    // ?dl=direct：抓進記憶體直接載入，不寫 OPFS（沒有離線快取，但避開兩倍配額問題）
    direct: new URLSearchParams(location.search).get('dl') === 'direct',
    // ?cache=0：不寫 OPFS。桌面配額只有 5.8 GB，而寫入尖峰需要兩倍檔案大小。
    useCache: new URLSearchParams(location.search).get('cache') !== '0',
    nCtx: Number(new URLSearchParams(location.search).get('ctx')) || null,
    // ?ngl=0 純 CPU、?ngl=16 部分卸載、不給＝全部上 GPU
    nGpuLayers: new URLSearchParams(location.search).has('ngl')
      ? Number(new URLSearchParams(location.search).get('ngl'))
      : null,
  })
  : new LocalRuntime({
    mirrorBase: new URLSearchParams(location.search).get('mirror') === '1' ? '/models/' : null,
  });

function engineOf(key) {
  return (key && MODELS[key]?.engine) || 'transformers';
}

// ?m=qwen3.5-2b 可切換模型，用來回答「這是尺寸問題還是這個模型的問題」（計畫書 §14.5 C1）
const Q = new URLSearchParams(location.search);
const PREFER = Q.get('m') || null;
// ?dt=q4 可覆寫量化格式。實測需要：Qwen2.5-1.5B 的 q4f16 在 WebGPU 上輸出亂碼
// （數值精度問題），改 q4 才正常。同一個模型不同量化的可用性也必須實測。
const DTYPE_OVERRIDE = Q.get('dt') || null;
// ?raw=1：續寫模式（只有 GGUF 路線支援）。對 assistant 對齊過強的模型特別有效。
const USE_RAW = Q.get('raw') === '1';
// ?mirror=1：模型從這台開發機抓（/models/），不連 HuggingFace。
// 手機實機測試用——省下 1 GB 級的行動網路流量，而且可重複測。
const MIRROR = Q.get('mirror') === '1' ? '/models/' : null;

// ── 測試用人設 ──────────────────────────────────────────────────
//
// 取自 handbook §1.3／§2.4 的實測案例：38 歲護理師，離婚獨自扶養小學女兒，輪三班。
// 難度 1（新手友善）——那是預設值，而預設值決定大多數人的第一印象（handbook §9.3 第 14 條）。
const PERSONA = {
  name: '王小姐',
  gender: '女',
  age: '約 38 歲',
  background: '護理師，離婚獨自扶養一個小學的女兒，輪三班',
  personality: '講話客氣但有點累，不太會直接拒絕人',
  communication_style: '語速偏慢，會停頓，習慣先問「這要花多少時間」',
  insurance_attitude: '知道保險重要，但覺得自己已經有公司團保應該夠了',
  time_pressure: '剛下夜班，等一下要去接小孩',
  // 隱藏需求附上關鍵詞：模型會用自己的話講（「我如果倒下了，家裡怎麼辦」），
  // 純字面比對抓不到。關鍵詞是「概念」的程式可讀表示（見 turn-signals.js 的說明）。
  // 未來由人設建立流程一併產生，現在先手寫。
  hidden_needs: [
    { text: '擔心自己萬一倒下，女兒的生活費與學費沒人接手',
      keywords: ['倒下', '學費', '沒人照顧', '沒人接手', '生活費'] },
    { text: '公司團保只保在職期間，離職或退休後就沒了，她其實不知道這件事',
      keywords: ['團保', '在職', '離職', '退休'] },
    { text: '手上有一筆定存快到期，不知道該怎麼處理',
      keywords: ['定存', '到期'] },
  ],
  objections: ['我現在沒時間', '我公司有保了', '我要跟家人討論'],
  difficulty: 1,
  contextNote: '',
};

const MODE = 'call';        // 電話邀約
const CONTEXT = 'cold';     // 陌生開發

// 新手常見的爛開場——這正是 handbook §2.4 用來對照 Level 1 與 Level 4 的輸入
const SCRIPT = [
  '呃…王小姐您好，我是…我是做保險的，那個…想跟您介紹一下我們的新商品',
  '喔…那個…我們公司有一個很好的儲蓄型的…',
  '請問您現在有在規劃小孩的教育金嗎？',
  '那您平常最擔心的事情，大概是什麼呢？',
  '我了解，那我下週三下午三點過去跟您說明二十分鐘，可以嗎？',
];

// ── 提示詞模式切換 ──────────────────────────────────────────────
const useSmall = () => $('use-small')?.checked ?? true;
const usePlain = () => $('use-plain')?.checked ?? true;

function buildMessages(turnArgs) {
  if (usePlain()) return roleplayMessagesPlain(PERSONA, MODE, CONTEXT, turnArgs);
  if (useSmall()) return roleplayMessagesSmall(PERSONA, MODE, CONTEXT, turnArgs);
  return [
    { role: 'system', content: roleplaySystem(PERSONA, MODE, CONTEXT) },
    { role: 'user', content: roleplayTurn(turnArgs) },
  ];
}

// 純文字模式不需要 JSON 前綴
const prefill = () => (!usePlain() && useSmall() ? ROLEPLAY_PREFILL : '');
const modeLabel = () => (USE_RAW ? '續寫模式（raw completion）' : usePlain() ? '純文字 ＋ 程式算分' : useSmall() ? '壓縮版 ＋ JSON 前綴 ＋ 程式算分' : '原始 prompts.js ＋ JSON');

// 純文字模式下，模型只回一句話，其餘欄位由程式補；JSON 模式下照原樣解析。
function toJson(r) {
  if (!usePlain()) return parseJson(r.text);
  const say = cleanPlainSay(r.text, PERSONA.name);
  return say ? { say, trust_delta: null, revealed: [], end: false, _plain: true } : null;
}
const charsOf = msgs => msgs.reduce((a, m) => a + m.content.length, 0);

// ── 程式層檢查：現有 validateRoleplay() 的缺口 ─────────────────
//
// §13.4 的實測發現：模型會自稱業務員，但 validateRoleplay() 只比對後設用語
// （演練、AI、教練…），完全攔不到「我是做保險的」。
// 這是 L1-c 要正式補上的檢查，先放在量測台裡確認它抓得準。
const SELF_AGENT = /我是[^，。？！]{0,8}(保險|壽險|業務|保單|人壽|公司的)|我(們|)(是|在)(做|賣)(保險|壽險)|想跟(您|你)介紹|我是[^，。？！]{0,6}助理/;

// ── 1. 偵測 ─────────────────────────────────────────────────────
$('btn-probe').onclick = async () => {
  $('out-probe').textContent = '偵測中…';
  const { caps, plan } = await rt.plan_(PREFER);
  if (DTYPE_OVERRIDE && DTYPE_OVERRIDE !== plan.dtype) {
    plan.dtype = DTYPE_OVERRIDE;
    plan.downloadMB = modelDownloadMB(plan.key, plan.dtype) ?? plan.downloadMB;
    plan.warnings.push(`量化格式由網址參數覆寫為 ${DTYPE_OVERRIDE}`);
  }
  $('out-probe').textContent = [
    `WebGPU        ${caps.webgpu ? '✅' : '❌ ' + caps.blocker}`,
    `shader-f16    ${caps.f16 ? '✅（可用 q4f16，小 60 MB）' : '❌（退回 q4）'}`,
    `GPU           ${caps.adapter ? `${caps.adapter.vendor} ${caps.adapter.architecture}` : '—'}`,
    `maxBufferSize ${caps.maxBufferMB} MB`,
    `CPU 執行緒     ${caps.cores}`,
    `裝置類型       ${caps.tablet ? '平板' : caps.mobile ? '手機' : '桌機'}${caps.ios ? '（iOS／iPadOS）' : ''}`,
    `儲存配額       ${caps.quotaMB == null ? '查不到' : `${caps.usedMB} / ${caps.quotaMB} MB`}`,
    '',
    `→ 選定：${plan.label}｜${plan.dtype}｜${plan.device}`,
    MODELS[plan.key]?.kind !== 'vl'
      ? `→ 下載：${plan.downloadMB} MB（純文字模型，沒有用不到的視覺權重）`
      : `→ 下載：${plan.downloadMB} MB（純文字需 ${plan.weightsMB} MB，視覺編碼器用不到但仍會載入）`,
    ...plan.warnings.map(w => `⚠ ${w}`),
  ].join('\n');
  $('btn-load').disabled = !!plan.blocked;
};

// ── 2. 載入 ─────────────────────────────────────────────────────
const files = new Map();

$('btn-load').onclick = async () => {
  $('btn-load').disabled = true;
  $('out-load').textContent = '載入中…（首次需要下載，請看進度）';
  $('bar').hidden = false;
  files.clear();

  try {
    const { ms, plan } = await rt.load(p => {
      if (p.evictedMB) $('bar-text').textContent = `空間不足，已清出 ${p.evictedMB} MB，重新下載中…`;
      if (p.total) files.set(p.file, { loaded: p.loaded, total: p.total });
      let l = 0, t = 0;
      for (const v of files.values()) { l += v.loaded; t += v.total; }
      if (t) {
        $('bar').value = (l / t) * 100;
        $('bar-text').textContent = `${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB　（${files.size} 個檔案）`;
      }
    });
    $('bar').hidden = true;
    const eng = MODELS[plan.key]?.engine === 'wllama' ? 'wllama／GGUF' : 'transformers.js／ONNX';
    $('out-load').textContent = `✅ 載入完成 ${(ms / 1000).toFixed(1)} 秒｜${plan.label}｜${eng}`
      + `｜${plan.device}${rt.webgpu != null ? `（WebGPU ${rt.webgpu ? '可用' : '不可用'}）` : ''}`
      + `${rt.nglUsed != null ? `｜GPU 層數 ${rt.nglUsed}` : ''}`;
    $('btn-one').disabled = false;
    $('btn-script').disabled = false;
    $('btn-unload').disabled = false;
  } catch (e) {
    $('bar').hidden = true;
    // kind 是標籤，不是訊息文字比對（handbook §9.2 第 6 條）
    const hint = {
      'no-backend': '這個瀏覽器跑不動本機模型。',
      download: '模型下載失敗。檢查網路，或稍後重試。',
      load: '模型載入失敗。最常見的原因是記憶體或 GPU 緩衝區上限不足。',
      unsupported: '這個推論引擎不支援該模型架構——換引擎或換模型，不是調參數能解決的。',
    }[e.kind] || '未預期的錯誤。';
    $('out-load').textContent = `❌ [${e.kind}] ${hint}\n${e.message}`;
    $('btn-load').disabled = false;
  }
};

// 模型快取管理：測過幾個模型之後 OPFS 會被填滿，下一個就下載失敗（桌面 2026-08-20 實測）。
$('btn-cache').onclick = async () => {
  const items = await listCached();
  const total = items.reduce((a, b) => a + b.bytes, 0);
  const est = await navigator.storage.estimate().catch(() => ({}));
  const lines = items.map(i => `  ${(i.bytes / 1e6).toFixed(0).padStart(5)} MB  ${i.name}`);
  const msg = [
    `OPFS 內的模型（共 ${(total / 1e6).toFixed(0)} MB）：`,
    ...(lines.length ? lines : ['  （空）']),
    '',
    `瀏覽器配額：${Math.round((est.usage || 0) / 1e6)} / ${Math.round((est.quota || 0) / 1e6)} MB`,
  ].join(String.fromCharCode(10));
  if (items.length && confirm(msg + String.fromCharCode(10, 10) + '要全部清除嗎？')) {
    const freed = await evictCached([]);
    alert(`已清除 ${(freed / 1e6).toFixed(0)} MB`);
  } else {
    alert(msg);
  }
};

$('btn-unload').onclick = () => {
  rt.dispose();
  $('out-load').textContent = '已卸載（記憶體釋放測試）';
  $('btn-one').disabled = $('btn-script').disabled = $('btn-unload').disabled = true;
  $('btn-load').disabled = false;
};

// ── 3. 單回合 ───────────────────────────────────────────────────
$('btn-one').onclick = async () => {
  $('btn-one').disabled = true; $('btn-stop').disabled = false;

  const turnArgs1 = {
    history: [], userText: SCRIPT[0], trust: 70, guidance: 0,
    difficulty: PERSONA.difficulty, maxGuidance: 5, canEnd: false,
  };
  const msgs = buildMessages(turnArgs1);
  const b = promptBudget(
    roleplaySystem(PERSONA, MODE, CONTEXT),
    usePlain() ? roleplaySystemPlain(PERSONA, MODE, CONTEXT) : roleplaySystemSmall(PERSONA, MODE, CONTEXT),
  );
  const head = `模式 ${modeLabel()}`
    + `｜訊息 ${msgs.length} 段共 ${charsOf(msgs)} 字\n`
    + `system：完整版 ${b.fullChars} 字 → 壓縮版 ${b.smallChars} 字（減 ${Math.round((1 - b.ratio) * 100)}%）\n\n`;

  $('out-one').textContent = head + '生成中…';
  let streamed = '';
  try {
    const rawArgs = USE_RAW ? { raw: roleplayRawPrompt(PERSONA, MODE, CONTEXT, turnArgs1), stops: rawStops(PERSONA.name) } : {};
    const r = await rt.generate(msgs, {
      tier: 'roleplay',
      prefill: USE_RAW ? '' : prefill(),
      ...rawArgs,
      onDelta: d => { streamed += d; $('out-one').textContent = head + prefill() + streamed; },
    });
    $('out-one').textContent = head + report(r);
  } catch (e) {
    $('out-one').textContent = head + `❌ [${e.kind}] ${e.message}`;
  }
  $('btn-one').disabled = false; $('btn-stop').disabled = true;
};

$('btn-stop').onclick = () => rt.abort();

function report(r) {
  const j = toJson(r);
  const lines = [
    r.text, '',
    '── 量測 ──',
    `首 token      ${r.stats.ttftMs} ms`,
    `總時間        ${r.stats.totalMs} ms`,
    `生成速度      ${r.stats.tps} tok/s`,
    `提示詞 token   ${r.stats.promptTokens}`,
    `輸出 token     ${r.stats.outTokens}`,
    '',
    '── 引擎相容性 ──',
    `JSON 可解析    ${j ? '✅' : '❌ 解析失敗（引擎依賴這個）'}`,
  ];
  if (j) {
    if (j._plain) {
      lines.push('輸出型態      純文字（不需要 JSON，數字由程式算）');
    } else {
      const missing = ['say', 'trust_delta', 'revealed', 'end'].filter(k => !(k in j));
      lines.push(`四個欄位      ${missing.length ? '❌ 缺 ' + missing.join('、') : '✅ 齊全'}`);
    }
    lines.push(`say           ${j.say ?? '（缺）'}`);
    lines.push(`trust_delta   ${j.trust_delta ?? '（缺）'}`);
    lines.push(`revealed      ${JSON.stringify(j.revealed ?? null)}`);
    lines.push(`end           ${j.end}${j.end ? ' ⚠ Level 1 不該主動結束' : ''}`);
    const say = String(j.say || '');
    // validateRoleplay 回傳 null = 跳出角色；回傳字串 = 通過（可能被截短）
    lines.push(`跳出角色檢查   ${validateRoleplay(say) ? '✅ 通過' : '❌ 偵測到跳出角色'}`);
    lines.push(`自稱業務員     ${SELF_AGENT.test(say) ? '❌ 演錯角色' : '✅ 沒有'}`);
    lines.push(`品牌中立化     ${scrubBrands(say) === say ? '✅ 未提及保險公司' : '⚠ 被程式層攔下'}`);
  }
  return lines.join('\n');
}

// ── 4. 五回合腳本 ───────────────────────────────────────────────
$('btn-script').onclick = async () => {
  $('btn-script').disabled = true;
  $('out-script').innerHTML = '';
  $('out-summary').hidden = true;

  const history = [];
  let trust = 70;
  const stats = [];
  const revealedAll = new Set();
  let jsonFail = 0, roleFail = 0, brandHit = 0, earlyEnd = 0, fieldOk = 0;
  let echoHit = 0, wrongRoleHit = 0, selfRepeatHit = 0, retried = 0, complyHit = 0, copyHit = 0, invertHit = 0;

  for (let i = 0; i < SCRIPT.length; i++) {
    const userText = SCRIPT[i];
    const turnArgs = {
      history, userText, trust, guidance: 0,
      difficulty: PERSONA.difficulty, maxGuidance: 5, canEnd: false,
    };

    const box = document.createElement('div');
    box.className = 'turn';
    box.innerHTML = `<div class="u">回合 ${i + 1}　業務員：${esc(userText)}</div><div class="a">生成中…</div><div class="meta"></div>`;
    $('out-script').append(box);

    // 兩層防護（handbook §2.7）：程式攔到鸚鵡式重複或演錯角色就重新生成一次。
    // 這是「提示詞已經寫了但模型照樣違反」的標準處理方式，不是額外的貼補。
    const prevSays = history.filter(h => h.speaker === 'client').slice(-3).map(h => h.text);
    let r = null, j = null, sig = null, tries = 0, rawFix = '';
    while (tries < 2) {
      tries++;
      const msgs = buildMessages(turnArgs);
      if (tries === 2) {
        // 重試指令要指名問題。含糊的「剛才不對」對小模型沒有作用。
        const why = sig?.invertsRole ? '你是客戶，不是賣東西的人。不要提供商品、不要說要幫對方安排。'
          : sig?.tooCompliant ? '你答應得太快了。你還不了解對方要賣什麼，不可能馬上決定要買。'
          : sig?.copiesPersona ? '不要照著設定的文字念。用你自己的口語說同一件事，句子要短。'
            : sig?.wrongRole ? '你把自己說成打電話來的人了。你是接電話的那一位。'
              : '不要重複對方剛說過的話，用你自己的話回應。';
        const fix = '\n注意：上一次的回答不對。' + why;
        msgs[msgs.length - 1] = { role: 'user', content: msgs[msgs.length - 1].content + fix };
        rawFix = fix;
      }
      try {
        r = await rt.generate(msgs, USE_RAW
          ? {
            tier: 'roleplay',
            raw: injectFix(roleplayRawPrompt(PERSONA, MODE, CONTEXT, turnArgs), rawFix, PERSONA.name),
            stops: rawStops(PERSONA.name),
          }
          : { tier: 'roleplay', prefill: prefill() });
      } catch (e) {
        box.querySelector('.a').innerHTML = `<span class="bad">❌ [${e.kind}] ${esc(e.message)}</span>`;
        r = null; break;
      }
      j = toJson(r);
      if (!j) break;
      sig = turnSignals({ modelJson: j, userText, persona: PERSONA, difficulty: PERSONA.difficulty, prevSays });
      if (!sig.echo && !sig.wrongRole && !sig.selfRepeat && !sig.tooCompliant && !sig.copiesPersona && !sig.invertsRole) break;
      if (tries === 1) retried++;
    }
    if (!r) break;

    stats.push(r.stats);
    if (!j) {
      jsonFail++;
      box.querySelector('.a').innerHTML = `<span class="bad">❌ JSON 解析失敗</span><br>${esc(r.text.slice(0, 300))}`;
      box.querySelector('.meta').textContent = fmt(r.stats);
      continue;
    }

    const say = sig.say;
    const broke = !validateRoleplay(say);
    if (broke) roleFail++;
    if (sig.echo) echoHit++;
    if (sig.selfRepeat) selfRepeatHit++;
    if (sig.wrongRole) wrongRoleHit++;
    if (sig.tooCompliant) complyHit++;
    if (sig.copiesPersona) copyHit++;
    if (sig.invertsRole) invertHit++;
    if (scrubBrands(say) !== say) brandHit++;
    if (sig.modelWantsEnd && i < SCRIPT.length - 1) earlyEnd++;
    if (j._plain || ['say', 'trust_delta', 'revealed', 'end'].every(k => k in j)) fieldOk++;
    sig.revealed.forEach(x => revealedAll.add(x));

    // 信任度用程式算的值，不用模型填的（模型五回合都填 0）
    trust = clamp(trust + sig.trustDelta);
    history.push({ speaker: 'user', text: userText }, { speaker: 'client', text: say });

    box.querySelector('.a').textContent = `${PERSONA.name}：${say}`;
    box.querySelector('.meta').textContent =
      `${fmt(r.stats)}　信任 ${trust}（程式 ${signed(sig.trustDelta)}／模型填 ${j.trust_delta}）`
      + `　透露 ${JSON.stringify(sig.revealed)}`
      + `${tries > 1 ? '　↻ 重新生成' : ''}${sig.echo ? '　⚠ 重複對方' : ''}${sig.selfRepeat ? '　⚠ 重複自己' : ''}${sig.tooCompliant ? '　⚠ 過度順從' : ''}${sig.copiesPersona ? '　⚠ 照抄人設' : ''}${sig.invertsRole ? '　⚠ 角色反轉' : ''}${sig.wrongRole ? '　⚠ 自稱業務員' : ''}`
      + `${broke ? '　⚠ 跳出角色' : ''}`
      + (sig.trustWhy.length ? `
　　判定依據：${sig.trustWhy.join('；')}` : '');
  }

  const n = stats.length || 1;
  const avg = k => Math.round(stats.reduce((a, s) => a + (s[k] || 0), 0) / n);
  $('out-summary').hidden = false;
  $('out-summary').textContent = [
    `── 五回合總結（${modeLabel()}）──`,
    `提示詞 token      約 ${avg('promptTokens')}`,
    `平均首 token      ${avg('ttftMs')} ms`,
    `平均每回合        ${avg('totalMs')} ms　${avg('totalMs') <= 2000 ? '✅ 達成 ≤2 秒（規格 §29）' : '❌ 超過 2 秒'}`,
    `平均生成速度      ${(stats.reduce((a, s) => a + (s.tps || 0), 0) / n).toFixed(1)} tok/s`,
    '',
    usePlain()
      ? `輸出可用            ${fieldOk} / ${stats.length}（純文字模式，無 JSON 解析風險）`
      : `JSON 解析失敗      ${jsonFail} / ${stats.length}${jsonFail ? '　❌' : '　✅'}`,
    usePlain() ? '' : `四個欄位齊全       ${fieldOk} / ${stats.length}${fieldOk === stats.length ? '　✅' : '　❌'}`,
    `重新生成           ${retried} 次（程式攔下後重試）`,
    `重複對方的話       ${echoHit} 次${echoHit ? '　❌ 重試後仍發生' : '　✅'}`,
    `重複自己前幾句     ${selfRepeatHit} 次${selfRepeatHit ? '　❌ 重試後仍發生' : '　✅'}`,
    `自稱業務員         ${wrongRoleHit} 次${wrongRoleHit ? '　❌ 重試後仍發生' : '　✅'}`,
    `過度順從（秒答應） ${complyHit} 次${complyHit ? '　❌ 會給新人虛假的成功感' : '　✅'}`,
    `照抄人設文字       ${copyHit} 次${copyHit ? '　❌ 不像真人講話' : '　✅'}`,
    `角色反轉（供給方） ${invertHit} 次${invertHit ? '　❌ 做了業務員的事' : '　✅'}`,
    `跳出角色           ${roleFail} 次${roleFail ? '　❌' : '　✅'}`,
    `提及保險公司       ${brandHit} 次（程式層攔下）`,
    `過早結束對話       ${earlyEnd} 次${earlyEnd ? '　❌' : '　✅ 符合 Level 1'}`,
    `挖到的隱藏需求     ${[...revealedAll].sort().join(', ') || '（無）'}　共 ${revealedAll.size} / 3 項`,
    `最終信任度         ${trust}（起始 70）${trust === 70 ? '　⚠ 完全沒變動' : '　✅ 難度系統有在運作'}`,
  ].join('\n');
  $('btn-script').disabled = false;
};

// ── 小工具 ──────────────────────────────────────────────────────
const clamp = x => Math.max(0, Math.min(100, Math.round(x)));
const signed = x => (Number(x) > 0 ? `+${x}` : `${x ?? 0}`);
const fmt = s => `首token ${s.ttftMs}ms　總 ${s.totalMs}ms　${s.tps} tok/s　prompt ${s.promptTokens} tok`;
// 續寫模式的提示詞是一整串逐字稿，修正指令要插在「客戶名：」那一行之前，
// 否則會被當成對話內容的一部分。
const injectFix = (prompt, fix, name) => {
  if (!fix) return prompt;
  const tail = String.fromCharCode(10) + name + '：';
  const i = prompt.lastIndexOf(tail);
  return i < 0 ? prompt + fix : prompt.slice(0, i) + fix + prompt.slice(i);
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

window.LAB = { rt, PERSONA, SCRIPT, buildMessages, SELF_AGENT };
