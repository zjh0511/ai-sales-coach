// Model Gateway — 唯一對外的模型介面，支援多家 AI 供應商。
// 每位使用者用自己的金鑰；金鑰只存在使用者瀏覽器與當次請求中，伺服器不落地保存。

// ── 供應商清單（給前端選單用）──────────────────────────────────
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', note: '有免費額度，中文與語音演練實測最佳',
    // 新版 AI Studio 金鑰不一定是 AIza 開頭，別把格式寫死免得誤導
    hint: '從 AI Studio 複製的那一整串', url: 'https://aistudio.google.com/apikey', file: true, verified: true,
  },
  openai: {
    label: 'OpenAI', note: '需付費，品質穩定',
    hint: 'sk-… 開頭', url: 'https://platform.openai.com/api-keys', file: false,
  },
  anthropic: {
    label: 'Anthropic Claude', note: '需付費，長文與回饋品質佳',
    hint: 'sk-ant-… 開頭', url: 'https://console.anthropic.com/settings/keys', file: true,
  },
  groq: {
    label: 'Groq', note: '有免費額度，速度極快',
    hint: 'gsk_… 開頭', url: 'https://console.groq.com/keys', file: false,
  },
  openrouter: {
    label: 'OpenRouter', note: '一把金鑰可用多家模型',
    hint: 'sk-or-… 開頭', url: 'https://openrouter.ai/keys', file: false,
  },
  deepseek: {
    label: 'DeepSeek', note: '價格低廉',
    hint: 'sk-… 開頭', url: 'https://platform.deepseek.com/api_keys', file: false,
  },
};

// OpenAI 相容端點（這幾家的 chat/completions 介面一致）
const OPENAI_COMPAT = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

// 角色扮演要快（fast），評分要準（judge）。依模型名稱特徵挑選，不寫死版本號。
const PICK = {
  gemini: {
    fast: [/^gemini-3\.7-flash$/, /^gemini-3\.6-flash$/, /^gemini-3\.5-flash-lite$/, /flash-lite$/, /flash$/],
    judge: [/^gemini-3\.7-flash$/, /^gemini-3\.6-flash$/, /^gemini-3\.5-flash-lite$/, /pro$/, /flash$/],
  },
  openai: { fast: [/mini/, /^gpt-/], judge: [/^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-/] },
  anthropic: { fast: [/haiku/, /sonnet/], judge: [/sonnet/, /opus/, /haiku/] },
  groq: { fast: [/instant/, /8b/, /scout/, /llama/], judge: [/70b/, /versatile/, /llama/] },
  openrouter: { fast: [/flash/, /mini/, /haiku/], judge: [/sonnet/, /gpt/, /pro/] },
  deepseek: { fast: [/chat/], judge: [/reasoner/, /chat/] },
};

const RETRYABLE = /\b(429|500|502|503|504)\b|empty response|truncated|fetch failed|timed out|TimeoutError|overloaded/i;
const COOLDOWN_MS = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 共用基底：重試、額度冷卻、模型降級 ─────────────────────────
class Base {
  constructor(provider, key) {
    this.provider = provider;
    this.key = key;
    this.fastList = []; this.judgeList = [];
    this.cooldown = new Map();
  }
  get fast() { return this.fastList[0]; }
  get judge() { return this.judgeList[0]; }
  get supportsFile() { return !!PROVIDERS[this.provider]?.file; }

  _rank(models) {
    const p = PICK[this.provider] || { fast: [/./], judge: [/./] };
    const by = pats => {
      const out = [];
      for (const re of pats) for (const m of models) if (re.test(m) && !out.includes(m)) out.push(m);
      return out.length ? out.slice(0, 5) : models.slice(0, 3);
    };
    this.fastList = by(p.fast);
    this.judgeList = by(p.judge);
  }

