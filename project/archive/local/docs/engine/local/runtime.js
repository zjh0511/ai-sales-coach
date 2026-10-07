// 本機推論的主執行緒介面 —— 把 Worker 的訊息協定包成 Promise。
//
// 這一層刻意不知道「教練」的任何事：它只負責「給訊息、拿文字」。
// 之後 gateway.js 的 local adapter 會用它，介面維持
//   generate(text, { system, temp, max, json, tier, history }) → { text, ms, model }
// 所以 Coach Engine 一行都不用改（handbook §2.3、計畫書 §4.1 紅線）。

import { probe, pickModel, describe } from './caps.js';
import { MODELS, dtypeMap, SAMPLING } from './models.js';

export class LocalRuntime {
  // mirrorBase：改從自架路徑載入模型（例如 '/models/'），不連 HuggingFace。
  // 與 GGUF 路線的 GgufRuntime 同一個選項名稱，讓上層兩條路線的用法一致。
  constructor({ mirrorBase = null } = {}) {
    this.mirrorBase = mirrorBase;
    this.worker = null;
    this.caps = null;
    this.plan = null;
    this.ready = false;
    this.loadMs = 0;
    this.seq = 0;
    this.pending = new Map();     // id → { resolve, reject, onDelta }
    this.onProgress = null;       // (｛file, loaded, total, status｝) → void
    this.lastStats = null;
  }

  // ── 準備 ──────────────────────────────────────────────────────
  //
  // 回傳 plan（要載入什麼、多大、有什麼警告），呼叫端可以先給使用者看再決定下載。
  // **刻意分成 plan() 與 load() 兩步**：規格 §90 要求下載前先告知大小與是否需 Wi-Fi。
  async plan_(prefer = null) {
    this.caps = await probe();
    this.plan = pickModel(this.caps, prefer);
    this.plan.summary = describe(this.caps, this.plan);
    return { caps: this.caps, plan: this.plan };
  }

  async load(onProgress = null) {
    if (!this.plan) await this.plan_();
    if (this.plan.blocked) {
      const e = new Error(this.plan.blockedText);
      e.kind = 'no-backend';
      throw e;
    }
    this.onProgress = onProgress;

    this.worker ||= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = e => this._onMessage(e.data || {});
    this.worker.onerror = e => {
      // Worker 本身掛掉（語法錯誤、import 失敗）——這與模型載入失敗是不同的問題
      this._failAll('load', e?.message || 'worker 啟動失敗');
    };

    const m = MODELS[this.plan.key];
    const t0 = performance.now();

    await new Promise((resolve, reject) => {
      this._loadWait = { resolve, reject };
      this.worker.postMessage({
        type: 'load',
        id: this.plan.id,
        dtype: this.plan.dtype,
        device: this.plan.device,
        modules: m.modules,
        kind: this.plan.kind,
        mirrorBase: this.mirrorBase,
      });
    });

    this.loadMs = Math.round(performance.now() - t0);
    this.ready = true;
    return { ms: this.loadMs, plan: this.plan };
  }

  // ── 生成 ──────────────────────────────────────────────────────
  //
  // messages: [{ role: 'system'|'user'|'assistant', content: string }]
  // tier:     'roleplay' | 'structured' | 'feedback'（對應 §3.5 的取樣參數）
  // prefill：幫模型把回答的開頭寫好（例如 '{"say":"'），它會被接回結果文字，
  // 所以呼叫端拿到的仍然是完整可解析的內容。
  async generate(messages, { tier = 'roleplay', onDelta = null, sampling = null, prefill = '', raw = null, stops = null } = {}) {
    if (!this.ready) {
      const e = new Error('本機模型尚未載入');
      e.kind = 'load';
      throw e;
    }
    const id = ++this.seq;
    const s = sampling || SAMPLING[tier] || SAMPLING.roleplay;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onDelta, prefill, stops });
      this.worker.postMessage({ type: 'generate', id, messages, sampling: s, prefill, raw, stops });
    });
  }

  abort() { this.worker?.postMessage({ type: 'abort' }); }

  dispose() {
    try { this.worker?.postMessage({ type: 'unload' }); } catch { /* 已經沒了 */ }
    try { this.worker?.terminate(); } catch { /* 同上 */ }
    this.worker = null; this.ready = false; this.pending.clear();
  }

  // ── Worker 訊息處理 ───────────────────────────────────────────
  _onMessage(m) {
    if (m.type === 'progress') { this.onProgress?.(m); return; }

    if (m.type === 'ready') { this._loadWait?.resolve(m); this._loadWait = null; return; }

    if (m.type === 'delta') {
      this.pending.get(m.id)?.onDelta?.(m.text);
      return;
    }

    if (m.type === 'done') {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      this.lastStats = m.stats;
      let whole = (p?.prefill || '') + m.text;
      // 續寫模式：停止字串之前的內容才是這一回合的台詞
      for (const stop of p?.stops || []) {
        const i = whole.indexOf(stop);
        if (i > 0) whole = whole.slice(0, i);
      }
      p?.resolve({ text: clean(whole), raw: whole, stats: m.stats, model: this.plan.label });
      return;
    }

    if (m.type === 'aborted') return;

    if (m.type === 'error') {
      const e = new Error(m.detail || '本機模型發生錯誤');
      e.kind = m.kind;                     // 標籤，不要讓上層比對訊息文字
      if (m.id == null) { this._loadWait?.reject(e); this._loadWait = null; this.ready = false; return; }
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      p?.reject(e);
    }
  }

  _failAll(kind, detail) {
    const e = new Error(detail);
    e.kind = kind;
    this._loadWait?.reject(e); this._loadWait = null;
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
    this.ready = false;
  }
}

// ── 輸出清洗（程式層，兩層防護的下半層）────────────────────────
//
// handbook §4.2 記錄過兩個坑：輸出夾雜 Markdown 記號會在純文字氣泡裡變亂符號；
// 以及思考模式的輸出不該進到對話裡。Qwen3.5 Small 預設關閉 thinking，
// 但「預設」不等於「保證」——提示詞擋不住的就用程式擋（handbook §2.7）。
export function clean(s) {
  if (!s) return '';
  let t = String(s);
  // 未閉合的思考區塊：模型還在思考就被 max_new_tokens 截斷，於是沒有結束標籤。
  // 這種情況下整段輸出都不能用——留著會把簡體中文的內部推理丟到對話裡。
  const open = t.indexOf('<think>');
  if (open >= 0 && !/<\/think>/i.test(t)) t = t.slice(0, open);
  return t
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // 完整的思考區塊
    .replace(/^[\s\S]*?<\/think>/i, '')          // 只有結尾標籤（被截斷的思考）
    .replace(/^```[a-z]*\n?|```$/gim, '')        // 程式碼圍籬
    .replace(/\*\*(.+?)\*\*/g, '$1')             // 粗體
    .replace(/(^|\n)\s*[#>]+\s*/g, '$1')         // 標題與引用記號
    .trim();
}
