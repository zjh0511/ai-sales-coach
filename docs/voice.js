// Voice Engine — STT / TTS 抽象層。
// Provider 目前是瀏覽器內建 Web Speech API；未來要換 Whisper / 雲端 TTS，
// 只要換掉這個檔案，App 其他部分不需修改。
//
// 已知 V1 限制（iOS Safari）：
//  - AI 說話時無法同時收音，因此 Barge-in 用「點一下麥克風打斷」代替自動偵測。
//  - speechSynthesis 需要一次使用者手勢才能解鎖，故 unlock() 必須在按鈕事件中呼叫。

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export const supported = {
  stt: !!SR,
  tts: 'speechSynthesis' in window,
};

// 挑語音。優先順序刻意把「加強版」放最前面：
// iOS 預設給 Web Speech 的是壓縮版語音，實機聽起來明顯是機器聲。
// 使用者在「設定 → 輔助使用 → 旁白 → 語音 → 中文」下載加強版之後，
// 那個語音才會出現在 getVoices() 裡，音質差距很大。
// （此判斷來自離線版實機測試，見 ai-sales-coach-local/docs/voice-stream.js）
const BETTER = /enhanced|premium|加強|優化|siri/i;

export function pickVoice(lang = 'zh-TW') {
  const vs = speechSynthesis.getVoices();
  const zh = vs.filter(v => v.lang === lang || /zh[-_]TW|Hant/i.test(v.lang));
  return zh.find(v => BETTER.test(v.name))
    || zh[0]
    || vs.find(v => /^zh/i.test(v.lang))
    || null;
}

// 目前用的語音是不是壓縮版？是的話值得提示使用者去下載加強版。
export function voiceInfo() {
  if (!supported.tts) return null;
  const v = pickVoice();
  if (!v) return { name: null, enhanced: false };
  return { name: v.name, enhanced: BETTER.test(v.name) };
}

export class Voice {
  constructor({ onPartial, onFinal, onState }) {
    this.onPartial = onPartial; this.onFinal = onFinal; this.onState = onState;
    this.rec = null; this.state = 'idle'; this.unlocked = false; this.voice = null;
    // 量測用：使用者說完（STT final）到 AI 真正開口之間的時間。
    // 語音對練裡使用者感知的延遲是「對方何時開始說話」，不是「何時說完」。
    this.lastFinalAt = 0;
    this.latencies = [];
    if (supported.tts) {
      const load = () => { this.voice = pickVoice(); };
      load(); speechSynthesis.onvoiceschanged = load;
    }
  }

  _set(s) { this.state = s; this.onState?.(s); }

  // 必須在使用者手勢中呼叫一次（iOS 音訊解鎖）
  unlock() {
    if (this.unlocked || !supported.tts) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0; speechSynthesis.speak(u);
    this.unlocked = true;
  }

  listen() {
    if (!supported.stt || this.state === 'listening') return false;
    this.stopSpeaking();
    try {
      const r = new SR();
      r.lang = 'zh-TW';
      r.interimResults = true;
      r.continuous = false;            // iOS 對 continuous 支援不穩，改用單句 + 自動重啟
      r.maxAlternatives = 1;
      let final = '';
      r.onresult = e => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        this.onPartial?.(final + interim);
      };
      r.onerror = e => {
        this.rec = null; this._set('idle');
        if (e.error !== 'aborted' && e.error !== 'no-speech') this.onState?.('error:' + e.error);
      };
      r.onend = () => {
        this.rec = null; this._set('idle');
        const t = final.trim();
        if (t) { this.lastFinalAt = performance.now(); this.onFinal?.(t); }
      };
      r.start();
      this.rec = r; this._set('listening');
      return true;
    } catch { this._set('idle'); return false; }
  }

  stopListening() { try { this.rec?.stop(); } catch { /* ignore */ } }
  abortListening() { try { this.rec?.abort(); } catch { /* ignore */ } this.rec = null; }

  speak(text, hint = {}) {
    return new Promise(resolve => {
      if (!supported.tts || !text) return resolve();
      speechSynthesis.cancel();
      // 依標點切句 → 逐句送出，降低第一個字發聲的延遲
      const parts = text.split(/(?<=[。！？!?，,；;])/).filter(s => s.trim());
      let left = parts.length, fin = false, started = false;
      this._set('speaking');
      const finish = () => { if (fin) return; fin = true; clearTimeout(guard); this._set('idle'); resolve(); };
      // 保險絲：iOS/部分環境的 onend 偶爾不觸發，不能讓整個流程卡死
      const guard = setTimeout(finish, 3000 + text.length * 260);

      parts.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = 'zh-TW';
        if (this.voice) u.voice = this.voice;
        u.rate = hint.rate ?? 1.0;
        u.pitch = hint.pitch ?? 1.0;
        // 只在第一句真正開始播放時記一次——這才是使用者感知到的「客戶開口」
        u.onstart = () => {
          if (started) return;
          started = true;
          if (this.lastFinalAt) {
            this.latencies.push(Math.round(performance.now() - this.lastFinalAt));
            this.lastFinalAt = 0;
          }
        };
        const done = () => { if (--left <= 0) finish(); };
        u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
        if (i === 0) setTimeout(() => { /* iOS 偶發卡住的保險絲 */
          if (speechSynthesis.paused) speechSynthesis.resume();
        }, 250);
      });
    });
  }

  stopSpeaking() {
    if (supported.tts) speechSynthesis.cancel();
    if (this.state === 'speaking') this._set('idle');
  }

  // 這次演練的「開口延遲」統計（毫秒）
  stats() {
    const a = this.latencies;
    if (!a.length) return null;
    const sorted = [...a].sort((x, y) => x - y);
    return {
      turns: a.length,
      avg: Math.round(a.reduce((s, v) => s + v, 0) / a.length),
      best: sorted[0],
      worst: sorted[sorted.length - 1],
    };
  }

  reset() { this.abortListening(); this.stopSpeaking(); this._set('idle'); this.lastFinalAt = 0; }
  resetStats() { this.latencies = []; this.lastFinalAt = 0; }
}
