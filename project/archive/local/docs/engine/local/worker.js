// 本機推論的執行緒 —— transformers.js 只在這裡出現。
//
// 為什麼一定要 Web Worker：
//   生成一個回合要跑數百次前向傳遞。放在主執行緒上，UI 會凍住、
//   而且 TTS 與收音都會卡頓——語音對練會直接不能用。
//
// 錯誤處理契約（與 engine/platform.js 的 http() 同一個原則，handbook §9.2 第 6 條）：
//   **絕不把原始例外訊息丟給上層去比對文字。** 一律回傳固定標籤：
//
//     'no-backend'   這個瀏覽器跑不動（沒有 WebGPU 也沒有 WASM）
//     'download'     模型下載失敗（網路、CDN、配額）
//     'load'         模型載入失敗（記憶體不足、緩衝區上限、格式不符）
//     'generate'     生成過程出錯
//     'aborted'      使用者主動中斷（不是錯誤，但呼叫端要能分辨）
//
//   上層依標籤決定要不要降階、要不要換較小的模型、要顯示什麼訊息。

import {
  env,
  AutoProcessor,
  AutoTokenizer,
  AutoModelForCausalLM,
  Qwen3_5ForConditionalGeneration,
  TextStreamer,
  InterruptableStoppingCriteria,
} from '../../vendor/transformers/transformers.web.min.js';

// ── 執行環境設定 ────────────────────────────────────────────────
//
// 預設 transformers.js 會去 CDN 抓 ONNX Runtime 的 wasm。
// 那會讓「完全離線」在第二次啟動時仍然依賴外部主機，所以改指向自帶副本。
env.backends.onnx.wasm.wasmPaths = new URL('../../vendor/transformers/', import.meta.url).href;
env.allowLocalModels = false;      // 模型一律從遠端取得，之後由瀏覽器快取
env.useBrowserCache = true;        // 快取在使用者裝置，離線時直接命中

// 自架鏡像：把 HuggingFace 換成我們自己的伺服器。
// 手機實機測試需要這個——否則每測一次就要從 HF 抓數百 MB。
// transformers.js 用 remoteHost + remotePathTemplate 組出完整 URL，
// 所以檔案要放成 /models/hf/<repo>/<path>（見 tools/fetch-model.mjs）。
function useMirror(base) {
  env.remoteHost = new URL(base + 'hf/', self.location.href).href;
  env.remotePathTemplate = '{model}/';
}

let processor = null;
let model = null;
let loaded = null;                 // { id, dtype, device }
let stopper = null;

const send = m => self.postMessage(m);
const now = () => performance.now();

self.onmessage = async e => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') return await load(msg);
    if (msg.type === 'generate') return await generate(msg);
    if (msg.type === 'abort') return abort();
    if (msg.type === 'unload') return unload();
  } catch (err) {
    // 這裡是最後一道網。能分類的已經在各函式內分類過了。
    send({ type: 'error', id: msg.id ?? null, kind: msg.type === 'load' ? 'load' : 'generate', detail: brief(err) });
  }
};