  async generate(text, opts = {}) {
    const list = opts.tier === 'judge' ? this.judgeList : this.fastList;
    if (!list.length) throw new Error('尚未取得可用模型，請重新登入');

    const now = Date.now();
    const usable = list.filter(m => (this.cooldown.get(m) || 0) < now);
    let last;
    for (const model of (usable.length ? usable : list)) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this._call(model, text, opts);
        } catch (e) {
          last = e;
          if (!RETRYABLE.test(e.message)) throw e;          // 非暫時性錯誤直接拋出
          if (/\b429\b/.test(e.message)) {                   // 額度用盡，重試無意義
            this.cooldown.set(model, Date.now() + COOLDOWN_MS);
            console.warn(`[gateway] ${model} 額度用盡，暫停使用 ${COOLDOWN_MS / 60000} 分鐘`);
            break;
          }
          if (attempt < 2) await sleep(250 * (attempt + 1) ** 2);
          else console.warn(`[gateway] ${model} 失敗（${e.message.slice(0, 100)}），降級到下一個模型`);
        }
      }
    }
    throw last;
  }

  async _fetch(url, init) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(90000) });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 200);
      throw new Error(`${this.provider} ${r.status}: ${scrubKey(body, this.key)}`);
    }
    return r.json();
  }
}

// ── Google Gemini ───────────────────────────────────────────────
const G_HOST = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiAdapter extends Base {
  constructor(key) { super('gemini', key); }

  async init() {
    const j = await this._fetch(`${G_HOST}/models?pageSize=200`, { headers: { 'x-goog-api-key': this.key } });
    const names = (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(m => !/tts|image|embedding|robotics|computer-use|lyria|deep-research/.test(m));
    if (!names.length) throw new Error('這把金鑰沒有可用的模型');
    this._rank(names);
    return { fast: this.fast, judge: this.judge };
  }

  async _call(model, text, opts, retried = false) {
    const t0 = Date.now();
    const parts = opts.file
      ? [{ inlineData: { mimeType: opts.file.mime, data: opts.file.data } }, { text }]
      : [{ text }];
    const cfg = {
      temperature: opts.temp ?? 0.8,
      maxOutputTokens: opts.max ?? 800,
      ...(opts.json ? { responseMimeType: 'application/json' } : {}),
      // Gemini 3.x 用 thinkingLevel，2.5 用 thinkingBudget；不支援時 400 → 剝除重試
      ...(opts.noThink && !retried
        ? { thinkingConfig: /^gemini-[3-9]/.test(model) ? { thinkingLevel: 'low' } : { thinkingBudget: 0 } }
        : {}),
    };
    const body = {
      contents: [
        ...(opts.history || []).map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.text }] })),
        { role: 'user', parts },
      ],
      generationConfig: cfg,
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
        .map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    let j;
    try {
      j = await this._fetch(`${G_HOST}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (!retried && /400/.test(e.message) && cfg.thinkingConfig) return this._call(model, text, opts, true);
      throw e;
    }
    const cand = j.candidates?.[0];
    const out = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!out) throw new Error(`gemini empty response (${cand?.finishReason || 'unknown'})`);
    if (cand?.finishReason === 'MAX_TOKENS') throw new Error('gemini truncated response');
    return { text: out, ms: Date.now() - t0, model };
  }
}

// ── OpenAI 相容（OpenAI / Groq / OpenRouter / DeepSeek）─────────
class OpenAICompatAdapter extends Base {
  constructor(provider, key) { super(provider, key); this.base = OPENAI_COMPAT[provider]; }
  get _headers() { return { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' }; }

  async init() {
    const j = await this._fetch(`${this.base}/models`, { headers: this._headers });
    const names = (j.data || []).map(m => m.id)
      .filter(m => !/embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe/.test(m));
    if (!names.length) throw new Error('這把金鑰沒有可用的模型');
    this._rank(names);
    return { fast: this.fast, judge: this.judge };
  }

  async _call(model, text, opts, altTokenField = false) {
    if (opts.file) throw new Error(`${PROVIDERS[this.provider].label} 不支援直接讀取 PDF`);
    const t0 = Date.now();
    const messages = [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      ...(opts.history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
      { role: 'user', content: text },
    ];
    const body = {
      model, messages,
      temperature: opts.temp ?? 0.8,
      [altTokenField ? 'max_completion_tokens' : 'max_tokens']: opts.max ?? 800,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    };

    let j;
    try {
      j = await this._fetch(`${this.base}/chat/completions`, {
        method: 'POST', headers: this._headers, body: JSON.stringify(body),
      });
    } catch (e) {
      // 新版 OpenAI 模型只接受 max_completion_tokens
      if (!altTokenField && /max_completion_tokens|max_tokens/.test(e.message)) return this._call(model, text, opts, true);
      throw e;
    }
    const out = (j.choices?.[0]?.message?.content || '').trim();
    if (!out) throw new Error(`${this.provider} empty response`);
    if (j.choices?.[0]?.finish_reason === 'length') throw new Error(`${this.provider} truncated response`);
    return { text: out, ms: Date.now() - t0, model };
  }
}

// ── Anthropic Claude ────────────────────────────────────────────
const A_HOST = 'https://api.anthropic.com/v1';

class AnthropicAdapter extends Base {
  constructor(key) { super('anthropic', key); }
  get _headers() {
    return {
      'x-api-key': this.key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // 沒有這個標頭，Anthropic 會擋掉瀏覽器直接呼叫
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }

  async init() {
    const j = await this._fetch(`${A_HOST}/models?limit=100`, { headers: this._headers });
    const names = (j.data || []).map(m => m.id);
    if (!names.length) throw new Error('這把金鑰沒有可用的模型');
    this._rank(names);
    return { fast: this.fast, judge: this.judge };
  }

  async _call(model, text, opts) {
    const t0 = Date.now();
    const content = opts.file
      ? [{ type: 'document', source: { type: 'base64', media_type: opts.file.mime, data: opts.file.data } }, { type: 'text', text }]
      : [{ type: 'text', text }];
    const body = {
      model,
      max_tokens: Math.min(opts.max ?? 800, 16000),
      temperature: opts.temp ?? 0.8,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [
        ...(opts.history || []).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text })),
        { role: 'user', content },
      ],
    };
    const j = await this._fetch(`${A_HOST}/messages`, {
      method: 'POST', headers: this._headers, body: JSON.stringify(body),
    });
    const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!out) throw new Error('anthropic empty response');
    if (j.stop_reason === 'max_tokens') throw new Error('anthropic truncated response');
    return { text: out, ms: Date.now() - t0, model };
  }
}

// ── 工廠 ────────────────────────────────────────────────────────
export function createAdapter(provider, key) {
  if (!PROVIDERS[provider]) throw new Error('不支援的 AI 服務商');
  if (!key || key.length < 12) throw new Error('金鑰格式看起來不正確');
  if (provider === 'gemini') return new GeminiAdapter(key);
  if (provider === 'anthropic') return new AnthropicAdapter(key);
  return new OpenAICompatAdapter(provider, key);
}

// 各家 API 的原始錯誤訊息很難懂，轉成使用者看得懂的說法
export function friendlyError(msg, provider) {
  const m = String(msg || '');
  const name = PROVIDERS[provider]?.label || '這個服務商';
  if (/API key not valid|invalid[_ ]api[_ ]key|invalid x-api-key|incorrect api key|\b401\b|authentication/i.test(m))
    return `金鑰無效。請確認你貼上的是完整的金鑰，而且上方選的服務商是「${name}」。`;
  if (/\b403\b|permission|not authorized|access denied/i.test(m))
    return `這把金鑰沒有使用權限。請到${name}後台確認金鑰狀態，或確認帳號是否已啟用付費。`;
  if (/\b429\b|quota|rate limit|insufficient_quota|credit/i.test(m))
    return `${name}的額度已用盡或觸發流量限制。請稍後再試，或到後台確認方案與餘額。`;
  if (/沒有可用的模型/.test(m))
    return `這把金鑰查不到任何可用的模型，請確認帳號是否已開通。`;
  if (/fetch failed|timed out|ENOTFOUND|ECONNREFUSED/i.test(m))
    return `連不上${name}的伺服器，請確認網路連線後再試一次。`;
  return m;
}

// 錯誤訊息可能夾帶金鑰，回傳給前端前先洗掉
export function scrubKey(s, key) {
  if (!s) return s;
  let out = String(s);
  if (key && key.length > 8) out = out.split(key).join('***');
  return out.replace(/(AIza|sk-ant-|sk-or-|gsk_|sk-)[A-Za-z0-9_\-]{8,}/g, '$1***');
}

// 容錯 JSON 解析：模型偶爾會包 ```json 或前後多字
export function parseJson(text, fallback = null) {
  if (!text) return fallback;
  const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* 繼續嘗試 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* ignore */ } }
  return fallback;
}
