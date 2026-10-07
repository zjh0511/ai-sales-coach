// Model Gateway — 唯一對外的模型介面，支援多家 AI 供應商。
// 每位使用者用自己的金鑰；金鑰只存在使用者瀏覽器與當次請求中，伺服器不落地保存。

import { toTW } from './zhtw.js';

// ── 供應商清單（給前端選單用）──────────────────────────────────
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', note: '有免費額度，中文與語音演練實測最佳',
    // 新版 AI Studio 金鑰不一定是 AIza 開頭，別把格式寫死免得誤導
    hint: '從 AI Studio 複製的那一整串', file: true, verified: true,
    // 先經過 Google 的「選擇帳戶」再到金鑰頁。直接開 AI Studio 會默默用瀏覽器預設的 Google 帳號——
    // 手機登入好幾個 Google 帳號時，換人登入 App 後申請到的仍是第一個帳號的金鑰（使用者 2026-10-07 實測回報）。
    url: 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent('https://aistudio.google.com/apikey'),
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
    // 2026-08-21 實測：Qwen 3.8-27B 每回合 0.66～0.77 秒，比 Gemini 還快。
    // 但免費額度是「每分鐘 8000 tokens」，而且每個模型各自計算——
    // 建立客戶與評分容易撞到，會自動降到 3.6 再回來，那是正常行為。
    label: 'Groq', note: '預設 Qwen 27B，對練速度最快；免費額度較緊',
    hint: 'gsk_… 開頭', url: 'https://console.groq.com/keys', file: false, verified: true,
  },
  openrouter: {
    label: 'OpenRouter', note: '一把金鑰可用多家模型，支援一鍵登入',
    hint: 'sk-or-… 開頭', url: 'https://openrouter.ai/keys', file: false, verified: true, oauth: true,
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

// Gemini 3 以後（含未來的 4.x、10.x）的正式版 flash／flash-lite
const GEM_LITE = /^gemini-(?:[3-9]|\d{2,})(?:\.\d+)?-flash-lite$/;
const GEM_FLASH = /^gemini-(?:[3-9]|\d{2,})(?:\.\d+)?-flash$/;

// 角色扮演要快（fast），評分要準（judge）。依模型名稱特徵挑選，不寫死版本號。
const PICK = {
  // Gemini 一律預設 3.5-flash-lite（使用者指定：登入後預設使用它）。也與實測一致：
  // 免費額度下 gemini-3.5-flash 被限流到 26.5 秒，flash-lite 是 1.1 秒。
  // 評分原本優先用較大的 3.7-flash（D029），現在也改成 flash-lite；
  // 較大的模型退到備援順位，flash-lite 額度用完時才會用到。
  //
  // 萬用比對只收 Gemini 3 以後的版本。Google 的 /models 清單會照樣列出
  // 已經「不開放給新使用者」的舊模型（2026-09-29 實測 gemini-2.5-flash-lite 回 404），
  // 名稱上看不出來。原本的 /flash-lite$/ 會把它排在健康的 3.7-flash 前面，
  // 3.5-flash-lite 一塞車，備援就掉進這個死模型。
  // -preview 與 -latest 別名也不收：前者不穩定，後者指向哪個版本不確定。
  gemini: {
    fast: [/^gemini-3\.5-flash-lite$/, GEM_LITE, /^gemini-3\.7-flash$/, /^gemini-3\.6-flash$/, GEM_FLASH],
    judge: [/^gemini-3\.5-flash-lite$/, GEM_LITE, /^gemini-3\.7-flash$/, /^gemini-3\.6-flash$/, GEM_FLASH, /pro$/],
  },
  openai: { fast: [/mini/, /^gpt-/], judge: [/^gpt-5/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-/] },
  anthropic: { fast: [/haiku/, /sonnet/], judge: [/sonnet/, /opus/, /haiku/] },
  // Groq 預設用 Qwen 27B（使用者指定）。
  // 2026-08-21 實測：Groq 同時提供 qwen/qwen3.6-27b 與 qwen/qwen3.8-27b。
  // 官方文件那頁只列到 3.6，是過期的——只有真的打 /models 才問得出來。
  // 用比對模式而不是寫死 ID：命中多個時 _rank 會選版本較新的，所以現在用 3.8；
  groq: {
    fast: [/^qwen\/qwen[\d.]*-?27b$/i, /qwen.*27b/i, /qwen/i, /instant/, /8b/, /scout/, /llama/],
    judge: [/^qwen\/qwen[\d.]*-?27b$/i, /qwen.*27b/i, /qwen/i, /70b/, /versatile/, /llama/],
  },
  // OpenRouter 有 400 多個模型，預設挑中文表現好且延遲低的；:free 模型實測中文品質差，不列入自動
  openrouter: {
    fast: [/^google\/gemini-[\d.]+-flash$/, /^anthropic\/claude-[\w.-]*-fast$/,
      /^qwen\/qwen[\d.]+-flash$/, /^openai\/gpt-[\d.]+-mini$/, /flash$/, /mini$/],
    judge: [/^anthropic\/claude-opus-[\d.]+$/, /^google\/gemini-[\d.]+-pro$/,
      /^openai\/gpt-[\d.]+$/, /sonnet$/, /^google\/gemini-[\d.]+-flash$/],
  },
  deepseek: { fast: [/chat/], judge: [/reasoner/, /chat/] },
};

// 免費模型的備援優先順序。依 2026-08-17 實測排序：
//   gemma-4-26b:free  6.9 秒、JSON 正確、繁體中文正常  ← 目前唯一實測可用的
//   dots-3-note:free  5.7 秒、JSON 正確，但回簡體中文
//   nemotron:free     3.9 秒，但輸出思考過程而非 JSON
//   lfm-2.5-2.6b:free 46 秒、中文夾雜其他語言 → 排到最後
// 只實測過其中幾個，未測過的排中間，明顯過小的模型排後面。
const FREE_GOOD = [/gemma-4-26b/, /gemma-4-31b/, /gemma-4/, /gpt-oss/, /qwen/, /llama/, /mistral/];
const FREE_BAD = [/lfm|[^\d]2\.\d?b|[^\d]1\.\d?b|-xs-|xs-\d|mini-code|tiny|nano/i];

const freeScore = id => {
  if (FREE_BAD.some(re => re.test(id))) return 90;
  const i = FREE_GOOD.findIndex(re => re.test(id));
  return i < 0 ? 50 : i;
};

const RETRYABLE = /\b(429|500|502|503|504)\b|empty response|truncated|fetch failed|timed out|TimeoutError|overloaded/i;
const COOLDOWN_MS = 10 * 60 * 1000;
// 免費模型的上游流量池通常幾十秒就會空出來，不必冷卻十分鐘
const UPSTREAM_COOLDOWN_MS = 60 * 1000;
// 模型對這把金鑰不存在（404）：這種狀態不會自己好，整個頁面期間都別再試
const GONE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 共用基底：重試、額度冷卻、模型降級 ─────────────────────────
class Base {
  constructor(provider, key) {
    this.provider = provider;
    this.key = key;
    this.all = [];                       // 這把金鑰可用的全部模型 [{id,label}]
    this.autoFast = []; this.autoJudge = [];
    this.fastList = []; this.judgeList = [];
    this.pinned = null;                  // 使用者指定的單一模型；null = 自動
    this.cooldown = new Map();
    this.noCreditsUntil = 0;             // 遇到 402 後暫時跳過付費模型
    this.onEvent = null;                 // 降階／額度用盡時通知 UI
  }
  get fast() { return this.fastList[0]; }
  get judge() { return this.judgeList[0]; }
  get supportsFile() { return !!PROVIDERS[this.provider]?.file; }

  _rank(models) {
    this.all = models.map(m => (typeof m === 'string' ? { id: m, label: m } : m))
      .map(m => ({ ...m, free: !!m.free }));
    const ids = this.all.map(m => m.id);
    const p = PICK[this.provider] || { fast: [/./], judge: [/./] };
    // 同一個模式命中多個模型時，選版本較新的。
    // 不這樣做的話是「服務商清單裡誰先出現誰贏」——那是任意的，
    // 而且會在服務商上架新版時默默繼續用舊的（例如 qwen3.6-27b 與 qwen3.8-27b
    // 都符合同一個模式，就會一直停在 3.6）。
    // 寫死完整 ID 的模式只會命中一個，不受影響——那些是實測結論，不該被動到。
    const ver = id => (id.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const newer = (a, b) => {
      const x = ver(a), y = ver(b);
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (y[i] || 0) - (x[i] || 0);
        if (d) return d;
      }
      return 0;                                  // 版本相同 → 維持服務商的原順序
    };
    const by = pats => {
      const out = [];
      for (const re of pats) {
        for (const m of ids.filter(m => re.test(m)).sort(newer)) if (!out.includes(m)) out.push(m);
      }
      return out.length ? out.slice(0, 5) : ids.slice(0, 3);
    };
    this.autoFast = by(p.fast);
    this.autoJudge = by(p.judge);
    this._apply();
  }

  // 指定模型後，該模型排第一；其餘仍作為額度用盡時的降階順位。
  // 自動模式下，角色扮演與評分仍各自挑最適合的（快 vs 準），使用者不必知道這層細節。
  _apply() {
    const ids = this.all.map(m => m.id);
    // 免費模型品質落差極大，備援時依實測結果排序，別掉到會卡 46 秒的那種
    const freeIds = this.all.filter(m => m.free).map(m => m.id)
      .sort((a, b) => freeScore(a) - freeScore(b) || a.localeCompare(b));
    const pinnedIsFree = this.pinned && freeIds.includes(this.pinned);

    // 指定免費模型時，備援也優先挑免費的。
    // 否則免費模型被上游限流後會掉到付費模型，再回報「餘額不足」——使用者明明選了免費的。
    const chain = auto => {
      const rest = pinnedIsFree ? [...freeIds, ...auto, ...ids] : [...auto, ...ids];
      return [...new Set([this.pinned, ...rest].filter(Boolean))].slice(0, 6);
    };
    this.fastList = chain(this.autoFast);
    this.judgeList = chain(this.autoJudge);
  }

  _isFree(id) { return !!this.all.find(m => m.id === id)?.free; }
  _meta(id) { return this.all.find(m => m.id === id) || {}; }

  pin(model) {
    this.pinned = this.all.some(m => m.id === model) ? model : null;
    this._apply();
    return this.status();
  }

  // 給 UI 顯示：目前用哪個、指定了哪個、哪些正在冷卻
  status() {
    const now = Date.now();
    const cooling = [...this.cooldown.entries()]
      .filter(([, t]) => t > now)
      .map(([id, t]) => ({ id, minutes: Math.ceil((t - now) / 60000) }));
    const live = list => list.find(m => (this.cooldown.get(m) || 0) < now) || list[0];
    return {
      provider: this.provider,
      models: this.all,
      recommended: [...new Set([...this.autoFast, ...this.autoJudge])],
      pinned: this.pinned,
      auto: { fast: this.autoFast[0], judge: this.autoJudge[0] },
      active: { fast: live(this.fastList), judge: live(this.judgeList) },
      cooling,
    };
  }

  async generate(text, opts = {}) {
    const judge = opts.tier === 'judge';
    const list = judge ? this.judgeList : this.fastList;
    if (!list.length) throw new Error('尚未取得可用模型，請重新登入');

    // 單次呼叫的逾時，以及整個 generate() 的總時限。
    // 兩個都要有：某些免費模型不會回 429 而是直接掛住，只設單次逾時的話
    // 「單次 × 重試 × 模型數」會累積成好幾分鐘，使用者只會覺得「卡住了」。
    opts = { timeout: judge ? 45000 : 25000, ...opts };
    // 呼叫端若刻意給了較長的逾時（例如解析文件），總時限也要跟著放寬
    const deadline = Date.now() + Math.max(judge ? 100000 : 50000, opts.timeout * 2);

    const now = Date.now();
    let chain = list.filter(m => (this.cooldown.get(m) || 0) < now);
    if (!chain.length) chain = list;
    // 已知帳戶沒餘額 → 別再一個個試付費模型，直接只走免費的
    if (this.noCreditsUntil > now && chain.some(m => this._isFree(m))) {
      chain = chain.filter(m => this._isFree(m));
    }

    // busy：有模型是因為「塞車」而放棄的。全部失敗時優先回報它——
    // 備援鏈尾端常是已下架的模型（404），若回報最後一個錯誤，
    // 使用者看到的會是一個跟真正原因無關的訊息。
    let last, busy = null;
    for (const model of chain) {
      if (Date.now() > deadline) break;                    // 總時限到了就不再試下一個模型
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // 簡體字的最後一道防線。提示詞層已經明寫「不使用簡體字」，
          // 但實測 qwen/qwen3.8-27b 照樣寫出「打扰」「班级里」——
          // 擋在這裡，六大功能一次涵蓋（演練回覆、人設、示範話術、評分、教練對話）。
          const r = await this._call(model, text, opts);
          // _call 回傳的是 { text, ms, model } 物件，要轉的是裡面的 text。
          // （第一版寫成 toTW(await this._call(...))，型別不符就整包原樣回傳，
          //   轉換靜默失效——這種錯不會拋例外，只會讓簡體字繼續出現。）
          if (typeof r?.text === 'string') r.text = toTW(r.text);
          // 不是第一順位卻成功 → 告訴使用者現在正在用備援模型
          if (model !== list[0]) this.onEvent?.({ type: 'fallback', from: list[0], to: model });
          return r;
        } catch (e) {
          last = e;
          // 402：帳戶沒餘額。記下來，之後只試免費模型
          if (/\b402\b/.test(e.message)) {
            this.noCreditsUntil = Date.now() + COOLDOWN_MS;
            if (chain.some(m => this._isFree(m) && m !== model)) break;   // 還有免費的可試
            throw e;
          }
          // 404：這把金鑰用不了「這個模型」（例如「已不開放給新使用者」）。
          // 是模型的問題、不是這次請求的問題——跳過它繼續試下一個。
          // 原本這裡會直接拋出，整條備援鏈在健康的模型之前就中止了。
          if (/\b404\b/.test(e.message)) {
            this.cooldown.set(model, Date.now() + GONE_COOLDOWN_MS);
            console.warn(`[gateway] ${model} 這把金鑰無法使用（404），略過`);
            break;
          }
          if (!RETRYABLE.test(e.message)) throw e;          // 非暫時性錯誤直接拋出

          // 503「需求量過高」：Google 那邊塞車。重試一次就好——
          // 同一個模型再撞通常還是塞，早點換下一個比較快；
          // 短暫冷卻，下一回合就直接用別的模型，不必每回合都先撞一次。
          if (/\b503\b/.test(e.message) && /high demand|overloaded|UNAVAILABLE/i.test(e.message) && attempt >= 1) {
            busy = e;
            this.cooldown.set(model, Date.now() + UPSTREAM_COOLDOWN_MS);
            this.onEvent?.({ type: 'busy', model, minutes: UPSTREAM_COOLDOWN_MS / 60000 });
            console.warn(`[gateway] ${model} 需求量過高，暫時改用下一個模型`);
            break;
          }

          // 逾時代表這個模型現在很慢或掛住，重試同一個沒有意義，直接換下一個
          if (/timed out|TimeoutError|aborted/i.test(e.message)) {
            this.cooldown.set(model, Date.now() + UPSTREAM_COOLDOWN_MS);
            this.onEvent?.({ type: 'slow', model });
            console.warn(`[gateway] ${model} 逾時無回應，換下一個模型`);
            break;
          }

          if (/\b429\b/.test(e.message)) {                   // 限流／額度，重試無意義
            const upstream = /rate.?limited upstream|temporarily rate.?limited/i.test(e.message);
            this.cooldown.set(model, Date.now() + (upstream ? UPSTREAM_COOLDOWN_MS : COOLDOWN_MS));
            this.onEvent?.({
              type: upstream ? 'busy' : 'quota', model,
              minutes: (upstream ? UPSTREAM_COOLDOWN_MS : COOLDOWN_MS) / 60000,
            });
            console.warn(`[gateway] ${model} ${upstream ? '上游限流' : '額度用盡'}，暫停使用`);
            break;
          }
          if (attempt < 2) await sleep(250 * (attempt + 1) ** 2);
          else console.warn(`[gateway] ${model} 失敗（${e.message.slice(0, 100)}），降級到下一個模型`);
        }
      }
    }
    throw busy || last;
  }

  async _fetch(url, init, timeout = 90000) {
    let r;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      // 在源頭把各種底層錯誤正規化成固定字樣，上層才不必猜瀏覽器／Node 的措辭。
      // 例：AbortSignal.timeout 的訊息是「aborted due to timeout」，不含「timed out」。
      if (e.name === 'TimeoutError' || /abort/i.test(e.message || '')) {
        throw new Error(`${this.provider} timed out after ${timeout}ms`);
      }
      throw new Error(`${this.provider} fetch failed: ${e.message}`);
    }
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
      .map(m => ({ id: m.name.replace('models/', ''), label: m.displayName || m.name.replace('models/', '') }))
      .filter(m => !/tts|image|embedding|robotics|computer-use|lyria|deep-research/.test(m.id));
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
    // OpenRouter 的 /models 是公開端點，假金鑰也拿得到清單。
    // 必須另外打一個需要驗證的端點，否則「登入時驗證金鑰」形同虛設。
    if (this.provider === 'openrouter') {
      await this._fetch(`${this.base}/key`, { headers: this._headers }, 20000);
    }
    const j = await this._fetch(`${this.base}/models`, { headers: this._headers });
    const names = (j.data || [])
      .map(m => ({
        id: m.id,
        label: m.name || m.id,
        // 以服務商回報的實際價格判定免費，比只看名稱可靠
        free: /:free$/.test(m.id)
          || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0),
        // 有些模型不支援 response_format，硬送會 400；上限也各不相同
        json: !m.supported_parameters || m.supported_parameters.includes('response_format'),
        maxOut: m.top_provider?.max_completion_tokens || null,
        // 只保留「純文字輸出」的模型。依名稱過濾會漏——例如 google/lyria 是音樂生成，
        // 但輸出模態是 ["text","audio"]，名稱裡完全看不出來。
        //
        // 欄位位置各家不同：OpenRouter 放在 architecture 底下，Groq 放在最上層。
        // 原本只讀 architecture，等於這個過濾對 Groq 完全沒作用
        // （canopylabs/orpheus 是語音合成，output_modalities 是 ["speech"]，就這樣混進清單）。
        textOnly: (() => {
          const a = m.architecture || m;
          const o = a.output_modalities;
          if (Array.isArray(o)) return o.length === 1 && o[0] === 'text';
          return true;                       // 沒回報就不排除，寧可多列也不要少列
        })(),
        // 輸入不要求「只有文字」——qwen3.8-27b 是 ["text","image"]，那是加分不是問題
        textIn: (() => {
          const a = m.architecture || m;
          const i = a.input_modalities;
          return !Array.isArray(i) || i.includes('text');
        })(),
        // 上下文太小的模型不是「比較弱」，是根本裝不下我們的提示詞。
        // 實例：Groq 的 meta-llama/llama-prompt-guard-2-86m 是提示詞注入偵測用的
        // 分類器，context_window 只有 512——名稱、模態都看不出它不能對話。
        ctx: m.context_length || m.context_window || m.top_provider?.context_length || null,
      }))
      .filter(m => m.textOnly && m.textIn)
      .filter(m => !m.ctx || m.ctx >= 8192)
      // :batch 是非同步批次介面，不能用在即時對話
      .filter(m => !/embed|whisper|tts|dall-e|moderation|realtime|transcribe|:batch/.test(m.id));
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
    const meta = this._meta(model);
    const cap = meta.maxOut ? Math.min(opts.max ?? 800, meta.maxOut) : (opts.max ?? 800);
    const body = {
      model, messages,
      temperature: opts.temp ?? 0.8,
      [altTokenField ? 'max_completion_tokens' : 'max_tokens']: cap,
      // 模型不支援 response_format 就別送（硬送會 400）；提示詞本身已要求只輸出 JSON
      ...(opts.json && meta.json !== false ? { response_format: { type: 'json_object' } } : {}),
    };

    let j;
    try {
      j = await this._fetch(`${this.base}/chat/completions`, {
        method: 'POST', headers: this._headers, body: JSON.stringify(body),
      }, opts.timeout);
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
    const names = (j.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));
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
    }, opts.timeout);
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

