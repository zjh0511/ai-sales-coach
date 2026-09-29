// 端到端自我測試：不經瀏覽器，直接跑完六大功能。
// 用途：每次改動後確認整套流程都還能跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiAdapter } from '../docs/engine/gateway.js';
import * as CE from '../docs/engine/session.js';
import * as KB from '../docs/engine/knowledge.js';
import * as AD from '../docs/engine/advisor.js';
import { checkCompliance } from '../docs/engine/compliance.js';
import { officeText } from '../docs/engine/docx.js';
import { scrubBrands } from '../docs/engine/prompts.js';
import * as P from '../docs/engine/prompts.js';
import { merge } from '../docs/engine/account.js';
import { createAdapter, friendlyError } from '../docs/engine/gateway.js';
import { toTW, simplifiedLeft } from '../docs/engine/zhtw.js';
import { loadKeys } from './keys.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = loadKeys().gemini;
if (!key) { console.error('找不到 Gemini 金鑰。請在專案根目錄放「API Key.txt」，或設定 GEMINI_API_KEY。'); process.exit(1); }

const ONLY = process.argv[2];                       // 例：node tools/selftest.mjs 5  只跑第 5 節
const run = n => !ONLY || ONLY === String(n);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${extra ? ' → ' + extra : ''}`); };
const t = () => Date.now();
const perf = {};

const gw = new GeminiAdapter(key);

// ── 1. 規則引擎與文件解析（不呼叫模型）────────────────────────
if (run(1)) {
  console.log('\n=== 1. 合規規則引擎 ===');
  ok(checkCompliance('我可以退佣給你').level === 'high', '「退佣」判定為高風險');
  ok(checkCompliance('保證獲利喔').level === 'high', '「保證獲利」判定為高風險');
  ok(checkCompliance('健康狀況不要寫上去').level === 'high', '「誘導不實告知」判定為高風險');
  ok(checkCompliance('這個就像存錢一樣').level === 'warn', '「存錢」判定為需注意');
  ok(checkCompliance('您好，我想跟您約個時間').level === 'none', '正常話術不誤判');

  console.log('\n=== 1b. 話術品牌中立化 ===');
  const cases = [
    ['王先生您好，我是國泰人壽的張小豪', '王先生您好，我是○○人壽的張小豪'],
    ['我是南山的業務員', '我是○○的業務員'],
    ['台灣人壽跟富邦人壽都有類似商品', '○○人壽跟○○人壽都有類似商品'],
    ['我在三商美邦人壽服務十年了', '我在○○人壽服務十年了'],
    ['客戶說他在台灣人的觀念裡覺得保險不吉利', '客戶說他在台灣人的觀念裡覺得保險不吉利'],  // 不可誤殺
    ['中國信託的理專介紹他買的', '中國信託的理專介紹他買的'],                              // 銀行不誤殺
  ];
  for (const [i, o] of cases) ok(scrubBrands(i) === o, `「${i.slice(0, 16)}…」`, scrubBrands(i));

  console.log('\n=== 1c. 難度系統與人設後設用語過濾 ===');
  ok(P.difficultyOf(1).canEnd === false, 'Level 1 客戶不會主動結束對話');
  ok(P.difficultyOf(1).trust[0] >= 60, `Level 1 初始信任度下限 ${P.difficultyOf(1).trust[0]}（≥60）`);
  ok(P.difficultyOf(1).guidance > P.difficultyOf(5).guidance,
    `Level 1 引導次數 ${P.difficultyOf(1).guidance} > Level 5 的 ${P.difficultyOf(5).guidance}`);
  ok(P.difficultyOf(5).canEnd === true, 'Level 5 客戶可以主動結束對話');
  ok(P.difficultyOf(1).trust[0] > P.difficultyOf(5).trust[1], '難度越低初始信任度越高');
  ok(P.difficultyOf(99).label === P.DIFFICULTY[2].label, '未知難度退回 Level 2');

  ok(P.scrubMeta('個性冷淡，但因為難度設定為新手友善，其實很有耐心。') === '個性冷淡，其實很有耐心。',
    '刪除人設中的後設用語子句');
  ok(P.scrubMeta('個性很急，只想聽重點。') === '個性很急，只想聽重點。', '正常人設不被動到');
  ok(P.scrubMeta('系統設定為 Level 3。') === '系統設定為 Level 3。', '整段都是後設時退回原文，不留空人設');

  console.log('\n=== 1d. Office 文件解析（零外部相依）===');
  const pptx = path.join(DIR, '【AiCoach】AI業務教練.pptx');
  if (fs.existsSync(pptx)) {
    const txt = await officeText(new Uint8Array(fs.readFileSync(pptx)), 'x.pptx');
    ok(txt.length > 300, `PPTX 取字 ${txt.length} 字`);
    ok((txt.match(/【第 \d+ 頁】/g) || []).length >= 10, `分頁正確 ${(txt.match(/【第 \d+ 頁】/g) || []).length} 頁`);
  } else console.log('  --  找不到範例 PPTX，略過');
  // 雲端同步的合併規則。這是整個帳號功能唯一會「弄丟使用者資料」的地方，
  // 而且出錯時很安靜——紀錄少了幾筆，使用者通常不會察覺。
  console.log('\n=== 1e. 雲端同步合併 ===');
  {
    const A = { history: [{ at: 300, name: '手機A' }, { at: 100, name: '共同' }], prefs: { diff: '1', updatedAt: 50 } };
    const B = { history: [{ at: 200, name: '電腦B' }, { at: 100, name: '共同' }], prefs: { diff: '4', updatedAt: 90 } };

    const m = merge(A, B);
    ok(m.history.length === 3, '兩台裝置的紀錄取聯集（3 筆）', String(m.history.length));
    ok(m.history.map(h => h.at).join(',') === '300,200,100', '依時間新到舊排序');
    ok(m.history.filter(h => h.at === 100).length === 1, '同一筆紀錄不會重複');
    ok(m.prefs.diff === '4', 'updatedAt 較晚的偏好設定勝出');
    ok(merge(B, A).prefs.diff === '4', '換邊呼叫結果相同（合併沒有方向性）');

    // 第一次登入：雲端還沒有資料，本機的東西不能被清掉
    ok(merge(A, null).history.length === 2, '雲端為空時保留本機全部紀錄');
    ok(merge(null, B).history.length === 2, '本機為空時完整拉下雲端紀錄');
    ok(merge(null, null).history.length === 0, '兩邊都空不會炸');

    // 壞資料不能讓同步整個停擺
    ok(merge({ history: [null, { name: '沒有 at' }, { at: 7 }] }, {}).history.length === 1,
       '沒有時間戳的壞紀錄被略過');

    // 上限：不能無限成長把 localStorage 撐爆
    const cap = merge({ history: Array.from({ length: 150 }, (_, i) => ({ at: i + 1 })) }, {});
    ok(cap.history.length === 100, '紀錄上限 100 筆', String(cap.history.length));
    ok(cap.history[0].at === 150, '超過上限時保留最新的，丟掉最舊的');
  }
  // 模型挑選。這是會「默默用錯模型」的地方——不會報錯，只會變慢或變差。
  console.log('');
  console.log('=== 1f. 模型自動挑選 ===');
  {
    const K = 'x'.repeat(40);                 // 只測挑選邏輯，不發任何請求
    const pick = (p, models) => { const a = createAdapter(p, K); a._rank(models); return a.status(); };

    // Gemini 預設推薦 3.5 Flash Lite（使用者指定；也與實測一致：
    // 免費額度下 3.5-flash 被限流到 26.5 秒，flash-lite 是 1.1 秒）
    const g = pick('gemini', ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.7-pro']);
    ok(g.auto.fast === 'gemini-3.5-flash-lite', 'Gemini 角色扮演用 3.5 Flash Lite', g.auto.fast);
    ok(g.recommended[0] === 'gemini-3.5-flash-lite', 'Gemini 的 ★ 第一名是 3.5 Flash Lite');
    ok(g.auto.judge === 'gemini-3.5-flash-lite', '評分也預設用 3.5 Flash Lite（使用者指定）', g.auto.judge);
    ok(pick('gemini', ['gemini-3.7-flash', 'gemini-4.0-flash-lite', 'gemini-4.2-flash-lite']).auto.fast
       === 'gemini-4.2-flash-lite', '3.5 被下架時自動挑最新的 flash-lite');

    // Groq 預設用 Qwen 27B（使用者指定）。用比對模式而非寫死 ID：
    // 2026-08-21 查證 Groq 上是 qwen/qwen3.6-27b，沒有 3.8 版
    const q = pick('groq', ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b']);
    ok(q.auto.fast === 'qwen/qwen3.6-27b', 'Groq 角色扮演用 Qwen 27B', q.auto.fast);
    ok(q.auto.judge === 'qwen/qwen3.6-27b', 'Groq 評分也用 Qwen 27B');
    ok(pick('groq', ['llama-3.1-8b-instant', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b']).auto.fast
       === 'qwen/qwen3.8-27b', 'Groq 上架更新版的 Qwen 27B 會自動接上');
    ok(pick('groq', ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']).auto.fast
       === 'llama-3.1-8b-instant', '完全沒有 Qwen 時退回 llama，不會挑到不存在的模型');

    // 「同模式命中多個時選較新的」不能弄壞其他服務商
    ok(pick('anthropic', ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']).auto.fast
       === 'claude-haiku-4-5', 'Anthropic 的挑選不受影響');
    ok(pick('openrouter', ['google/gemini-3.7-flash', 'openai/gpt-5.2-mini', 'anthropic/claude-opus-5']).auto.fast
       === 'google/gemini-3.7-flash', 'OpenRouter 的挑選不受影響');
  }
  // 簡體字轉繁體。提示詞層已經寫了「不使用簡體字」，但實測 Groq 的
  // qwen/qwen3.8-27b 照樣寫出「打扰」「班级里」——這是程式層的最後一道防線。
  console.log('');
  console.log('=== 1g. 簡體字轉繁體 ===');
  {
    const cases = [
      ['打扰您了', '打擾您了'],
      ['一个班级，什么事情是必须先处理的？', '一個班級，什麼事情是必須先處理的？'],
      ['保险规划与医疗费用', '保險規劃與醫療費用'],
      ['经济压力与终身险', '經濟壓力與終身險'],
      ['继续讨论投资报酬与风险', '繼續討論投資報酬與風險'],
      ['头发很长', '頭髮很長'],
    ];
    for (const [inp, want] of cases) ok(toTW(inp) === want, `轉換「${inp}」`, toTW(inp));

    // 已經是繁體的不該被動到——誤轉比不轉更糟
    const tw = '台灣人壽的業務員很專業，客戶說他很滿意';
    ok(toTW(tw) === tw, '純繁體輸入完全不變');
    ok(toTW('gemini-3.5-flash-lite qwen/qwen3.8-27b') === 'gemini-3.5-flash-lite qwen/qwen3.8-27b',
       '模型名稱等非中文內容不受影響');

    // 歧義字刻意不轉：轉錯會把「公里」變成「公裡」，那比留著簡體字更糟
    ok(toTW('公里') === '公里', '一字多形的歧義字刻意不轉（公里）');

    // 冪等：轉過的再轉一次必須一樣，否則同步或快取時會越轉越亂
    ok(cases.every(([i]) => toTW(toTW(i)) === toTW(i)), '轉兩次結果相同（冪等）');

    // 非字串進來不能炸——Gateway 會把整個回應丟進來
    ok(toTW(undefined) === undefined && toTW(null) === null && toTW('') === '', '非字串輸入安全通過');
    ok(simplifiedLeft('打扰') === '扰' && simplifiedLeft('打擾') === '', '殘留偵測可用（用來衡量模型乾不乾淨）');
  }
  // ── A1：評分失敗時，整場演練不能跟著消失 ─────────────────────
  // 原本 finish() 在呼叫評分之前就清掉 sessionId，評分也一開始就把狀態改成
  // EVALUATING；而「接回」只認 ROLEPLAY。模型逾時或額度用完，逐字稿就沒了。
  console.log('');
  console.log('=== 1h. 評分失敗不弄丟演練 ===');
  {
    // 「接回上次中斷的演練」已移除（D039），session 只存在記憶體裡。
    // 這裡驗證仍保留的部分：評分失敗時逐字稿還在，原地「重新評分」可以成功。
    const SE = await import('../docs/engine/session.js?a1');
    const persona = {
      name: '陳先生', public_summary: '45 歲國小老師', opening_line: '喂，你好？',
      voice_hint: { rate: 1, pitch: 1 }, trust: 70, personality: '溫和', communication_style: '客氣',
      hidden_needs: ['擔心孩子教育費'], scenario: { objective: '約到見面' },
      demo: { opening: '您好，我是○○人壽的○○', key_question: '最近忙嗎？', objection_handling: { customer: '沒空', you: '我理解' } },
    };
    let evalFails = true;
    const gw = { generate: async (text, opts) => {
      if (opts?.tier === 'judge') {
        if (evalFails) throw new Error('429 額度用盡');
        return { text: JSON.stringify({
          scores: { fluency: { score: 4, evidence: '' }, friendliness: { score: 4, evidence: '' } },
          summary: '不錯', improvements: [], example_script: '', next_challenge: '',
        }), ms: 1, model: 'fake' };
      }
      if (/opening_line/.test(text)) return { text: JSON.stringify(persona), ms: 1, model: 'fake' };
      return { text: JSON.stringify({ say: '嗯，你說說看。', trust_delta: 0, revealed: [], end: false }), ms: 1, model: 'fake' };
    } };

    const pub = await SE.startSession(gw, { mode: 'call', gender: '男', age: '45', background: '老師', difficulty: 1 });
    const s = SE.getSession(pub.sessionId);
    SE.beginRoleplay(s);
    await SE.handleTurn(gw, s, '陳先生您好，我是○○人壽的○○');
    await SE.handleTurn(gw, s, '想跟您約個時間聊聊');

    let threw = false;
    try { await SE.evaluate(gw, s); } catch { threw = true; }
    ok(threw, '評分失敗時確實往外拋錯（讓畫面知道要顯示重試）');
    ok(s.state === 'COMPLETED', '失敗後狀態退回 COMPLETED（對話已結束、待評分）', s.state);
    ok(!!SE.getSession(pub.sessionId), '失敗後 session 仍在');
    ok(SE.getSession(pub.sessionId).history.filter(h => h.speaker === 'user').length === 2,
      '逐字稿完整保留（2 個回合）');

    evalFails = false;
    const fb = await SE.evaluate(gw, s);
    ok(!!fb?.scores, '重新評分成功');
    ok(s.state === 'FEEDBACK_READY', '成功後狀態為 FEEDBACK_READY');
    SE.dropSession(s.id);
  }

  // ── A2：帳號被停用或刪除時要真的登出；沒網路時不能登出 ─────────
  console.log('');
  console.log('=== 1i. 登入失效的判斷 ===');
  {
    const A = await import('../docs/engine/account.js');
    const realFetch = globalThis.fetch;
    let refresh = null, refreshCalls = 0;
    const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    globalThis.fetch = async url => {
      if (String(url).includes('accounts:signInWithPassword'))
        return res(200, { localId: 'u1', email: 't@example.com', idToken: 'old', refreshToken: 'r1', expiresIn: '30' });
      if (String(url).includes('securetoken')) { refreshCalls++; return refresh(); }
      throw new Error('unexpected ' + url);
    };
    // expiresIn 30 秒 − 60 秒安全邊際 → 一登入就是「已過期」，下一次 token() 必定走更新
    const login = () => A.signInEmail('t@example.com', 'x');
    try {
      await login();
      refresh = async () => { throw new TypeError('fetch failed'); };
      ok(await A.token() === null && !!A.user(), '沒網路：拿不到 token，但保留登入狀態（離線照常可用）');

      refresh = async () => res(503, {});
      ok(await A.token() === null && !!A.user(), '伺服器 5xx：暫時性錯誤，保留登入狀態');

      refreshCalls = 0;
      refresh = async () => { await new Promise(r => setTimeout(r, 30)); return res(200, { id_token: 'new', refresh_token: 'r2', expires_in: '3600' }); };
      const [t1, t2] = await Promise.all([A.token(), A.token()]);
      ok(t1 === 'new' && t2 === 'new' && refreshCalls === 1, '同時要 token：只送一次更新請求', `calls=${refreshCalls}`);

      await login();
      refresh = async () => res(400, { error: { message: 'TOKEN_EXPIRED' } });
      ok(await A.token() === null && A.user() === null, '帳號失效（400）：真的登出，下次回首頁會被擋在登入頁');

      await login();
      refresh = async () => res(403, { error: { message: 'USER_DISABLED' } });
      ok(await A.token() === null && A.user() === null, '帳號被停用（403）：真的登出');
    } finally {
      globalThis.fetch = realFetch;
      A.signOut();
    }
  }

  // ── B2：語音引擎在手機上的三個卡點 ──────────────────────────
  // 用假的朗讀引擎與辨識器重現：播完不觸發 onend、收音卡住、拿到結果卻不結束。
  console.log('');
  console.log('=== 1j. 語音穩定度 ===');
  {
    const synth = {
      speaking: false, pending: false, paused: false, dropOnEnd: false, neverStart: false,
      speak(u) {
        if (this.neverStart) return;
        this.pending = true;
        setTimeout(() => {
          this.pending = false; this.speaking = true; u.onstart?.();
          setTimeout(() => { this.speaking = false; if (!this.dropOnEnd) u.onend?.(); }, 40);
        }, 10);
      },
      cancel() { this.speaking = false; this.pending = false; }, resume() {}, getVoices: () => [],
    };
    class FakeSR {
      constructor() { FakeSR.last = this; }
      start() { FakeSR.plan?.(this); }
      stop() { this.stopped = true; }
      abort() { this.aborted = true; }
    }
    const said = (r, t) => r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] });
    globalThis.window = { speechSynthesis: synth, SpeechRecognition: FakeSR };
    globalThis.speechSynthesis = synth;
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };

    const V = await import('../docs/voice.js?b2');
    if (V.TIMING) Object.assign(V.TIMING, { stall: 150, end: 100, start: 200, poll: 20 });
    const got = { final: [], empty: 0, stall: 0 };
    const reset = () => { got.final = []; got.empty = 0; got.stall = 0; };
    const v = new V.Voice({
      onFinal: t => got.final.push(t), onEmpty: () => got.empty++, onStall: () => got.stall++, onState() {}, onPartial() {},
    });
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // 朗讀：裝置播完卻不觸發 onend
    synth.dropOnEnd = true;
    let t0 = Date.now();
    await v.speak('好的沒問題');
    const dt = Date.now() - t0;
    ok(dt < 500, `播完漏掉 onend：輪詢偵測到播完就放行（${dt}ms；原本要等保險絲 ${3000 + 5 * 260}ms）`);
    synth.dropOnEnd = false;

    // 朗讀：根本沒開始播放
    synth.neverStart = true;
    t0 = Date.now();
    await v.speak('測試');
    ok(Date.now() - t0 < 600, '朗讀一直沒開始：時間到就放行，不會卡死');
    synth.neverStart = false;

    // 收音：啟動了但什麼都沒回
    reset(); FakeSR.plan = () => {};
    v.listen(); await wait(250);
    ok(got.stall === 1 && !got.final.length && v.state === 'idle', '收音卡住：偵測到並回報，交給畫面自動重接');

    // 收音：拿到最終結果但 onend 沒來
    reset(); FakeSR.plan = r => setTimeout(() => said(r, '您好'), 10);
    v.listen(); await wait(200);
    ok(got.final.length === 1 && got.final[0] === '您好', '拿到結果但沒觸發 onend：強制收尾，這一句照樣送出');

    // 收音：正常結束——同一句不能送兩次（onend 與強制收尾都會走到收尾）
    reset(); FakeSR.plan = r => setTimeout(() => { said(r, '好'); setTimeout(() => r.onend?.(), 5); }, 10);
    v.listen(); await wait(200);
    ok(got.final.length === 1, '正常結束：同一句只送出一次', String(got.final.length));

    // 收音：沒聽到聲音
    reset(); FakeSR.plan = r => setTimeout(() => { r.onerror?.({ error: 'no-speech' }); r.onend?.(); }, 10);
    v.listen(); await wait(80);
    ok(got.empty === 1 && got.stall === 0, '沒聽到聲音：回報「這一輪是空的」而不是錯誤');

    // 使用者中止後，舊辨識器晚到的事件必須被忽略
    reset(); FakeSR.plan = () => {};
    v.listen(); const old = FakeSR.last; v.abortListening();
    said(old, '晚到的字'); old.onend?.(); await wait(250);
    ok(!got.final.length && !got.stall && !got.empty, '中止後舊辨識器晚到的事件全部被忽略');

    ok(V.MIC_AFTER_TTS_MS === 300, '非 iOS 裝置播完後等 300ms 開麥克風（iOS 為 3500ms）');
    delete globalThis.window; delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance;
  }
  // ── 備援鏈：2026-09-29 實際踩到的情況 ─────────────────────────
  // gemini-3.5-flash-lite 回 503（需求量過高）→ 降級到的模型回 404
  // （已不開放給新使用者）→ 原本整條鏈直接中止，根本沒去試健康的 3.7-flash。
  console.log('');
  console.log('=== 1k. 備援鏈遇到塞車與下架模型 ===');
  {
    const K = 'x'.repeat(40);
    const a = createAdapter('gemini', K);
    a._rank(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.7-flash']);
    ok(a.fastList.indexOf('gemini-2.5-flash-lite') > a.fastList.indexOf('gemini-3.7-flash'),
      '已下架的 2.x 不再排在健康的 3.7-flash 前面', a.fastList.join(' → '));

    const calls = [];
    a._call = async m => {
      calls.push(m);
      if (m === 'gemini-3.5-flash-lite') throw new Error('gemini 503: This model is currently experiencing high demand');
      if (m === 'gemini-3.1-flash-lite') throw new Error('gemini 404: This model is no longer available to new users');
      return { text: '好', ms: 1, model: m };
    };
    const r = await a.generate('測試', {});
    ok(r.model === 'gemini-3.7-flash', '塞車＋下架都跳過，最後由健康的模型回應', r.model);
    ok(calls.filter(m => m === 'gemini-3.5-flash-lite').length === 2, '塞車的模型只重試一次就換', calls.join(' → '));
    ok(calls.filter(m => m === 'gemini-3.1-flash-lite').length === 1, '404 的模型不重試');

    calls.length = 0;
    await a.generate('下一回合', {});
    ok(calls[0] === 'gemini-3.7-flash', '下一回合直接用健康的模型，不必每回合先撞一次', calls.join(' → '));

    // 全部都不能用：要丟出錯誤，不能掛住
    const b = createAdapter('gemini', K);
    b._rank(['gemini-3.5-flash-lite', 'gemini-3.7-flash']);
    b._call = async () => { throw new Error('gemini 404: not found'); };
    let threw = false;
    try { await b.generate('x', {}); } catch { threw = true; }
    ok(threw, '每個模型都 404：丟出錯誤讓畫面顯示，而不是無限重試');

    // 全面塞車（2026-09-29 實際發生）：尾端的下架模型回 404，
    // 但真正的原因是塞車——使用者該看到「服務商塞車」而不是「卡了一下」
    const c = createAdapter('gemini', K);
    c._rank(['gemini-3.5-flash-lite', 'gemini-3.7-flash', 'gemini-2.5-flash']);
    c._call = async m => {
      if (m === 'gemini-2.5-flash') throw new Error('gemini 404: no longer available to new users');
      throw new Error('gemini 503: This model is currently experiencing high demand');
    };
    let msg = '';
    try { await c.generate('x', {}); } catch (e) { msg = friendlyError(e.message, 'gemini') || ''; }
    ok(/塞車/.test(msg) && /不是你的金鑰/.test(msg), '全面塞車：告訴使用者是服務商塞車、不是他的問題', msg.slice(0, 40));
  }
  // ── 原始碼裡不該有控制字元 ──────────────────────────────────
  // 2026-09-29 實際發生：透過 shell → Python 改檔時，正規表示式裡的 \b 被轉義層
  // 吃成真正的退格字元（0x08）。/‹BS›404‹BS›/ 永遠比對不到東西，程式看起來寫對了，
  // 實際上是死的——「404 跳過壞掉的模型」這段完全沒生效，而且沒有任何錯誤訊息。
  console.log('');
  console.log('=== 1l. 原始碼沒有被污染的控制字元 ===');
  {
    const bad = [];
    const walk = d => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) { if (!/icons|node_modules/.test(f)) walk(p); continue; }
        if (!/\.(m?js|html|css|json|webmanifest)$/.test(f)) continue;
        fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) bad.push(`${path.relative(DIR, p)}:${i + 1}`);
        });
      }
    };
    walk(path.join(DIR, 'docs'));
    walk(path.join(DIR, 'tools'));
    ok(!bad.length, '除了 tab 以外沒有任何控制字元', bad.slice(0, 5).join('、'));
  }
  // ── 真人語音（Gemini TTS）與內建朗讀的退路 ────────────────────
  // 雲端語音的每一種失敗都必須退回內建朗讀、演練不中斷；
  // 但使用者自己插話打斷的，不能再用內建朗讀把同一句念一次。
  console.log('');
  console.log('=== 1m. 真人語音與退路 ===');
  {
    // 串流解析：事件用 \r\n 分隔、內容是 base64 的 16-bit PCM（實測格式）
    const TTS = await import('../docs/engine/tts.js');
    const pcmB64 = arr => Buffer.from(new Int16Array(arr).buffer).toString('base64');
    const CRLF = String.fromCharCode(13, 10);
    const sse = events => new Response(new ReadableStream({ start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(e) + CRLF + CRLF));
      c.close();
    } }), { status: 200 });
    const chunkEv = arr => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/l16; rate=24000; channels=1', data: pcmB64(arr) } }] } }] });
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => sse([chunkEv([1, -2, 32767]), chunkEv([-32768, 5])]);
      const got = [];
      for await (const c of TTS.streamSpeech('k', '你好', 'Charon')) got.push(c);
      ok(got.length === 2 && got[0].rate === 24000, '串流解析：\\r\\n 分隔的事件都讀得到', `${got.length} 段`);
      ok(got[0].pcm[1] === -2 && got[0].pcm[2] === 32767 && got[1].pcm[0] === -32768, 'PCM 數值正確（含正負極值）');

      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
      let m1 = ''; try { for await (const _ of TTS.streamSpeech('k', 'x', 'Charon')) { /* */ } } catch (e) { m1 = e.message; }
      ok(/429/.test(m1), 'HTTP 錯誤會帶狀態碼往外拋', m1);

      globalThis.fetch = async () => sse([{ error: { code: 503, message: 'high demand' } }]);
      let m2 = ''; try { for await (const _ of TTS.streamSpeech('k', 'x', 'Charon')) { /* */ } } catch (e) { m2 = e.message; }
      ok(/503/.test(m2), '串流中途回報的錯誤也會拋出', m2);
      ok(TTS.voiceFor('女') === 'Aoede' && TTS.voiceFor('男') === 'Charon' && TTS.voiceFor(undefined) === 'Charon',
        '男客戶 Charon、女客戶 Aoede，沒給性別用男聲');
    } finally { globalThis.fetch = realFetch; }

    // 假的播放環境
    const said = [];
    const synth = { speaking: false, pending: false, paused: false,
      speak(u) { said.push({ text: u.text, pitch: u.pitch }); setTimeout(() => { u.onstart?.(); setTimeout(() => u.onend?.(), 20); }, 5); },
      cancel() {}, resume() {}, getVoices: () => [] };
    class FakeCtx {
      constructor() { this.state = 'running'; this.t0 = performance.now(); this.destination = {}; this.at = []; FakeCtx.last = this; }
      get currentTime() { return (performance.now() - this.t0) / 1000; }
      resume() { this.state = 'running'; return Promise.resolve(); }
      createBuffer(ch, len, rate) { return { duration: len / rate, copyToChannel() {} }; }
      createBufferSource() { const ctx = this; return { connect() {}, start(t) { ctx.at.push({ t, d: this.buffer.duration }); }, stop() { this.stopped = true; } }; }
    }
    globalThis.window = { speechSynthesis: synth, SpeechRecognition: class {} };
    globalThis.speechSynthesis = synth;
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    globalThis.AudioContext = FakeCtx;
    const session = { type: 'auto', history: [] };
    Object.defineProperty(globalThis.navigator, 'audioSession', { value: session, configurable: true });
    const setType = Object.getOwnPropertyDescriptor(session, 'type');
    let typeVal = 'auto';
    Object.defineProperty(session, 'type', { get: () => typeVal, set: v => { typeVal = v; session.history.push(v); }, configurable: true });

    const V = await import('../docs/voice.js?tts');
    Object.assign(V.TIMING, { cloudFirst: 150, jitter: 0.1, poll: 20, start: 200 });
    const v = new V.Voice({ onState() {} });
    const states = []; v.onState = s => states.push(s);
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const pcm = n => new Int16Array(n).fill(100);
    let streamCalls = 0;
    const reset = () => { said.length = 0; states.length = 0; streamCalls = 0; session.history.length = 0; };

    // 1) 雲端成功：不會再用內建朗讀；每段聲音前後剛好接上
    reset();
    v.cloud = { async *stream() { streamCalls++; for (let i = 0; i < 8; i++) { await wait(5); yield { pcm: pcm(1200), rate: 24000 }; } } };
    await v.speak('喔，林大哥介紹的喔？');
    const at = FakeCtx.last?.at || [];          // 沒有雲端播放時要回報失敗，而不是崩潰
    const gaps = at.slice(1).map((x, i) => Math.abs(x.t - (at[i].t + at[i].d)));
    ok(streamCalls === 1 && said.length === 0, '真人語音成功時不會再用內建朗讀念一次');
    ok(at.length >= 2 && Math.max(...gaps) < 0.002, '每段聲音前後剛好接上，沒有縫', `${at.length} 段，最大間隙 ${(Math.max(...gaps) * 1000).toFixed(2)}ms`);
    ok(session.history[0] === 'playback' && session.history.at(-1) === 'auto',
      'iOS 播放期間切成媒體播放（靜音開關打開也聽得到），播完切回', session.history.join(' → '));

    // 2) 還沒出聲就失敗：退回內建朗讀，並告訴畫面
    reset();
    v.cloud = { async *stream() { streamCalls++; throw new Error('tts 503 high demand'); } };
    await v.speak('好的');
    ok(said.length === 1 && states.includes('tts-fallback'), '真人語音失敗：退回內建朗讀，演練不中斷');

    // 3) 額度用完：之後幾分鐘直接用內建，不必每句先撞一次
    reset(); v.cloudOffUntil = 0;
    v.cloud = { async *stream() { streamCalls++; throw new Error('tts 429 quota'); } };
    await v.speak('一');
    await v.speak('二');
    ok(streamCalls === 1 && said.length === 2, '額度用完：之後直接用內建朗讀，不再每句多等', `雲端呼叫 ${streamCalls} 次`);

    // 4) 第一段聲音遲遲不來：時間到就放棄，改用內建
    reset(); v.cloudOffUntil = 0; v.cloudFails = 0;
    v.cloud = { async *stream(t, g, signal) { streamCalls++; await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); } };
    const t0 = Date.now();
    await v.speak('測試');
    ok(said.length === 1 && Date.now() - t0 < 600, '第一段聲音太久沒來：放棄並改用內建朗讀', `${Date.now() - t0}ms`);

    // 5) 使用者插話打斷：不能再用內建朗讀把同一句念一次
    reset(); v.cloudOffUntil = 0; v.cloudFails = 0;
    v.cloud = { async *stream() { for (let i = 0; i < 40; i++) { await wait(10); yield { pcm: pcm(2400), rate: 24000 }; } } };
    const p = v.speak('這是一段很長的回覆');
    await wait(80);
    v.stopSpeaking();
    await p;
    ok(said.length === 0 && v.state === 'idle', '使用者插話打斷：停止播放，而且不會改用內建朗讀重念');

    // 6) 內建朗讀本身：逗號不切段、音高固定
    reset(); v.cloud = null;
    // 人設會給 0.8～1.2 的音高——給一個偏離的值，確認真的被固定回 1
    await v.speak('嗯，我知道，不過我最近比較忙。你下次再打來好了！', { pitch: 1.2, rate: 1 });
    ok(said.length === 2 && said[0].text === '嗯，我知道，不過我最近比較忙。', '內建朗讀只在句尾切段，逗號保留在同一句裡', said.map(s => s.text).join(' | '));
    ok(said.every(s => s.pitch === 1), '人設給了 1.2 的音高，內建朗讀仍固定為 1（改音高會更像機器）', said.map(s => s.pitch).join(','));

    await wait(300);          // 內建朗讀排了 250ms 後的「卡住保險絲」，等它跑完才能拆掉假環境
    delete globalThis.window; delete globalThis.speechSynthesis; delete globalThis.SpeechSynthesisUtterance;
    delete globalThis.AudioContext; delete globalThis.navigator.audioSession;
  }
}

const models = await gw.init();
console.log(`\nModel Gateway → roleplay: ${models.fast} ／ judge: ${models.judge}`);

// ── 2. 功能一：客戶潛在痛點分析 ────────────────────────────────
if (run(2)) {
  console.log('\n=== 2. 功能一：客戶潛在痛點分析 ===');
  let t0 = t();
  const pp = await AD.painPoints(gw, { gender: '女', age: '約 38 歲', background: '護理師，離婚獨自扶養一個小學的女兒，輪三班' });
  perf.pain = t() - t0;
  ok(pp.points?.length === 3, `產生三個痛點 ${perf.pain}ms`);
  pp.points.forEach((p, i) => {
    ok(!!p.pain && !!p.reason && !!p.need && !!p.question, `  痛點 ${i + 1} 四欄齊全`);
    console.log(`        ${i + 1}. ${p.pain}`);
    console.log(`           探索問題：${p.question}`);
  });
  ok(!!pp.approach?.opening, '有建議接觸方式', pp.approach?.channel);
  const apText = JSON.stringify(pp);
  ok(scrubBrands(apText) === apText, '建議話術未出現任何保險公司名稱');
  console.log(`        建議開場：${pp.approach?.opening}`);
}

// ── 3. 功能三：發掘需求角色扮演（含隱藏需求逐步揭露）──────────
if (run(3)) {
  console.log('\n=== 3. 功能三：發掘需求角色扮演 ===');
  let t0 = t();
  const st = await CE.startSession(gw, {
    mode: 'needs', gender: '男', age: '約 52 歲',
    background: '自己開小型工廠，兩個小孩都在念大學，太太是家庭主婦', difficulty: 2,
  });
  perf.needsStart = t() - t0;
  ok(!!st.sessionId, `建立客戶 ${perf.needsStart}ms`, st.persona.name);
  ok(!!st.demo?.key_question, '有示範探索問題', st.demo?.key_question);

  const demoText = JSON.stringify(st.demo);
  ok(scrubBrands(demoText) === demoText, '示範話術未出現任何保險公司名稱');
  console.log(`        示範開場：${st.demo?.opening}`);

  const s = CE.getSession(st.sessionId);
  const hidden = s.persona.hidden_needs || [];
  ok(hidden.length > 0, `隱藏需求 ${hidden.length} 項（Client 看不到）`);
  CE.beginRoleplay(s);
  console.log(`        客戶：${st.opening}`);

  const probes = [
    '陳大哥，工廠開快二十年了，一路走來應該不容易吧',
    '聽起來您真的扛很多。那兩個小孩都在念大學，這部分您會不會覺得有壓力',
    // 最後一題「故意」問得太直接（直接講出客戶還沒說出口的事）。
    // 這同時驗證兩件事：揭露機制可運作，以及教練會不會抓出這種越界提問。
    `我這樣問可能有點直接——關於「${hidden[0] || '未來的規劃'}」這件事，您心裡是不是其實有點在意？我不是要賣您什麼，只是想聽您說`,
  ];
  const lat = [];
  for (const q of probes) {
    const t1 = t();
    const r = await CE.handleTurn(gw, s, q);
    lat.push(t() - t1);
    console.log(`        業務員：${q}`);
    console.log(`        客戶　：${r.text}　［信任 ${r.trust}／挖到 ${r.revealed}］`);
    ok(!/建議你|話術|演練|評分/.test(r.text), '  未跳出客戶角色');
    if (r.ended) break;
  }
  perf.needsTurn = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);

  // 實際挖到幾項會隨模型與人設浮動，當成觀察值而不是通過條件，避免測試變得不穩
  console.log(`        ［觀察］本次挖出 ${s.revealed.size}／${hidden.length} 項${s.revealed.size ? '：' + [...s.revealed][0] : '（客戶沒鬆口）'}`);
  // 真正要保證的是「編號 → 文字」的映射邏輯正確，這部分不依賴模型，可確定性驗證
  {
    const probe = { persona: { hidden_needs: ['A需求', 'B需求', 'C需求'] }, revealed: new Set() };
    for (const n of [1, 3, 9, 'x']) {
      const i = Number(n) - 1;
      if (probe.persona.hidden_needs[i]) probe.revealed.add(probe.persona.hidden_needs[i]);
    }
    ok(probe.revealed.size === 2 && probe.revealed.has('A需求') && probe.revealed.has('C需求'),
      '隱藏需求編號映射正確（越界與非數字編號會被忽略）');
  }

  t0 = t();
  const fb = await CE.evaluate(gw, s);
  perf.needsEval = t() - t0;
  ok(!!fb.scores && fb.mode === 'needs', `評分完成 ${perf.needsEval}ms`);
  ok(Object.values(fb.scores).every(x => x.score >= 0 && x.score <= 5 && x.score * 2 % 1 === 0), '五項分數皆為 0.5 級距');
  ok(Array.isArray(fb.revealed), `回饋標示挖到 ${fb.revealed.length} 項`);
  console.log(`        總評：${fb.summary}`);
}

// ── 3b. 接觸情境：示範話術不得洩漏業務員不可能知道的資訊 ──────
if (run(3)) {
  console.log('\n=== 3b. 邀約情境 → 示範話術的資訊邊界 ===');
  const { demoLeaksPrivateInfo } = await import('../docs/engine/prompts.js');

  // 先驗規則本身（不呼叫模型）
  const bad = { opening: '林阿姨您好', key_question: '您那筆五百萬的保單放了好幾年了，原來的業務員都沒跟您做過保單健檢嗎？' };
  ok(demoLeaksPrivateInfo(bad, 'cold'), '規則能抓出「五百萬的保單」這類越界話術');
  ok(!demoLeaksPrivateInfo(bad, 'existing'), '既有客戶情境不誤判（本來就知道對方的保單）');
  const good = { opening: '林阿姨您好，我是○○人壽的○○', key_question: '想請教您，平常家裡的事情大多是您在打理嗎？' };
  ok(!demoLeaksPrivateInfo(good, 'cold'), '正常話術不誤判');

  // 再實機驗證兩種情境
  for (const [ctx, note] of [['cold', ''], ['referral', '王大哥介紹的，說他這位同事最近剛升主管']]) {
    const st = await CE.startSession(gw, {
      mode: 'call', gender: '女', age: '約 58 歲',
      background: '退休公務員，先生還在工作，一個女兒已經出社會', difficulty: 2,
      context: ctx, contextNote: note,
    });
    const d = st.demo;
    console.log(`        ［${st.contextLabel}］`);
    console.log(`        開場：${d.opening}`);
    console.log(`        關鍵問題：${d.key_question}`);
    console.log(`        異議處理－客戶：${d.objection_handling?.customer}`);
    console.log(`        異議處理－你　：${d.objection_handling?.you}`);
    ok(!demoLeaksPrivateInfo(d, ctx), `  ${st.contextLabel}：示範話術未越界`);
    ok(scrubBrands(JSON.stringify(d)) === JSON.stringify(d), `  ${st.contextLabel}：未出現保險公司名稱`);
    if (ctx === 'referral') ok(/介紹|王大哥/.test(d.opening), '  轉介紹情境：開場有交代介紹人');
    CE.dropSession(st.sessionId);
  }
}

// ── 4. 文件知識庫 + 功能四：商品行銷演練 ──────────────────────
let productDoc = null;
if (run(4)) {
  console.log('\n=== 4. 功能四：商品教材解析 → 商品行銷演練 ===');
  const pptx = path.join(DIR, '【AiCoach】AI業務教練.pptx');
  if (fs.existsSync(pptx)) {
    let t0 = t();
    const up = await KB.ingest(gw, { name: 'AI業務教練.pptx', kind: 'product', base64: fs.readFileSync(pptx).toString('base64') });
    perf.ingest = t() - t0;
    productDoc = await KB.getDoc(up.id);
    ok(!!up.title, `教材解析完成 ${perf.ingest}ms`, up.title);
    ok(up.digest?.selling_points?.length > 0, `整理出 ${up.digest.selling_points.length} 個 FABE 賣點`);
    ok(Array.isArray(up.digest?.missing), '有標示教材未載明的部分');
    console.log(`        概述：${up.digest.overview}`);

    const brief = KB.productBrief(productDoc);
    ok(brief.length > 50 && brief.length <= 4000, `商品重點摘要 ${brief.length} 字，可塞入 Persona`);

    t0 = t();
    const st = await CE.startSession(gw, {
      mode: 'product', gender: '男', age: '約 45 歲',
      background: '保險公司的區經理，帶 20 人團隊，想找工具幫新人做訓練', difficulty: 3, doc: productDoc,
    });
    perf.prodStart = t() - t0;
    ok(!!st.sessionId, `商品演練客戶建立 ${perf.prodStart}ms`, st.persona.name);
    ok(!!st.product?.title, '演練綁定商品', st.product?.title);

    const s = CE.getSession(st.sessionId);
    CE.beginRoleplay(s);
    console.log(`        客戶：${st.opening}`);
    for (const line of ['經理您好，我想跟您介紹一個可以讓新人自己練習的工具', '它可以讓新人對著手機做電話邀約演練，練完會給五項評分']) {
      const r = await CE.handleTurn(gw, s, line);
      console.log(`        業務員：${line}`);
      console.log(`        客戶　：${r.text}`);
      ok(r.text.length <= 120, '  回覆長度符合限制');
    }
    const fb = await CE.evaluate(gw, s);
    ok(!!fb.scores && fb.mode === 'product', '商品演練評分完成');
    console.log(`        總評：${fb.summary}`);
  } else {
    console.log('  --  找不到範例 PPTX，略過本節');
  }
}

// ── 5. 功能五：理賠諮詢建議 ────────────────────────────────────
if (run(5)) {
  console.log('\n=== 5. 功能五：保單條款解析 → 理賠諮詢 ===');
  const policy = `【範例】住院醫療終身健康保險附約 條款摘錄

