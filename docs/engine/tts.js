// Gemini 語音合成（TTS）——用使用者同一把 Google AI Studio 金鑰，不需要另外的服務。
//
// 為什麼要做：瀏覽器內建朗讀在 iPhone 上怎麼調都像機器。使用者聽過樣本後確認
// 「口音可以」，選了輕量版。實測（2026-09-29）：
//   串流模式第一段聲音約 0.9 秒，產生速度比播放快（2.3 秒產生 6.8 秒），
//   所以可以邊收邊播、不會斷斷續續。
//
// 三個實測踩到的坑，都在這裡處理：
//   1. 語氣指示會被唸出來。在台詞前加「用忙碌但客氣的語氣說：」，
//      轉錄出來開頭就是那句指示——所以只送純台詞。
//   2. 串流回的是原始 PCM（audio/l16; rate=24000），不是 WAV。
//   3. 串流事件用 \r\n 分隔，只認 \n\n 會一段都解析不到。
//
// 這個模組只負責「文字 → 一段一段的 PCM」，播放交給 voice.js。

const HOST = 'https://generativelanguage.googleapis.com/v1beta';

export const TTS_MODEL = 'gemini-3.8-flash-lite-tts';

// 同一把金鑰可以用的語音模型，依序輪流。免費額度是「每個模型各自算」
// （實測 2026-09-30：輕量版被擋之後，標準版、3.1 版照樣能用），
// 所以輪流用可以把每天的真人語音拉長約三倍，學員只需要一把金鑰。
// 四個聲線（客戶 Charon／Aoede、教練 Sadaltager／Sulafat）在三個模型上都確認過。
export const TTS_MODELS = [TTS_MODEL, 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview'];

// 使用者試聽後選的兩個聲線
export const VOICES = { 男: 'Charon', 女: 'Aoede' };
export const voiceFor = gender => VOICES[gender] || VOICES['男'];

// 「問問其他問題」教練的聲音，刻意和演練客戶不同，一聽就知道是誰在講話。
// 使用者試聽五個樣本後留下這兩個，讓學員自己選（2026-09-30）。
export const COACH_VOICES = { 男: 'Sadaltager', 女: 'Sulafat' };

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

// base64 → 16-bit 小端序 PCM。用 DataView 讀，不依賴平台的位元組順序。
export function decodePcm(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

// 串流產生語音。每次 yield 一段 { pcm: Int16Array, rate }。
// 失敗一律丟例外（帶 HTTP 狀態碼），由呼叫端決定要不要退回手機內建朗讀。
export async function* streamSpeech(key, text, voiceName, signal, model = TTS_MODEL) {
  if (!key) throw new Error('tts no key');
  const r = await fetch(`${HOST}/models/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
    signal,
  });
  if (!r.ok) {
    let err = {};
    try { err = (await r.json()).error || {}; } catch { /* 沒有內容就算了 */ }
    throw ttsError(r.status, err);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).split(CR + LF).join(LF);
    let i;
    while ((i = buf.indexOf(LF + LF)) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = ev.split(LF).find(l => l.startsWith('data: '));
      if (!line) continue;
      const j = JSON.parse(line.slice(6));
      if (j.error) throw ttsError(j.error.code, j.error);
      const inl = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
      if (!inl?.data) continue;
      const m = /rate=(\d+)/.exec(inl.mimeType || '');
      yield { pcm: decodePcm(inl.data), rate: m ? Number(m[1]) : 24000 };
    }
  }
}

// Google 的錯誤只有 details 裡才分得出「這一分鐘用完」還是「今天用完」，
// message 裡兩種看起來幾乎一樣——所以把它們解析出來掛在錯誤上。
export function ttsError(status, err = {}) {
  const e = new Error(`tts ${status || ''} ${err.message || ''}`.replace(/\s+/g, ' ').trim());
  e.status = Number(status) || 0;
  const details = Array.isArray(err.details) ? err.details : [];
  const ids = details.flatMap(d => d?.violations || []).map(v => String(v?.quotaId || ''));
  if (ids.some(id => /PerDay/i.test(id))) e.quota = 'day';
  else if (e.status === 429) e.quota = 'minute';
  const delay = details.find(d => d?.retryDelay)?.retryDelay;
  const sec = parseFloat(delay || /retry in ([\d.]+)s/i.exec(err.message || '')?.[1]);
  if (Number.isFinite(sec)) e.retryMs = Math.ceil(sec * 1000);
  return e;
}

// Google 的每天額度在美國太平洋時間半夜重算（台灣時間下午 3 點，冬令時間 4 點）。
// 用 Intl 換算，夏令／冬令時間自動正確。
export function nextPacificMidnight(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  const elapsed = ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
  return now - elapsed + 24 * 3600 * 1000 - (now % 1000);
}

// 三個語音模型輪流。某個模型被擋就記下來、換下一個；學員感覺不到。
//   這一分鐘用完 → 依 Google 說的秒數暫停這個模型
//   今天用完     → 暫停 30 分鐘再試（實測 Google 的「今天用完」並不一致：
//                  回了每天上限之後，下一次又成功過——整天鎖住會白白浪費額度）
//   這把金鑰不能用這個模型（403／404）→ 一天內不再試
//   服務商塞車（503）→ 暫停 1 分鐘，先換別的
// 狀態存在手機裡（store），關掉 App 再打開也不會重複去撞已經用完的模型。
// 已經開始出聲才失敗的，不換模型重唸（會聽到同一句話講兩次），直接往外拋。
const DAY_RETRY_MS = 30 * 60 * 1000;

export class TtsRotator {
  constructor({ models = TTS_MODELS, store = null, now = () => Date.now() } = {}) {
    this.models = models; this.store = store; this.now = now;
    this.state = {};                       // { [model]: { until, why } }
    try { Object.assign(this.state, store?.load?.() || {}); } catch { /* 壞資料當空的 */ }
  }

  _save() { try { this.store?.save?.(this.state); } catch { /* 容量滿時忽略 */ } }

  _block(model, ms, why) {
    this.state[model] = { until: this.now() + ms, why };
    this._save();
  }

  available() { return this.models.filter(m => !(this.state[m]?.until > this.now())); }

  // 三個都因為「今天用完」被擋 → 畫面要說清楚、告訴學員幾點恢復
  allDayOut() { return this.models.every(m => this.state[m]?.why === 'day' && this.state[m].until > this.now()); }

  async *stream(key, text, voiceName, signal) {
    let last = null;
    for (const model of this.available()) {
      let started = false;
      try {
        for await (const chunk of streamSpeech(key, text, voiceName, signal, model)) { started = true; yield chunk; }
        if (this.state[model]) { delete this.state[model]; this._save(); }
        return;
      } catch (e) {
        if (started || signal?.aborted) throw e;
        last = e;
        if (e.quota === 'day') this._block(model, DAY_RETRY_MS, 'day');
        else if (e.quota === 'minute') this._block(model, Math.min(e.retryMs || 60000, 120000) + 1000, 'minute');
        else if (e.status === 403 || e.status === 404) this._block(model, 24 * 3600 * 1000, 'denied');
        else if (e.status === 503) this._block(model, 60000, 'busy');
        else throw e;                        // 網路問題等：交給 voice.js 決定要不要退回手機朗讀
      }
    }
    // 沒有模型可用了：告訴呼叫端最快什麼時候會有模型恢復
    const until = Math.min(...this.models.map(m => this.state[m]?.until || 0).filter(t => t > this.now()), this.now() + 60000);
    const e = new Error(`tts all models unavailable${last ? ': ' + last.message : ''}`);
    e.quota = this.allDayOut() ? 'day' : 'minute';
    e.retryAt = until;
    throw e;
  }
}
