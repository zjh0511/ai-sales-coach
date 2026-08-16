// Model Gateway — 唯一對外的模型介面。
// 目前只有 Gemini adapter；未來要加 Local(Gemma E2B) / 其他雲端模型，
// 只需新增一個具備 same shape 的 adapter，上層 Engine 不需修改。

const HOST = 'https://generativelanguage.googleapis.com/v1beta';

// 角色扮演：即時性 > 理論智商。客戶只講 1～3 句，flash-lite 品質已足夠且延遲約 1.1 秒。
// 順序依 2026-08-16 實測 latency 與額度狀況排定；gemini-3.5-flash 在免費方案被重度限流（26 秒），故墊底。
const PREFER_FAST = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash'];

// 評分／回饋：品質優先，且在背景執行，可容忍較長延遲（Judge Model 與 Roleplay Model 分離）
const PREFER_JUDGE = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-3.5-flash'];

// 速度優先模式：SPEED=1 時角色扮演直接用最快的模型
if (process.env.SPEED === '1') PREFER_FAST.unshift('gemini-3.5-flash-lite');
// 鎖定模型：MODEL=xxx 時全部只用該模型（用於比較不同模型的實際體驗）
const PIN = process.env.MODEL;

export class GeminiAdapter {
  constructor(key) {
    this.key = key;
    this.fastList = [...PREFER_FAST];
    this.judgeList = [...PREFER_JUDGE];
    this.cooldown = new Map();      // model → 冷卻到期時間
    this.ready = false;
  }

  get fast() { return this.fastList[0]; }
  get judge() { return this.judgeList[0]; }

  async init() {
    const r = await fetch(`${HOST}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.key } });
    if (!r.ok) throw new Error(`Gemini models API ${r.status}`);
    const avail = new Set(
      ((await r.json()).models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace('models/', ''))
    );
    const pick = list => { const f = list.filter(m => avail.has(m)); return f.length ? f : [...avail].slice(0, 1); };
    this.fastList = PIN ? [PIN] : pick(PREFER_FAST);
    this.judgeList = PIN ? [PIN] : pick(PREFER_JUDGE);
    this.ready = true;
    return { fast: this.fast, judge: this.judge };
  }

  // opts: { system, temp, max, json, tier:'fast'|'judge', noThink, file, history }
  async generate(userText, opts = {}) {
    const list = opts.tier === 'judge' ? this.judgeList : this.fastList;
    const cfg = {
      temperature: opts.temp ?? 0.8,
      maxOutputTokens: opts.max ?? 800,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
    };
    // opts.file = { mime, data(base64) } → 讓模型直接讀原始 PDF，比自寫解析器可靠
    const parts = opts.file
      ? [{ inlineData: { mimeType: opts.file.mime, data: opts.file.data } }, { text: userText }]
      : [{ text: userText }];
    const body = {
      __noThink: !!opts.noThink,       // 由 _post 依模型世代注入正確的思考參數
      contents: [...(opts.history || []), { role: 'user', parts }],
      generationConfig: cfg,
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
        .map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    // 韌性策略：暫時性錯誤重試 → 仍失敗則降級到下一個模型。
    // 429（額度用盡）不重試，直接降級並冷卻該模型，避免每次呼叫都白等。
    const now = Date.now();
    const usable = list.filter(m => (this.cooldown.get(m) || 0) < now);
    let last;
    for (const model of (usable.length ? usable : list)) {
      const tries = 3;
      for (let attempt = 0; attempt < tries; attempt++) {
        try {
          return await this._post(model, body);
        } catch (e) {
          last = e;
          if (!RETRYABLE.test(e.message)) throw e;       // 非暫時性錯誤，直接拋出
          if (/Gemini 429/.test(e.message)) {            // 額度問題，重試無意義
            this.cooldown.set(model, Date.now() + COOLDOWN_MS);
            console.warn(`[gateway] ${model} 額度用盡，暫停使用 ${COOLDOWN_MS / 60000} 分鐘`);
            break;
          }
          if (attempt < tries - 1) await sleep(250 * (attempt + 1) ** 2);
          else console.warn(`[gateway] ${model} 失敗（${e.message.slice(0, 100)}），降級到下一個模型`);
        }
      }
    }
    throw last;
  }

  async _post(model, body, retried = false) {
    const t0 = Date.now();
    const { __noThink, ...payload } = body;
    if (__noThink && !retried) {
      // Gemini 3.x 用 thinkingLevel，2.5 用 thinkingBudget。不支援時 400 → 剝除重試。
      payload.generationConfig = {
        ...payload.generationConfig,
        thinkingConfig: /^gemini-[3-9]/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 },
      };
    }
    const r = await fetch(`${HOST}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const msg = await r.text();
      // 某些模型不接受 thinkingConfig → 剝除後重試一次
      if (!retried && r.status === 400 && __noThink) return this._post(model, { ...body, __noThink: false }, true);
      throw new Error(`Gemini ${r.status}: ${msg.slice(0, 200)}`);
    }
    const j = await r.json();
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!text) throw new Error(`Gemini empty response (${cand?.finishReason || 'unknown'})`);
    // 被 maxOutputTokens 截斷的 JSON 無法解析，視為可重試錯誤 → 交由上層換模型
    if (cand?.finishReason === 'MAX_TOKENS') throw new Error('Gemini truncated response');
    return { text, ms: Date.now() - t0, model };
  }
}

const RETRYABLE = /Gemini (429|500|502|503|504)|empty response|truncated|fetch failed|timed out|TimeoutError/i;
const COOLDOWN_MS = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 容錯 JSON 解析：模型偶爾會包 ```json 或前後多字
export function parseJson(text, fallback = null) {
  if (!text) return fallback;
  let s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* 繼續嘗試 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* ignore */ } }
  return fallback;
}
