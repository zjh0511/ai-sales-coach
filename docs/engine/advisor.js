// 非角色扮演類功能：痛點分析、理賠諮詢、行銷諮詢對話。
// 這三項都是單次或短對話，不需要 Session 狀態機。

import { parseJson } from './gateway.js';
import { checkCompliance } from './compliance.js';
import * as P from './prompts.js';
import { sourceFor } from './knowledge.js';

// 需要嚴謹 JSON 的任務共用的重試邏輯
async function jsonCall(gw, prompt, opts, valid) {
  let out = null;
  for (let i = 0; i < 3 && !valid(out); i++) {
    const r = await gw.generate(prompt, { json: true, temp: 0.3 + i * 0.2, tier: 'judge', noThink: true, ...opts });
    out = parseJson(r.text);
  }
  if (!valid(out)) throw new Error('analysis_failed');
  return out;
}

// ── 功能一：客戶潛在痛點分析 ────────────────────────────────────
export async function painPoints(gw, { gender, age, background }) {
  const out = await jsonCall(
    gw, P.painPointsPrompt({ gender, age, background }), { max: 6000 },
    o => Array.isArray(o?.points) && o.points.length > 0
  );
  out.points = P.scrubDeep(out.points.slice(0, 3));
  out.approach = P.scrubDeep(out.approach);
  return out;
}

// ── 功能五：理賠諮詢建議 ────────────────────────────────────────
// 流程：客戶的狀況 → 客戶的保單（可多張，各自填保額）→ 分析。
// 每張保單各呼叫一次（帶自己的條款原文），平行進行，最後由程式彙整；
// 再用一次呼叫寫「可以怎麼回覆客戶」。某一張失敗不影響其他張。
export const MAX_POLICIES = 5;

// 金額試算。模型只給計算要素，乘法、上限、加總都在這裡做。
// 任何一個必要數字缺少或不合理，就回 null（畫面改顯示給付方式的文字），不硬算。
const num = v => {
  if (typeof v === 'string') v = v.replace(/[,，\s元]/g, '');
  const n = Number(v);
  return v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};
export function calcAmount(c) {
  if (!c || typeof c !== 'object') return null;
  let v;
  if (c.type === 'reimburse') {
    // 實支實付一定有上限；不知道上限（多半是沒填計劃）就不試算，免得把全部自費當成可賠金額
    const actual = num(c.actual), cap = num(c.cap);
    if (actual == null || cap == null) return null;
    v = Math.min(actual, cap);
  } else {
    const base = num(c.base), cap = num(c.cap);
    // 沒給這個欄位＝沒有倍數／一次性（當 1）；明確寫 null＝要查但查不到（例如手術倍數表沒附）→ 不算。
    // 實測：條款寫「依手術費用表倍數」但沒附表，模型曾自己填 1，算出一個沒有根據的金額。
    const mul = c.multiple === undefined ? 1 : num(c.multiple);
    const qty = c.qty === undefined ? 1 : num(c.qty);
    if (!base || !mul || !qty) return null;
    v = base * mul * qty;
    if (cap != null) v = Math.min(v, cap);
  }
  v = Math.round(v);
  return v > 0 && v < 1e8 ? v : null;
}

// 生效日到發病（事故）日的間隔，由程式算好給模型判斷等待期
export function gapText(start, date) {
  const a = Date.parse(start), b = Date.parse(date);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const d = Math.round((b - a) / 86400000);
  return d < 0
    ? `【系統計算】發病（事故）日早於這張保單的生效日 ${-d} 天，可能屬於投保前就有的狀況。`
    : `【系統計算】這張保單生效後第 ${d} 天發病（事故）。`;
}

const s = v => (typeof v === 'string' ? v.trim().slice(0, 800) : '');

// 業務員填的表單 → 給模型看的狀況描述。只放有填的欄位。
export function caseText({ client = {}, situation = {}, extra = [] }) {
  const who = [s(client.name), s(client.age) && `${s(client.age)}${/歲/.test(client.age) ? '' : ' 歲'}`, s(client.gender)].filter(Boolean).join('，');
  const lines = [];
  if (who) lines.push(`客戶：${who}`);
  if (situation.tags?.length) lines.push(`狀況類別：${situation.tags.map(s).filter(Boolean).join('、')}`);
  if (s(situation.text)) lines.push(`描述：${s(situation.text)}`);
  if (num(situation.days)) lines.push(`住院天數：${num(situation.days)} 天`);
  if (s(situation.surgery)) lines.push(`手術：${s(situation.surgery)}${situation.outpatient === true ? '（門診手術）' : situation.outpatient === false ? '（住院中手術）' : ''}`);
  if (num(situation.selfPay)) lines.push(`自費金額：約 ${num(situation.selfPay).toLocaleString('en-US')} 元`);
  if (s(situation.date)) lines.push(`發病或事故日期：${s(situation.date)}`);
  for (const x of (extra || []).map(s).filter(Boolean)) lines.push(`補充：${x}`);
  return lines.join('\n') || '（業務員沒有提供狀況）';
}

const uniq = (arr, n) => [...new Set(arr.map(s).filter(Boolean))].slice(0, n);