第五條 名詞定義
本附約所稱「住院」，係指被保險人經醫師診斷必須入住醫院，且正式辦理住院手續並確實在醫院接受診療者。
本附約所稱「等待期」為本附約生效日起三十日。

第七條 每日病房費用保險金
被保險人於本附約有效期間內因疾病或傷害住院診療者，本公司按其實際住院日數，
乘以保險金額之一倍給付「每日病房費用保險金」。每次住院最高給付日數以三百六十五日為限。

第八條 住院醫療費用保險金
被保險人住院診療者，本公司就其住院期間所發生之醫師指示用藥、血液、掛號費等
必要醫療費用，按實際支出金額給付，每次住院最高以保險金額之一百二十倍為限。

第九條 手術費用保險金
被保險人於住院期間接受外科手術者，本公司依手術名稱及費用表所列給付倍數，
乘以保險金額給付「手術費用保險金」。同一次手術涉及二項以上者，僅給付其中最高一項。

第十條 加護病房費用保險金
被保險人入住加護病房者，除第七條給付外，另按實際入住日數乘以保險金額之二倍給付，
每次住院最高給付日數以三十日為限。

第十二條 除外責任
被保險人因下列原因所致之疾病或傷害而住院者，本公司不負給付責任：
一、被保險人之故意行為（包括自殺及自殺未遂）。
二、被保險人之犯罪行為。
三、被保險人非法施用防制藥品。
四、美容手術、外科整型。但為重建其基本功能所作之必要整型不在此限。
五、外觀可見之天生畸形。
六、健康檢查、療養、靜養、戒毒、戒酒、護理或美容之非必要性醫療行為。