// 各家 API 的原始錯誤訊息很難懂，轉成使用者看得懂的說法。
// 認不出來就回 null，讓呼叫端決定要不要顯示原文——用白名單比對訊息內容太容易漏。
export function friendlyError(msg, provider) {
  const m = String(msg || '');
  const name = PROVIDERS[provider]?.label || '這個服務商';
  if (/API key not valid|invalid[_ ]api[_ ]key|invalid x-api-key|incorrect api key|\b401\b|authentication/i.test(m))
    return `金鑰無效。請確認你貼上的是完整的 ${name} 金鑰（從 AI Studio 複製的那一整串）。`;
  // 503「需求量過高」：服務商那邊整體塞車。2026-09-29 實際發生時連只回一個字的
  // 請求都失敗，每個 flash 模型都一樣。原本這裡沒有對應，使用者看到的是通用的
  // 「剛剛好像卡了一下」，會以為是自己的金鑰或操作有問題。
  if (/\b503\b|high demand|overloaded|UNAVAILABLE/i.test(m))
    return `${name} 目前全面塞車（服務商的伺服器忙不過來），這不是你的金鑰或操作的問題。`
      + '請等幾分鐘再試一次。';
  if (/\b403\b|permission|not authorized|access denied/i.test(m))
    return `這把金鑰沒有使用權限。請到${name}後台確認金鑰狀態，或確認帳號是否已啟用付費。`;
  // 402 是「沒錢」，跟 429「用太快」完全不同，給的建議也不同
  if (/\b402\b|payment required|insufficient (credit|balance|funds)|negative credit/i.test(m))
    return `${name} 帳戶餘額不足，無法使用付費模型。請到 ${name} 後台儲值，`
      + '或到首頁的「模型設定」改選名稱結尾為 :free 的免費模型。';
  // 免費模型是所有使用者共用一個上游流量池，被限流跟「你的額度用完」是兩回事
  if (/rate.?limited upstream|temporarily rate.?limited/i.test(m))
    return '這個免費模型目前使用的人太多（免費模型是所有人共用流量），暫時排不進去。'
      + '請等一兩分鐘再試，或到「模型設定」換一個模型——免費模型本來就比較容易遇到這種情況。';
  if (/\b429\b|quota|rate limit|insufficient_quota/i.test(m))
    return `${name}的額度已用盡或觸發流量限制。請稍後再試，或到後台確認方案與餘額。`;
  if (/沒有可用的模型/.test(m))
    return `這把金鑰查不到任何可用的模型，請確認帳號是否已開通。`;
  if (/timed out|TimeoutError|aborted/i.test(m))
    return '模型一直沒有回應。免費模型在忙碌時常會這樣，'
      + '請到「模型設定」換一個模型（標 ★ 推薦的比較穩），或稍後再試。';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(m))
    return `連不上${name}的伺服器，請確認網路連線後再試一次。`;
  return null;
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