// ── 載入 ────────────────────────────────────────────────────────
async function load({ id, dtype, device, modules, kind = 'vl', mirrorBase = null }) {
  if (mirrorBase) useMirror(mirrorBase);
  if (loaded && loaded.id === id && loaded.dtype === dtype && loaded.device === device) {
    return send({ type: 'ready', reused: true, ms: 0, ...loaded });
  }
  unload();

  const t0 = now();
  // 多模態模型的 dtype 必須逐子模型指定（未指定者會退回 fp32）；
  // 純文字模型只有一個 session，dtype 是單一字串。兩者的載入類別也不同。
  const isText = kind === 'text';
  const dtypes = isText ? dtype : Object.fromEntries(modules.map(m => [m, dtype]));

  // 下載進度：檔案數與百分比都要能顯示，否則使用者面對數百 MB 會以為卡住
  const progress_callback = p => {
    if (p.status === 'progress' && p.total) {
      send({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    } else if (p.status === 'done' || p.status === 'ready' || p.status === 'initiate') {
      send({ type: 'progress', file: p.file, status: p.status });
    }
  };

  try {
    // 純文字模型沒有 preprocessor_config.json，用 AutoProcessor 會直接失敗
    processor = isText
      ? await AutoTokenizer.from_pretrained(id, { progress_callback })
      : await AutoProcessor.from_pretrained(id, { progress_callback });
  } catch (err) {
    return send({ type: 'error', kind: 'download', detail: brief(err) });
  }

  try {
    const Cls = isText ? AutoModelForCausalLM : Qwen3_5ForConditionalGeneration;
    model = await Cls.from_pretrained(id, {
      dtype: dtypes,
      device,
      progress_callback,
    });
  } catch (err) {
    processor = null;
    // 下載失敗與載入失敗的解法完全不同（handbook §9.2 第 8 條：
    // 相似的錯誤代碼可能是完全不同的問題），所以分開回報。
    const kind = /fetch|network|Failed to load|404|CORS/i.test(String(err?.message || err)) ? 'download' : 'load';
    return send({ type: 'error', kind, detail: brief(err) });
  }

  loaded = { id, dtype, device, kind };
  send({ type: 'ready', reused: false, ms: Math.round(now() - t0), ...loaded });
}

function unload() {
  try { model?.dispose?.(); } catch { /* 釋放失敗不該擋住後續流程 */ }
  model = null; processor = null; loaded = null; stopper = null;
}

// ── 生成 ────────────────────────────────────────────────────────
async function generate({ id, messages, sampling, prefill = '', raw = null, stops = null }) {
  if (!model || !processor) {
    return send({ type: 'error', id, kind: 'load', detail: '模型尚未載入' });
  }

  const tokenizer = processor.tokenizer ?? processor;

  let inputs;
  try {
    // 續寫模式：不套對話模板，直接把逐字稿 tokenize（見 prompts.small.js 的說明）。
    // 這條路線與 GGUF 路線用同一份提示詞，才能公平比較模型本身（計畫書 §17.5 G2）。
    inputs = raw
      ? tokenizer(raw)
      : await applyTemplate(processor, tokenizer, messages, prefill);
  } catch (err) {
    return send({ type: 'error', id, kind: 'generate', detail: `準備輸入失敗：${brief(err)}` });
  }

  const promptTokens = Number(inputs.input_ids?.dims?.at(-1) ?? 0);
  const t0 = now();
  let tFirst = 0;
  let ntok = 0;
  let text = '';

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: chunk => {
      if (!chunk) return;
      if (!tFirst) tFirst = now();
      text += chunk;
      // 串流出去讓 TTS 可以提早開口——這是本機模型體驗勝過雲端的地方（計畫書 §4.3）
      send({ type: 'delta', id, text: chunk });
      // 續寫模式需要停止字串（否則模型會自己編出下一句「業務員：…」）。
      // transformers.js 沒有內建 stop_strings，所以在這裡自己攔並中斷生成。
      if (stops?.length && stops.some(x => text.includes(x))) {
        try { stopper?.interrupt(); } catch { /* 已結束 */ }
      }
    },
    token_callback_function: tokens => { ntok += tokens?.length ?? 1; },
  });

  stopper = new InterruptableStoppingCriteria();

  let interrupted = false;
  try {
    const gen = {
      ...inputs,
      do_sample: true,
      temperature: sampling.temperature,
      top_p: sampling.top_p,
      top_k: sampling.top_k,
      max_new_tokens: sampling.max_new_tokens,
      streamer,
      stopping_criteria: stopper,
    };
    // 只在有指定時才傳，避免覆寫模型自己的預設值
    if (sampling.repetition_penalty) gen.repetition_penalty = sampling.repetition_penalty;
    if (sampling.no_repeat_ngram_size) gen.no_repeat_ngram_size = sampling.no_repeat_ngram_size;
    await model.generate(gen);
  } catch (err) {
    if (interrupted) { /* 由 abort() 造成，不算錯誤 */ }
    else return send({ type: 'error', id, kind: 'generate', detail: brief(err) });
  } finally {
    stopper = null;
  }

  const t1 = now();
  send({
    type: 'done',
    id,
    text,
    stats: {
      promptTokens,
      outTokens: ntok,
      ttftMs: tFirst ? Math.round(tFirst - t0) : null,
      totalMs: Math.round(t1 - t0),
      // tok/s 只算「第一個 token 之後」的速度，否則載入與預填會把數字稀釋掉，
      // 看不出真正的生成速度（handbook §9.1 第 3 條：要看實測延遲，不看紙面能力）
      tps: tFirst && ntok > 1 ? Number(((ntok - 1) / ((t1 - tFirst) / 1000)).toFixed(1)) : null,
    },
  });
}

function abort() {
  try { stopper?.interrupt(); } catch { /* 已經結束就沒事 */ }
  send({ type: 'aborted' });
}

// ── 對話模板 ────────────────────────────────────────────────────
//
// 多模態 processor 與純文字 tokenizer 的介面不完全一致，
// 而且不同版本搬過位置。這裡逐一嘗試，並在全部失敗時給明確錯誤，
// 不讓它安靜地退回「把訊息接成一整串」那種會讓模型行為完全走鐘的路（handbook §9.2 第 9 條）。
async function applyTemplate(proc, tok, messages, prefill = '') {
  const src = typeof proc?.apply_chat_template === 'function' ? proc
    : (typeof tok?.apply_chat_template === 'function' ? tok : null);
  if (!src) throw new Error('找不到 apply_chat_template');

  // enable_thinking: false —— Qwen3 世代的對話模板會讀這個旗標。
  // 實測（Qwen3-0.6B）：不關掉的話它會先吐一整段簡體中文的思考過程，
  // 既慢（每回合 3.8 秒，其中大半是思考）又會外洩到對話氣泡裡。
  // Qwen3.5 Small 預設就關閉，但多傳一個旗標不會有副作用，兩邊統一處理。
  const base = { add_generation_prompt: true, enable_thinking: false };

  // 沒有前綴就走最單純的路徑
  if (!prefill) {
    return await src.apply_chat_template(messages, { ...base, tokenize: true, return_dict: true });
  }

  // 有前綴：先取「文字版」模板，接上前綴，再自己 tokenize。
  // 這樣模型的第一個 token 就已經在 JSON 裡面（見 prompts.small.js 的 ROLEPLAY_PREFILL）。
  // add_special_tokens 必須關閉，否則會在模板前面再插一次特殊 token。
  const text = await src.apply_chat_template(messages, { ...base, tokenize: false });
  return tok(String(text) + prefill, { add_special_tokens: false });
}

// 例外訊息只取前段，避免把整段堆疊丟進 UI 或日誌
function brief(err) {
  const s = err?.message ? String(err.message) : String(err);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}