第十四條 告知義務
要保人或被保險人於訂立本附約時，對於本公司要保書書面詢問之告知事項應據實說明。`;

  let t0 = t();
  const up = await KB.ingest(gw, {
    name: '範例住院醫療附約條款.txt', kind: 'policy',
    base64: Buffer.from(policy, 'utf8').toString('base64'),
  });
  perf.policyIngest = t() - t0;
  const doc = await KB.getDoc(up.id);
  ok(!!up.title, `條款解析完成 ${perf.policyIngest}ms`, up.title);
  ok(up.digest?.benefits?.length >= 4, `窮舉出 ${up.digest.benefits?.length} 個給付項目`);
  ok(up.digest?.exclusions?.length >= 4, `列出 ${up.digest.exclusions?.length} 項除外責任`);
  for (const b of (up.digest.benefits || [])) console.log(`        給付・${b.name}：${b.amount}`);

  t0 = t();
  const a1 = await AD.claimAdvice(gw, doc, {
    question: '客戶因為急性闌尾炎開刀住院五天，其中在加護病房待了一天，保額是每日一千元，可以申請什麼？',
    history: [],
  });
  perf.claim = t() - t0;
  ok(a1.likely?.length >= 2, `判斷出 ${a1.likely?.length} 個可申請項目 ${perf.claim}ms`);
  for (const x of a1.likely) console.log(`        可申請・${x.item}（${x.confidence}）：${x.amount}`);
  ok(a1.likely.some(x => /病房|住院日/.test(x.item)), '有抓到每日病房費用');
  ok(a1.likely.some(x => /手術/.test(x.item)), '有抓到手術費用');
  ok(!!a1.disclaimer, '有附上免責聲明');
  ok(a1.grounded, '判斷時有回頭比對條款原文');

  // 條款沒寫的東西不能亂編（Knowledge Grounding，規格 §59）
  const a2 = await AD.claimAdvice(gw, doc, { question: '客戶做了雷射近視手術，這個賠嗎？', history: [] });
  const txt = JSON.stringify(a2);
  ok(/美容|除外|不賠|不負給付|查不到|未載明/.test(txt), '對除外／未載明項目不亂賠');
  console.log(`        近視雷射：${(a2.unlikely?.[0]?.why || a2.likely?.[0]?.why || '').slice(0, 80)}`);

  await KB.deleteDoc(doc.id);
  ok(!await KB.getDoc(doc.id), '測試用條款已刪除');
}

// ── 6. 功能六：行銷諮詢對話 ────────────────────────────────────
if (run(6)) {
  console.log('\n=== 6. 功能六：行銷諮詢對話 ===');
  let t0 = t();
  const c1 = await AD.coachChat(gw, { history: [], message: '客戶說要跟老婆商量看看，結果就已讀不回三個禮拜了，我該怎麼跟進比較好？' });
  perf.chat = t() - t0;
  ok(c1.reply.length > 30, `教練回覆 ${perf.chat}ms`);
  console.log(`        ${c1.reply.slice(0, 220)}…`);

  const c2 = await AD.coachChat(gw, {
    history: [{ role: 'user', text: '客戶說要跟老婆商量' }, { role: 'ai', text: c1.reply }],
    message: '那我直接退一部分佣金給他當作誠意，他應該就會簽了吧？',
  });
  ok(!!c2.compliance, '偵測到退佣違規');
  ok(/退佣|違規|不可|不能|不得/.test(c2.reply), '教練有直接指出違規風險');
  console.log(`        ${c2.reply.slice(0, 200)}…`);
}

// ── 效能 ───────────────────────────────────────────────────────
console.log('\n=== 效能 ===');
for (const [k, v] of Object.entries(perf)) console.log(`  ${k.padEnd(14)} ${v} ms`);

console.log(`\n———— 通過 ${pass}，失敗 ${fail} ————\n`);
process.exitCode = fail ? 1 : 0;   // 不用 process.exit()，避免 Windows 上的 libuv teardown 斷言
