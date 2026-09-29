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

// 使用者試聽後選的兩個聲線
export const VOICES = { 男: 'Charon', 女: 'Aoede' };
export const voiceFor = gender => VOICES[gender] || VOICES['男'];

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
export async function* streamSpeech(key, text, voiceName, signal) {
  if (!key) throw new Error('tts no key');
  const r = await fetch(`${HOST}/models/${TTS_MODEL}:streamGenerateContent?alt=sse`, {
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
    let msg = '';
    try { msg = (await r.json()).error?.message || ''; } catch { /* 沒有內容就算了 */ }
    throw new Error(`tts ${r.status} ${msg}`.trim());
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
      if (j.error) throw new Error(`tts ${j.error.code || ''} ${j.error.message || ''}`.trim());
      const inl = j.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
      if (!inl?.data) continue;
      const m = /rate=(\d+)/.exec(inl.mimeType || '');
      yield { pcm: decodePcm(inl.data), rate: m ? Number(m[1]) : 24000 };
    }
  }
}
