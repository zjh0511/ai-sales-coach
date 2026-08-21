// Coach Engine — 明確的 State Machine，狀態由程式控制，LLM 只負責語言生成。
// INTAKE → READY → ROLEPLAY → COMPLETED → FEEDBACK_READY
// 支援三種角色扮演模式：call（電話邀約）／needs（發掘需求）／product（商品行銷）

import { parseJson } from './gateway.js';
import { checkCompliance, interventionMessage } from './compliance.js';
import { productBrief } from './knowledge.js';
import * as P from './prompts.js';

const MIN_TURNS = 4;         // 演練終點由程式判定，不讓 LLM 在第一回合就結束
const SESSION_TTL = 60 * 60 * 1000;

const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(id);
}, 10 * 60 * 1000).unref?.();

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ── Session 續命 ────────────────────────────────────────────────
// 原本 session 只存在記憶體 Map 裡。手機切到別的 App、Safari 為了省記憶體
// 回收分頁、或使用者不小心重新整理，練到一半的演練就整個消失，
// 只會看到「這次練習的連線已經逾時，請重新開始」。
// 對訓練工具來說，這種挫折足以讓人不想再練——所以改成同步寫進 sessionStorage。
// 用 sessionStorage 而非 localStorage：關掉分頁就該結束，不必留到下次。
const STORE_KEY = 'aicoach.session';
const store = typeof sessionStorage !== 'undefined' ? sessionStorage : null;

// revealed 是 Set，JSON 無法直接表示
const pack = s => JSON.stringify({ ...s, revealed: [...s.revealed] });
const unpack = j => ({ ...j, revealed: new Set(j.revealed || []) });

function persist(s) {
  if (!store) return;
  try { store.setItem(STORE_KEY, pack(s)); } catch { /* 容量滿或隱私模式，忽略 */ }
}

function forget(id) {
  if (!store) return;
  try {
    const j = JSON.parse(store.getItem(STORE_KEY) || 'null');
    if (!j || j.id === id) store.removeItem(STORE_KEY);
  } catch { store.removeItem(STORE_KEY); }
}

export function getSession(id) {
  let s = sessions.get(id);
  if (!s && store) {                       // 分頁被回收後重新載入 → 從儲存體救回來
    try {
      const j = JSON.parse(store.getItem(STORE_KEY) || 'null');
      if (j && j.id === id && Date.now() - j.touched < SESSION_TTL) {
        s = unpack(j);
        sessions.set(id, s);
      }
    } catch { /* 壞掉就當作沒有 */ }
  }
  if (s) s.touched = Date.now();
  return s;
}

// 給 UI 用：有沒有中斷的演練可以接回去？
export function pendingSession() {
  if (!store) return null;
  try {
    const j = JSON.parse(store.getItem(STORE_KEY) || 'null');
    if (!j || Date.now() - j.touched > SESSION_TTL) return null;
    if (j.state !== 'ROLEPLAY') return null;          // 只有演練中被打斷才值得接回
    const turns = (j.history || []).filter(h => h.speaker === 'user').length;
    if (!turns) return null;                          // 一句都還沒說，重新開始更乾淨
    return {
      sessionId: j.id, mode: j.mode, turns,
      name: j.persona?.name, summary: j.persona?.public_summary,
      voice: j.persona?.voice_hint || { rate: 1, pitch: 1 },
      difficultyLabel: P.difficultyOf(j.difficulty).label,
      transcript: (j.history || []).map(h => ({ speaker: h.speaker, text: h.text })),
    };
  } catch { return null; }
}

