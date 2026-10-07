// 第二條推論路線：GGUF（llama.cpp 的 WASM 綁定 wllama）。
//
// 為什麼需要第二個引擎（實測逼出來的，見 12_LOCAL_MODEL_DEV_PLAN.md §16、§17）：
//
//   ① transformers.js 只能跑「它有 JS 實作」的架構。實測 grep 自帶的 4.2.0：
//      Qwen2／Qwen3／Qwen3.5／Gemma3 都在，**MiniCPM 系列完全不存在**。
//      也就是說，不換引擎就等於把模型選擇限制在少數幾個家族裡。
//
//   ② GGUF 生態幾乎每個模型都有現成量化檔（MiniCPM5-1B 官方就有 Q4_K_M，688 MB），
//      不需要自己轉 ONNX。
//
//   ③ llama.cpp 有 **GBNF grammar 與 json_schema**——可以在解碼層保證輸出合法 JSON。
//      那正是 transformers.js 缺的能力（§3.5），也是我們當初被迫改用純文字輸出的原因之一。
//
//   ④ wllama 用 **OPFS** 快取模型。我們在 §13.5 記錄過 Cache API 存不了 436 MB 的權重
//      （`Failed to execute 'put' on 'Cache'`），導致每次開啟都要重新下載、離線不成立。
//      OPFS 是為大檔設計的，這條路線順便解掉那個問題。
//
// 介面刻意與 runtime.js（transformers.js 路線）完全一致：
//   plan_() / load(onProgress) / generate(messages, opts) / abort() / dispose()
// 所以上層（量測台、之後的 gateway adapter）換引擎不必改邏輯——
// 這是 handbook §2.3「Model Gateway 抽象」在本機模型上的同一個原則。

import { probe, pickModel, describe } from './caps.js';
import { MODELS, SAMPLING } from './models.js';
import { clean } from './runtime.js';

const WASM_URL = new URL('../../vendor/wllama/wllama.wasm', import.meta.url).href;
const WASM_COMPAT_URL = new URL('../../vendor/wllama/wllama-compat.wasm', import.meta.url).href;
const JS_COMPAT_URL = new URL('../../vendor/wllama/wllama-compat.js', import.meta.url).href;
const LIB_URL = new URL('../../vendor/wllama/wllama.min.js', import.meta.url).href;

// ── 自己下載並快取（繞過 wllama 的下載器）────────────────────────
//
// 為什麼需要（iPhone 實測逼出來的）：
//   iOS 18.7 上用 wllama 的 loadModelFromUrl 下載 1,154 MB，一分鐘只跑 1 MB。
//   但同一支手機、同一台伺服器分項量測的結果是：
//     純下載 32 MB → 11.9 MB/s
//     純寫入 OPFS 32 MB → 533 MB/s
//     32 個 1 MB 小請求 → 20.7 MB/s
//   **網路與儲存都沒問題**，所以瓶頸在 wllama 把「邊下載邊寫入」串起來的方式
//   （每收到一小塊就 await 一次寫入，在 iOS 上代價極高）。
//
// 這裡改成兩段分開做：先整檔下載並寫進 OPFS，再把檔案交給 wllama。
// 依實測數字，1,154 MB 應該約 100 秒完成，第二次開啟則直接命中 OPFS。
async function fetchToOPFS(url, name, onProgress, retried = false) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('aicoach-models', { create: true });

  // 先問伺服器檔案應該多大，用來判斷快取是否完整
  let expect = 0;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    expect = Number(head.headers.get('content-length') || 0);
  } catch { /* 離線時問不到，下面就只看有沒有檔案 */ }

  // 已有完整檔案就直接用——這是離線可用的關鍵
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    if (f.size > 0 && (!expect || f.size === expect)) {
      onProgress?.({ file: name, loaded: f.size, total: f.size, cached: true });
      return f;
    }
    // 大小不符代表上次下載被中斷，砍掉重下（半個檔案會讓 wllama 給出難查的錯誤）
    if (f.size > 0) await dir.removeEntry(name);
  } catch { /* 沒快取，往下下載 */ }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const e = new Error(`下載失敗 HTTP ${res.status}`);
    e.kind = 'download';
    throw e;
  }
  const total = Number(res.headers.get('content-length') || 0) || expect;

  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();

  // ⚠ 不能用 `for await (const chunk of res.body)`。
  //   Safari（含 iOS 18.7）沒有實作 ReadableStream 的 async iterator，
  //   實機錯誤是「undefined is not a function (near '...chunk of res.body...')」，
  //   而 Chrome 支援，所以桌面完全測不出來。getReader() 是三家瀏覽器都有的寫法。
  const reader = res.body.getReader();
  let got = 0, last = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await w.write(value);
      got += value.byteLength;
      const now = Date.now();
      if (now - last > 200) { last = now; onProgress?.({ file: name, loaded: got, total }); }
    }
    await w.close();
  } catch (err) {
    try { await w.abort(); } catch { /* 已關閉 */ }
    try { await dir.removeEntry(name); } catch { /* 沒建立成功 */ }
    // 配額不足是可以自救的：把其他模型清掉再重試一次。
    // 「錯誤要能行動」（handbook §2.9 第 3 條）——這裡的行動由程式代勞。
    if (/quota|QuotaExceeded/i.test(String(err?.message || err)) && !retried) {
      const freed = await evictCached([name]);
      if (freed > 0) {
        onProgress?.({ file: name, loaded: 0, total, evictedMB: Math.round(freed / 1e6) });
        return fetchToOPFS(url, name, onProgress, true);
      }
    }
    const e = new Error(`寫入快取失敗：${brief(err)}`);
    e.kind = 'download';
    throw e;
  }

  const out = await (await dir.getFileHandle(name)).getFile();
  if (total && out.size !== total) {
    await dir.removeEntry(name);
    const e = new Error(`下載不完整：${out.size} / ${total} 位元組`);
    e.kind = 'download';
    throw e;
  }
  onProgress?.({ file: name, loaded: out.size, total: total || out.size });
  return out;
}

