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
export async function claimAdvice(gw, doc, { question, history }) {
  const src = sourceFor(doc, gw);
  const prompt = P.claimPrompt({ digest: doc.digest, source: src.text, question, history });
  const out = await jsonCall(
    gw, prompt, { max: 12000, file: src.file },
    o => Array.isArray(o?.likely) || Array.isArray(o?.need_to_confirm)
  );
  out.likely ||= []; out.unlikely ||= []; out.need_to_confirm ||= []; out.next_steps ||= [];
  out.disclaimer ||= '以上為依條款所做的初步判斷，實際理賠項目與金額以保險公司核定為準。';
  out.grounded = !!(src.text || src.file);   // 是否有回頭引用原文
  return out;
}

// ── 功能六：行銷諮詢對話 ────────────────────────────────────────
export async function coachChat(gw, { history, message }) {
  const c = checkCompliance(message);

  // 中性的多輪格式，由各家 adapter 自行轉換；只留最近 12 則
  const hist = (history || []).slice(-12)
    .filter(m => m?.text)
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));

  const note = c.level === 'high'
    ? `\n\n【系統偵測】業務員的訊息可能涉及違規（${c.hits.map(h => h.type).join('、')}）。請在回覆的第一段就直接指出風險與正確做法，再回答他的問題。`
    : '';

  const r = await gw.generate(message + note, {
    system: P.COACH_CHAT, history: hist, temp: 0.85, max: 4000, tier: 'fast', noThink: true,
  });

  return {
    reply: P.scrubBrands(r.text.trim()),
    compliance: c.level === 'none' ? null : c.hits.map(h => `${h.type}：${h.why}`),
  };
}