// ── 建立 Session：Persona + Scenario + Demo ─────────────────────
// 預設「新手友善」：訓練工具若一開始就打擊信心，就失去存在意義
export async function startSession(gw, { mode = 'call', gender, age, background, difficulty = 1, doc = null, context = 'cold', contextNote = '' }) {
  if (!P.MODES[mode]) throw new Error('unknown_mode');
  difficulty = Math.min(5, Math.max(1, Number(difficulty) || 1));
  if (!P.CONTEXTS[context]) context = 'cold';
  const brief = doc ? productBrief(doc) : null;
  const base = P.personaPrompt({ gender, age, background, difficulty, mode, product: brief, context, contextNote });

  // 示範話術若洩漏了業務員不可能知道的客戶私人資訊，重新產生一次（規格 §68 Output Validation）
  // 重試三次：實測遇過連續兩次都在「異議處理」段落越界的情況
  let p = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const extra = attempt === 0 ? '' :
      '\n\n【重要】上一次你產生的示範話術，講出了業務員在這個接觸情境下不可能知道的客戶私人資訊'
      + '（例如保額、保單、繳費金額）。請重新設計，示範話術只能從業務員已知的資訊與一般生活情境出發。';
    const r = await gw.generate(base + extra, {
      // max 需涵蓋思考 token（Gemini 3.x 的 thinking 計入 maxOutputTokens）
      // 建立客戶要產生一大段 JSON，比單回合對話慢得多，逾時要放寬
      json: true, temp: attempt === 0 ? 1.0 : 0.7, max: 4000, tier: 'fast', noThink: true, timeout: 60000,
    });
    p = parseJson(r.text);
    if (!p?.opening_line) continue;
    if (!P.demoLeaksPrivateInfo(p.demo, context)) break;
    console.warn(`[persona] 示範話術洩漏私人資訊（${context}），重新產生`);
  }
  if (!p || !p.opening_line) throw new Error('persona_generation_failed');

  // 人設欄位不該出現「因為難度設定為…」這類後設用語
  p.personality = P.scrubMeta(p.personality);
  p.communication_style = P.scrubMeta(p.communication_style);

  const persona = { ...p, gender, age, background, difficulty, productBrief: brief, contextNote };
  const D = P.difficultyOf(difficulty);
  // 初始信任度由程式夾在難度區間內。模型常給出偏低的值，
  // 新手友善級卻開場就 trust=15 的話，客戶會冷淡到沒辦法練習。
  const trust = Math.min(D.trust[1], Math.max(D.trust[0], Number(p.trust) || D.trust[0]));

  const id = newId();
  sessions.set(id, {
    id, mode, context, state: 'READY', persona,
    docId: doc?.id || null, productBrief: brief,
    difficulty, maxGuidance: D.guidance, canEnd: D.canEnd,
    trust,
    history: [], violations: [], revealed: new Set(),
    guidance: 0, stuck: 0, startedAt: null, touched: Date.now(), lastUser: '', latency: [],
  });
  persist(sessions.get(id));

  return {
    sessionId: id, mode, context, contextLabel: P.CONTEXTS[context].label,
    persona: {                       // 只回傳 Public State，隱藏需求不下發到 Client
      name: p.name, summary: p.public_summary,
      voice: p.voice_hint || { rate: 1, pitch: 1 },
      difficulty, difficultyLabel: D.label,
    },
    scenario: p.scenario,
    demo: P.scrubDeep(p.demo),        // 示範話術不預設任何保險公司
    opening: p.opening_line,
    product: doc ? { id: doc.id, title: doc.title } : null,
  };
}

export function beginRoleplay(s) {
  if (s.state === 'READY') {
    s.state = 'ROLEPLAY';
    s.startedAt = Date.now();
    s.history.push({ speaker: 'customer', text: s.persona.opening_line, at: Date.now() });
    persist(s);
  }
  return { opening: s.persona.opening_line };
}

// ── 卡住偵測（產品規格 §29）───────────────────────────────────
function isStuck(text, last) {
  const t = (text || '').trim();
  if (t.length < 4) return true;
  if (t === last) return true;
  return /^(嗯+|呃+|那個|欸|我不知道|不知道要說什麼|怎麼說)$/.test(t);
}

// ── 一個回合 ────────────────────────────────────────────────────
export async function handleTurn(gw, s, userText) {
  if (s.state !== 'ROLEPLAY') throw new Error('not_in_roleplay');
  const text = (userText || '').trim();
  s.history.push({ speaker: 'user', text, at: Date.now() });

  // 1) Compliance 先行（Voice/Coach 都不得繞過）
  const c = checkCompliance(text);
  if (c.hits.length) for (const h of c.hits) s.violations.push({ ...h, quote: text.slice(0, 60) });
  if (c.level === 'high') {
    const msg = interventionMessage(c.hits);
    s.history.push({ speaker: 'system', text: msg, at: Date.now() });
    persist(s);
    return { type: 'compliance', text: msg, ended: false, trust: s.trust };
  }

  // 2) 卡住 → 引導層級
  if (isStuck(text, s.lastUser)) s.guidance += 1; else s.guidance = 0;
  s.stuck = Math.max(s.stuck, s.guidance);
  s.lastUser = text;

  // 3) 角色扮演生成（含輸出驗證，最多重試一次）
  const sys = P.roleplaySystem(s.persona, s.mode, s.context);
  const turn = P.roleplayTurn({
    history: s.history.filter(h => h.speaker !== 'system').slice(-12),
    userText: text, trust: s.trust, guidance: s.guidance,
    difficulty: s.difficulty, maxGuidance: s.maxGuidance, canEnd: s.canEnd,
  });

  let say = null, data = null, ms = 0;
  for (let attempt = 0; attempt < 2 && !say; attempt++) {
    const r = await gw.generate(attempt === 0 ? turn : turn + '\n\n【重要】上一次你跳出了角色。請只用客戶本人的口吻回答。', {
      system: sys, json: true, temp: attempt === 0 ? 0.9 : 0.6, max: 1200, tier: 'fast', noThink: true,
    });
    ms += r.ms;
    data = parseJson(r.text) || {};
    say = P.validateRoleplay(data.say);
  }
  if (!say) {
    say = (s.canEnd && s.guidance >= s.maxGuidance)
      ? '不好意思，我現在真的有點忙，可能沒辦法聊，先這樣好嗎？'
      : '嗯……你的意思是？';
  }

  // 4) 狀態更新（由程式控制，不交給 LLM）
  const delta = Math.max(-15, Math.min(15, Number(data.trust_delta) || 0));
  s.trust = Math.max(0, Math.min(100, s.trust + delta));
  // revealed 是 1-based 編號，映射回實際的隱藏需求文字
  const hidden = s.persona.hidden_needs || [];
  for (const n of (Array.isArray(data.revealed) ? data.revealed : [])) {
    const i = Number(n) - 1;
    if (hidden[i]) s.revealed.add(hidden[i]);
  }
  s.latency.push(ms);
  s.history.push({ speaker: 'customer', text: say, at: Date.now() });

  // 結束條件由程式判定（規格 §19、§92）：LLM 只提供訊號，不能自己決定演練終點。
  // 新手友善級（canEnd=false）客戶不會主動結束，使用者卡住也不會被掛電話。
  const userTurns = s.history.filter(h => h.speaker === 'user').length;
  const ended = s.canEnd
    && (s.guidance >= s.maxGuidance || (data.end === true && userTurns >= MIN_TURNS));
  if (ended) s.state = 'COMPLETED';
  if (ended) forget(s.id); else persist(s);

  return {
    type: 'customer', text: say, ended, trust: s.trust,
    revealed: s.revealed.size, totalHidden: (s.persona.hidden_needs || []).length,
    warn: c.level === 'warn' ? c.hits.map(h => `${h.type}：${h.why}`) : null,
    ms,
  };
}