// ── 模型快取管理 ────────────────────────────────────────────────
//
// 為什麼需要（桌面實測 2026-08-20）：測過幾個模型之後，OPFS 就被填滿，
// 下一個模型的錯誤是「would cause the application to exceed its storage quota」。
// 規格 §90 本來就要求「模型管理（下載、刪除、版本）」，這是它的最小實作。
//
// 對使用者的意義：換模型時舊的要能刪掉，否則裝置空間會被慢慢吃光。
const CACHE_DIR = 'aicoach-models';

export async function listCached() {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(CACHE_DIR);
    const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      const f = await h.getFile();
      out.push({ name, bytes: f.size });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  } catch { return []; }
}

export async function evictCached(keep = []) {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
  let freed = 0;
  for (const { name, bytes } of await listCached()) {
    if (keep.includes(name)) continue;
    try { await dir.removeEntry(name); freed += bytes; } catch { /* 刪不掉就跳過 */ }
  }
  return freed;
}

// ── 直載（不經 OPFS）────────────────────────────────────────────
//
// 為什麼需要（桌面實測 2026-08-20）：
//   寫 2,537 MB 到 OPFS 時在 2,066 MB 處失敗，訊息是配額不足——
//   但當時配額 5,817 MB、用量幾乎為 0。
//   原因是 `createWritable()` **先寫暫存檔、close() 時才搬到正式位置**，
//   所以尖峰需要「兩倍檔案大小」的配額。2,066 × 2 ≈ 4.1 GB 就頂到上限。
//
// 直載模式把檔案抓進記憶體直接交給 wllama，不落地。
// 代價是每次開啟都要重新下載（沒有離線快取），
// 但在「模型就在同一台機器上」的開發情境裡完全划算，
// 也是快取寫入失敗時的備援路徑。
async function fetchToMemory(url, name, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    const e = new Error(`下載失敗 HTTP ${res.status}`);
    e.kind = 'download';
    throw e;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();   // Safari 沒有 async iterator（見 D040）
  const chunks = [];
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    const now = Date.now();
    if (now - last > 200) { last = now; onProgress?.({ file: name, loaded: got, total }); }
  }
  onProgress?.({ file: name, loaded: got, total: total || got });
  return new Blob(chunks);
}

// HuggingFace 的直接下載網址。
// rev 省略時退回 'main'——但正式使用的模型都應該鎖 commit（見 models.js）。
export function hfUrl(repo, file, rev = null) {
  return `https://huggingface.co/${repo}/resolve/${rev || 'main'}/${encodeURIComponent(file)}`;
}

