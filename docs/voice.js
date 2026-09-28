// Voice Engine — STT / TTS 抽象層。
// Provider 目前是瀏覽器內建 Web Speech API；未來要換 Whisper / 雲端 TTS，
// 只要換掉這個檔案，App 其他部分不需修改。
//
// 已知 V1 限制（iOS Safari）：
//  - AI 說話時無法同時收音，因此 Barge-in 用「點一下麥克風打斷」代替自動偵測。
//  - speechSynthesis 需要一次使用者手勢才能解鎖，故 unlock() 必須在按鈕事件中呼叫。

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '')
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// 朗讀播完到開麥克風之間要等多久。iOS 播放結束後音訊通道不會立刻釋放，
// 馬上開收音常常會「開了但收不到」。3500ms 是另一個版本
// （zjh0511/ai-sales-coach-app）在 iPhone／iPad 上反覆踩坑後定下的數字；
// 等待期間畫面會說明，而且使用者點麥克風可以直接跳過。
export const MIC_AFTER_TTS_MS = IOS ? 3500 : 300;

// 匯出成物件是為了測試能把時間縮短——不然測「卡住 12 秒」就得真的等 12 秒。
export const TIMING = {
  stall: 12000,   // 開始收音後這麼久都沒有任何辨識結果 → 視為卡住
  end: 4000,      // 拿到最終結果後，這麼久還沒觸發 onend → 強制收尾
  start: 10000,   // 朗讀這麼久都沒開始播放 → 放行，別讓流程卡死
  poll: 300,      // 輪詢朗讀引擎狀態的間隔
};

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
  constructor({ onPartial, onFinal, onState, onEmpty, onStall }) {
    this.onPartial = onPartial; this.onFinal = onFinal; this.onState = onState;
    this.onEmpty = onEmpty;   // 這一輪沒聽到任何話（手機上短暫沉默很正常，不是錯誤）
    this.onStall = onStall;   // 收音卡住：麥克風沒真的接上，或辨識服務沒有回應
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
    this._clearTimers();
    let r;
    try { r = new SR(); } catch { this._set('idle'); return false; }
    r.lang = 'zh-TW';
    r.interimResults = true;
    r.continuous = false;              // iOS 對 continuous 支援不穩，改用單句 + 自動重啟
    r.maxAlternatives = 1;

    let final = '', done = false;
    const mine = () => this.rec === r;
    // 收尾只做一次。onend、強制結束、卡住偵測三條路都可能走到這裡，
    // 而且舊的辨識器事件可能晚到——一律以 done 與 mine() 擋掉。
    const settle = why => {
      if (done) return;
      done = true;
      this._clearTimers();
      if (mine()) this.rec = null;
      this._set('idle');
      const t = final.trim();
      if (t) { this.lastFinalAt = performance.now(); this.onFinal?.(t); }
      else if (why === 'stalled') this.onStall?.();
      else if (why === 'empty') this.onEmpty?.();
    };
    const arm = () => {
      clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => {
        if (done || !mine()) return;
        try { r.abort(); } catch { /* ignore */ }
        settle('stalled');
      }, TIMING.stall);
    };
    // 要求結束後若 onend 遲遲不來，就自己收尾（部分手機會漏掉 onend，
    // 原本整個回合就永遠送不出去，只能等使用者自己發現再按）
    const forceEnd = () => {
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => {
        if (done) return;
        try { r.abort(); } catch { /* ignore */ }
        settle(final.trim() ? 'forced' : 'empty');
      }, TIMING.end);
    };

    r.onresult = e => {
      if (done || !mine()) return;
      arm();
      let all = '', fin = '', allFinal = true;
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        all += t;
        if (e.results[i].isFinal) fin += t; else allFinal = false;
      }
      final = fin;
      this.onPartial?.(all);
      if (fin.trim() && allFinal) {
        try { r.stop(); } catch { /* ignore */ }
        forceEnd();
      }
    };
    r.onerror = e => {
      if (done || !mine()) return;
      // 沒聽到聲音不是錯誤——等 onend 把這一輪收掉（onend 不來就由 forceEnd 收）
      if (e.error === 'no-speech' || e.error === 'aborted') { forceEnd(); return; }
      this.onState?.('error:' + e.error);
      settle('error');                 // 權限、硬體問題：不自動重試，免得無限迴圈
    };
    r.onend = () => { if (done || !mine()) return; settle(final.trim() ? 'end' : 'empty'); };

    try { r.start(); } catch { this._set('idle'); return false; }
    this.rec = r; this._set('listening');
    arm();
    return true;
  }

  _clearTimers() { clearTimeout(this.stallTimer); clearTimeout(this.endTimer); }

  stopListening() { try { this.rec?.stop(); } catch { /* ignore */ } }
  abortListening() {
    this._clearTimers();
    const r = this.rec; this.rec = null;           // 先放掉所有權，舊事件晚到也會被擋
    try { r?.abort(); } catch { /* ignore */ }
    if (this.state === 'listening') this._set('idle');
  }

  speak(text, hint = {}) {
    return new Promise(resolve => {
      if (!supported.tts || !text) return resolve();
      speechSynthesis.cancel();
      // 朗讀引擎有時會卡在「暫停」狀態（iOS／Chrome 都見過），先解除
      try { speechSynthesis.resume(); } catch { /* ignore */ }
      // 依標點切句 → 逐句送出，降低第一個字發聲的延遲
      const parts = text.split(/(?<=[。！？!?，,；;])/).filter(s => s.trim());
      let left = parts.length, fin = false, started = false, idle = 0;
      this._set('speaking');
      const finish = () => {
        if (fin) return; fin = true;
        clearTimeout(guard); clearTimeout(startGuard); clearInterval(poll);
        this._set('idle'); resolve();
      };
      // 主要判斷：輪詢朗讀引擎的實際狀態。部分手機播完不觸發 onend，
      // 原本只能等下面那個保險絲——50 字的回覆要白等 16 秒才會開麥克風。
      // 連續兩次（約 0.6 秒）都是閒置才算播完，避免句與句之間的空檔被誤判。
      const poll = setInterval(() => {
        if (!started) return;
        const quiet = !speechSynthesis.speaking && !speechSynthesis.pending && !speechSynthesis.paused;
        idle = quiet ? idle + 1 : 0;
        if (idle >= 2) finish();
      }, TIMING.poll);
      // 一直沒開始播放（靜音、語音引擎壞了）→ 放行，客戶的話已經顯示在畫面上
      const startGuard = setTimeout(() => { if (!started) finish(); }, TIMING.start);
      // 最後一道保險絲：整段的最長時間
      const guard = setTimeout(finish, 3000 + text.length * 260);

      parts.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = 'zh-TW';
        if (this.voice) u.voice = this.voice;
        u.rate = hint.rate ?? 1.0;
        u.pitch = hint.pitch ?? 1.0;
        // 只在第一句真正開始播放時記一次——這才是使用者感知到的「客戶開口」
        u.onstart = () => {
          idle = 0;
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

  reset() { this.abortListening(); this._clearTimers(); this.stopSpeaking(); this._set('idle'); this.lastFinalAt = 0; }
  resetStats() { this.latencies = []; this.lastFinalAt = 0; }
}