export async function claimCase(gw, { client = {}, situation = {}, extra = [], policies = [] }) {
  if (!policies.length) throw new Error('請先選擇客戶的保單條款');
  const text = caseText({ client, situation, extra });
  if (text === '（業務員沒有提供狀況）') throw new Error('請描述客戶的狀況');
  const list = policies.slice(0, MAX_POLICIES);

  const settled = await Promise.allSettled(list.map(async ({ doc, plan, start }, i) => {
    const src = sourceFor(doc, gw);
    const others = list.filter((_, j) => j !== i).map(p => p.doc.title || p.doc.name).join('、');
    const prompt = P.claimPolicyPrompt({
      digest: doc.digest, source: src.text, caseText: text, title: doc.title || doc.name,
      plan: s(plan), start: s(start), gap: gapText(start, situation.date), others,
    });
    const o = await jsonCall(gw, prompt, { max: 12000, file: src.file, timeout: 90000 },
      o => Array.isArray(o?.likely) || Array.isArray(o?.need_to_confirm));
    const likely = (Array.isArray(o.likely) ? o.likely : []).filter(x => x?.item).map(x => ({
      item: s(x.item), why: s(x.why), source: s(x.source), amount_text: s(x.amount_text),
      confidence: ['high', 'medium', 'low'].includes(x.confidence) ? x.confidence : 'medium',
      amount: calcAmount(x.calc),
    }));
    return {
      docId: doc.id, title: doc.title || doc.name, plan: s(plan), grounded: !!(src.text || src.file),
      likely,
      unlikely: (Array.isArray(o.unlikely) ? o.unlikely : []).filter(x => x?.item).map(x => ({ item: s(x.item), why: s(x.why) })),
      need_to_confirm: uniq(Array.isArray(o.need_to_confirm) ? o.need_to_confirm : [], 6),
      documents: uniq(Array.isArray(o.documents) ? o.documents : [], 8),
    };
  }));

  const results = settled.map((r, i) => r.status === 'fulfilled' ? r.value : {
    docId: list[i].doc.id, title: list[i].doc.title || list[i].doc.name, plan: s(list[i].plan),
    error: true, likely: [], unlikely: [], need_to_confirm: [], documents: [],
  });
  // 全部都失敗才往外拋（讓畫面顯示服務商的錯誤訊息）；部分失敗就把成功的先給使用者
  if (results.every(r => r.error)) throw settled.find(r => r.status === 'rejected').reason;

  // 合計只加「有試算金額、且不是低把握」的項目
  const all = results.flatMap(r => r.likely);
  const counted = all.filter(x => x.amount != null && x.confidence !== 'low');
  const total = counted.reduce((a, x) => a + x.amount, 0);
  const uncounted = all.length - counted.length;
  const need = uniq(results.flatMap(r => r.need_to_confirm), 8);
  const documents = uniq(results.flatMap(r => r.documents), 8);

  // 回覆話術：只給程式整理好的項目與金額
  const summary = results.map(r => {
    if (r.error) return `・${r.title}：這張這次分析失敗，還沒有結果`;
    if (!r.likely.length) return `・${r.title}：依條款判斷不到符合的給付項目`;
    return `・${r.title}：` + r.likely.map(x => `${x.item}（${x.amount != null ? `初步試算約 ${x.amount.toLocaleString('en-US')} 元` : '金額待確認'}${x.confidence === 'low' ? '，不確定' : ''}）`).join('；');
  }).join('\n') + (total ? `\n合計初步試算約 ${total.toLocaleString('en-US')} 元` : '')
    + (documents.length ? `\n要準備的文件：${documents.join('、')}` : '');

  let understanding = '', reply = '';
  try {
    const o = await jsonCall(gw, P.claimReplyPrompt({ caseText: text, name: s(client.name), summary, confirm: need.join('\n') }),
      { max: 3000, tier: 'fast' }, o => typeof o?.reply === 'string' && o.reply.length > 20);
    understanding = s(o.understanding);
    reply = o.reply.trim();
    // 程式層保險絲：一定要有「以保險公司核定為準」的意思
    if (!/核定|審核|為準/.test(reply)) reply += '實際能不能賠、賠多少，還是以保險公司核定為準喔。';
  } catch (e) {
    if (e.auth) throw e;
    console.warn('[claim] 回覆話術產生失敗，其餘結果照常顯示');
  }

  return {
    understanding, reply, total, uncounted, policies: results, need_to_confirm: need, documents,
    disclaimer: '以上為依條款所做的初步判斷，實際理賠項目與金額以保險公司核定為準。',
  };
}

// ── 功能六：行銷諮詢對話 ────────────────────────────────────────
export async function coachChat(gw, { history, message, voice = false }) {
  const c = checkCompliance(message);

  // 中性的多輪格式，由各家 adapter 自行轉換；只留最近 12 則
  const hist = (history || []).slice(-12)
    .filter(m => m?.text)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));

  const note = c.level === 'high'
    ? `\n\n【系統偵測】業務員的訊息可能涉及違規（${c.hits.map(h => h.type).join('、')}）。請在回覆的第一段就直接指出風險與正確做法，再回答他的問題。`
    : '';

  const r = await gw.generate(message + note, {
    system: voice ? `${P.COACH_CHAT}\n\n${P.COACH_VOICE}` : P.COACH_CHAT,
    history: hist, temp: 0.85, max: 4000, tier: 'fast', noThink: true,
  });

  return {
    reply: P.scrubBrands(r.text.trim()),
    compliance: c.level === 'none' ? null : c.hits.map(h => `${h.type}：${h.why}`),
  };
}