export class GgufRuntime {
  // mirrorBase：從自架路徑載入模型（例如 '/models/'），而不是 HuggingFace。
  // selfDownload：自己下載並快取，繞過 wllama 的下載器（見上方說明）。
  // nGpuLayers：要把幾層權重放到 GPU。
  //
  // 為什麼要能調（iPhone 實測逼出來的）：wllama 把整個 GGUF 放進 wasm 堆積，
  // 而開啟 GPU 卸載後，llama.cpp 又會把權重上傳成 WebGPU 緩衝區——
  // 在 iPhone 的統一記憶體上，同一份權重等於存在兩次。
  // 1,154 MB × 2 ≈ 2.3 GB，Safari 直接殺掉分頁（畫面顯示「重複發生問題」）。
  //
  // 降低這個值＝少一份 GPU 副本，代價是生成變慢。0 表示純 CPU（wasm）。
  constructor({ mirrorBase = null, selfDownload = false, nGpuLayers = null, direct = false, useCache = true, nCtx = null } = {}) {
    this.mirrorBase = mirrorBase;
    this.selfDownload = selfDownload;
    this.direct = direct;
    // useCache=false：不落地，純驗證用。避開 createWritable 的「兩倍配額」問題。
    this.useCache = useCache;
    // nCtx：覆寫上下文長度。KV cache 與部分中間緩衝區隨它成長，
    // Gemma 4 E2B 在 4096 時生成失敗（Invalid typed array length ~1.16e9 元素）。
    this.nCtx = nCtx;
    this.nGpuLayers = nGpuLayers;
    this.wllama = null;
    this.caps = null;
    this.plan = null;
    this.ready = false;
    this.loadMs = 0;
    this.pending = new Map();     // 與 runtime.js 介面一致（量測台會讀）
    this.abortCtl = null;
    this.lastStats = null;
    this.seq = 0;
  }

  async plan_(prefer = null) {
    this.caps = await probe();
    this.plan = pickModel(this.caps, prefer);
    this.plan.summary = describe(this.caps, this.plan);
    return { caps: this.caps, plan: this.plan };
  }