// ── 結束 → 評分與回饋 ──────────────────────────────────────────
const FILLER = /嗯|呃|那個|就是說|然後|欸/g;

export async function evaluate(gw, s) {
  s.state = 'EVALUATING';
  const userTurns = s.history.filter(h => h.speaker === 'user');
  const texts = userTurns.map(t => t.text);
  const metrics = {
    turns: userTurns.length,
    avgLen: userTurns.length ? Math.round(texts.join('').length / userTurns.length) : 0,
    fillers: texts.join('').match(FILLER)?.length || 0,
    repeats: texts.length - new Set(texts).size,
    stuck: s.stuck,
    finalTrust: s.trust,
    durationSec: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    revealed: [...s.revealed],
  };

  const prompt = P.evaluationPrompt({
    persona: s.persona,
    transcript: s.history.filter(h => h.speaker !== 'system'),
    metrics, violations: s.violations, mode: s.mode, product: s.productBrief, context: s.context,
  });

  // 評分是使用者最在意的產出，解析失敗要重試（不同溫度會改變輸出結構）
  let fb = null;
  for (let attempt = 0; attempt < 3 && !fb?.scores; attempt++) {
    const r = await gw.generate(prompt, {
      json: true, temp: 0.3 + attempt * 0.2, max: 8000, tier: 'judge', noThink: true,
    });
    fb = parseJson(r.text);
    if (!fb?.scores) console.warn(`[evaluate] 第 ${attempt + 1} 次解析失敗（${r.model}, ${r.text.length} 字）: ${r.text.slice(0, 160)}`);
  }
  if (!fb?.scores) throw new Error('evaluation_failed');

  // 分數規範化到 0～5、0.5 級距
  for (const k of Object.keys(fb.scores)) {
    const v = Number(fb.scores[k]?.score) || 0;
    fb.scores[k].score = Math.max(0, Math.min(5, Math.round(v * 2) / 2));
  }

  // 教練自己寫的示範話術要中立化；逐字稿與評分證據是原始紀錄，保持原樣
  fb.example_script = P.scrubBrands(fb.example_script);
  fb.improvements = P.scrubDeep(fb.improvements);
  fb.next_challenge = P.scrubBrands(fb.next_challenge);

  s.state = 'FEEDBACK_READY';
  return {
    ...fb, metrics, mode: s.mode,
    modeName: P.MODES[s.mode].name,
    contextLabel: P.CONTEXTS[s.context]?.label,
    persona: { name: s.persona.name, summary: s.persona.public_summary },
    scenario: s.persona.scenario,
    transcript: s.history.filter(h => h.speaker !== 'system').map(h => ({ speaker: h.speaker, text: h.text })),
    hidden_needs: s.persona.hidden_needs,     // 演練結束後才揭露
    revealed: [...s.revealed],
    avgLatencyMs: s.latency.length ? Math.round(s.latency.reduce((a, b) => a + b, 0) / s.latency.length) : 0,
  };
}

export function dropSession(id) { sessions.delete(id); forget(id); }
export const sessionCount = () => sessions.size;