  async load(onProgress = null) {
    if (!this.plan) await this.plan_();
    const m = MODELS[this.plan.key];
    // 量化在 GGUF 路線上是「不同檔案」，所以由 plan.dtype 決定要抓哪一個
    const file = m?.gguf?.files?.[this.plan.dtype] || m?.gguf?.file;
    if (!m?.gguf || !file) {
      const e = new Error(`${this.plan.label} 沒有 GGUF 來源`);
      e.kind = 'load';
      throw e;
    }

    const t0 = performance.now();
    let Wllama;
    try {
      ({ Wllama } = await import(LIB_URL));
    } catch (err) {
      const e = new Error(`wllama 載入失敗：${brief(err)}`);
      e.kind = 'no-backend';
      throw e;
    }

    // pathConfig 的鍵名是 `default`（見 wllama.d.ts 的 AssetsPathConfig），
    // 另外 worker 初始化時會再查 'wllama.wasm'，所以兩個都給。
    this.wllama = new Wllama({ default: WASM_URL, 'wllama.wasm': WASM_URL });

    // Safari 一定走相容路徑：needCompat() = !isSupportJSPI() || !isSupportMem64()，
    // 而 Safari 既沒有 JSPI（WebAssembly.Suspending）也沒有 memory64。
    // 預設的相容資源在 jsdelivr CDN 上——那會讓 iOS 離線時直接失敗，
    // 所以改指向自帶副本。
    try {
      this.wllama.setCompat({ worker: JS_COMPAT_URL, wasm: WASM_COMPAT_URL });
      this.compatLocal = true;
    } catch (err) {
      this.compatLocal = false;   // 設不起來就讓它走預設（CDN），但要記錄下來
    }

    // 下載來源。
    //
    // ⚠ 這裡原本寫成「有自架鏡像才給 src，否則交給 wllama 的 loadModelFromHF」。
    //   那是一個嚴重的錯誤，而且正好在我以為修好的地方：
    //   下面的判斷是 `this.selfDownload && src`，而公開部署沒有鏡像 → src 為 null
    //   → **自己下載整條被跳過，實際走 wllama 內建的下載器**。
    //   那個下載器在 iOS 上實測 1 MB/分鐘（D039），2 GB 要三十四小時；
    //   桌面實測 398 MB 也要 321 秒（約 1.3 MB/s，有線網路不該這麼慢）。
    //
    //   所以改成自己組 HuggingFace 的 URL，讓 src 永遠有值。
    //   附帶的好處是我們掌握了 revision——見 models.js 開頭「為什麼要鎖 commit」。
    const src = this.mirrorBase
      ? new URL(this.mirrorBase + file, location.href).href
      : hfUrl(m.gguf.repo, file, m.gguf.rev);

    try {
      // ⚠ useCache:false 不能搭 loadModelFromUrl。
      //   那條路徑一定經過 wllama 的 cache manager，不寫入就找不到紀錄，
      //   丟出的錯誤是「Model file not found: <url>」——**訊息會誤導成檔案不存在**
      //   （實測：同一個 URL 用 curl 拿是 200）。這裡自動改走直載。
      const wantDirect = this.direct || (!this.useCache && !!src);
      const load = wantDirect && src
        // 直載：抓進記憶體直接交給 wllama，不寫 OPFS（沒有離線快取）
        ? (async opts => this.wllama.loadModel([await fetchToMemory(src, file, onProgress)], opts))
        : this.selfDownload && src
        // 自己下載完再整檔交給 wllama（不經它的 cache manager）
        ? (async opts => this.wllama.loadModel([await fetchToOPFS(src, file, onProgress)], opts))
        : src
          ? this.wllama.loadModelFromUrl.bind(this.wllama, src)
          : this.wllama.loadModelFromHF.bind(this.wllama, { repo: m.gguf.repo, file });
      await load(
        {
          n_ctx: this.nCtx || m.ctxUse || 2048,
          // 全部層丟給 GPU；記憶體不足時 wllama 會回報錯誤，由呼叫端降階
          n_gpu_layers: this.nGpuLayers != null
            ? this.nGpuLayers
            : (this.caps.backend === 'webgpu' ? 99 : 0),
          useCache: this.useCache,    // OPFS 快取，離線可用的關鍵；驗證時可關掉
          allowOffline: true,
          progressCallback: p => {
            if (!p) return;
            const loaded = p.loaded ?? p.currentSize ?? 0;
            const total = p.total ?? p.totalSize ?? 0;
            if (total) onProgress?.({ file, loaded, total });
          },
        },
      );
    } catch (err) {
      const msg = String(err?.message || err);
      // 標籤化：下載失敗、記憶體不足、架構不支援，三者的解法完全不同
      const kind = /fetch|network|404|Failed to (load|fetch)/i.test(msg) ? 'download'
        : /unknown model architecture|unsupported/i.test(msg) ? 'unsupported'
          : 'load';
      const e = new Error(brief(err));
      e.kind = kind;
      throw e;
    }

    this.loadMs = Math.round(performance.now() - t0);
    this.ready = true;
    this.info = safe(() => this.wllama.getLoadedContextInfo());
    this.nglUsed = this.nGpuLayers != null ? this.nGpuLayers : (this.caps.backend === 'webgpu' ? 99 : 0);
    this.webgpu = safe(() => this.wllama.isSupportWebGPU());
    return { ms: this.loadMs, plan: this.plan };
  }

  // 與 runtime.js 同簽章。prefill 在這條路線上用 grammar 更可靠，但兩者都支援。
  // raw：續寫模式（見 prompts.small.js 的 roleplayRawPrompt 說明）。
  // 傳 { raw: '<逐字稿字串>', stops: [...] } 時走 createCompletion，messages 會被忽略。
  async generate(messages, { tier = 'roleplay', onDelta = null, sampling = null, prefill = '', grammar = null, raw = null, stops = null } = {}) {
    if (!this.ready) {
      const e = new Error('本機模型尚未載入');
      e.kind = 'load';
      throw e;
    }
    const s = sampling || SAMPLING[tier] || SAMPLING.roleplay;
    const id = ++this.seq;
    this.abortCtl = new AbortController();

    const msgs = prefill
      ? [...messages, { role: 'assistant', content: prefill }]
      : messages;

    const t0 = performance.now();
    let tFirst = 0, text = '', ntok = 0;

    const params = {
      messages: msgs,
      stream: true,
      abortSignal: this.abortCtl.signal,
      max_tokens: s.max_new_tokens,
      temp: s.temperature,
      top_p: s.top_p,
      top_k: s.top_k,
      penalty_repeat: s.repetition_penalty ?? 1.0,
      // Qwen3 世代預設開 thinking；統一關掉（見 worker.js 同一段說明）
      chat_template_kwargs: { enable_thinking: false },
    };
    if (grammar) params.grammar = grammar;

    if (raw) {
      // 續寫模式：不給它「請求」，給逐字稿讓它接著寫
      delete params.messages;
      delete params.chat_template_kwargs;
      params.prompt = raw;
      if (stops?.length) params.stop = stops;
    }

    try {
      const out = raw
        ? await this.wllama.createCompletion(params)
        : await this.wllama.createChatCompletion(params);
      // stream: true 回傳非同步迭代器；保守處理非串流的情況
      if (out && typeof out[Symbol.asyncIterator] === 'function') {
        for await (const chunk of out) {
          // chat 與 completion 的串流欄位不同（delta.content vs text）
          const piece = chunk?.choices?.[0]?.delta?.content
            ?? chunk?.choices?.[0]?.text
            ?? chunk?.piece ?? '';
          if (!piece) continue;
          if (!tFirst) tFirst = performance.now();
          ntok++;
          text += piece;
          onDelta?.(piece);
        }
      } else {
        text = out?.choices?.[0]?.message?.content ?? out?.choices?.[0]?.text ?? String(out ?? '');
        tFirst = performance.now();
      }
    } catch (err) {
      if (this.abortCtl?.signal.aborted) { /* 使用者中斷，不算錯誤 */ }
      else {
        const e = new Error(brief(err));
        e.kind = 'generate';
        throw e;
      }
    } finally {
      this.abortCtl = null;
    }

    const t1 = performance.now();
    const stats = {
      promptTokens: null,          // wllama 不逐回合回報，改由 getLoadedContextInfo 觀察
      outTokens: ntok,
      ttftMs: tFirst ? Math.round(tFirst - t0) : null,
      totalMs: Math.round(t1 - t0),
      tps: tFirst && ntok > 1 ? Number(((ntok - 1) / ((t1 - tFirst) / 1000)).toFixed(1)) : null,
    };
    this.lastStats = stats;
    const whole = prefill + text;
    return { text: clean(whole), raw: whole, stats, model: this.plan.label };
  }

  // ── 暖身 ──────────────────────────────────────────────────────
  //
  // 為什麼需要（桌面實測 2026-08-20，同一個提示詞連跑兩次）：
  //
  //   第一次   首 token 6,998 ms   感知延遲 7.7 秒
  //   第二次   首 token   351 ms   感知延遲 1.0 秒  ← 差 20 倍
  //
  // 兩件事造成這個差距：WebGPU 的 shader 首次編譯，以及 llama.cpp 對
  // **相同前綴**的 KV cache 重用。我們的 system 提示詞與兩組角色示範每回合都一樣
  // （約 700 token），所以第二回合起幾乎不必重新 prefill。
  //
  // 暖身就是把這筆一次性成本挪到「使用者還沒開始說話」的時候付掉。
  // 傳入真正要用的提示詞前綴，效果才會發生在對的地方。
  async warmup(prompt, { maxTokens = 1 } = {}) {
    if (!this.ready) return null;
    const t0 = performance.now();
    try {
      await this.generate([], {
        raw: prompt,
        sampling: { temperature: 0.1, top_p: 1, top_k: 1, max_new_tokens: maxTokens },
      });
    } catch { /* 暖身失敗不該擋住正常流程 */ }
    this.warmupMs = Math.round(performance.now() - t0);
    return this.warmupMs;
  }

  abort() { try { this.abortCtl?.abort(); } catch { /* 已結束 */ } }

  dispose() {
    try { this.wllama?.exit?.(); } catch { /* 已釋放 */ }
    this.wllama = null; this.ready = false; this.pending.clear();
  }
}

const brief = err => {
  const s = err?.message ? String(err.message) : String(err);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
};

const safe = fn => { try { return fn(); } catch { return null; } };
