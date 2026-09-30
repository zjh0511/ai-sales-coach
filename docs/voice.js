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
  cloudFirst: 4000, // 雲端語音這麼久還沒有第一段聲音 → 放棄，改用內建朗讀
  jitter: 0.25,   // 雲端語音先累積這麼多秒再開始播，避免開頭因網路抖動斷音
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
    // 雲端語音（Gemini TTS）。由 app.js 注入 { stream(text, gender, signal) }，
    // 這裡不碰金鑰——Voice Engine 保持與服務商無關，可以整檔替換。
    this.cloud = null;
    this.cloudOffUntil = 0;          // 失敗冷卻到這個時間點前，直接用內建朗讀
    this.speakTok = 0;               // 每次朗讀／打斷就 +1，用來分辨「被打斷」與「失敗」
    if (supported.tts) {
      const load = () => { this.voice = pickVoice(); };
      load(); speechSynthesis.onvoiceschanged = load;
    }
  }

  _set(s) { this.state = s; this.onState?.(s); }

  // 必須在使用者手勢中呼叫一次（iOS 音訊解鎖）
  unlock() {
    // 雲端語音用 Web Audio 播放。iOS 規定 AudioContext 必須在使用者手勢中啟動，
    // 而且接電話、切 App 之後會被暫停——所以每次手勢都要再叫醒一次，不只第一次。
    try { const c = this._ctx(); if (c && c.state !== 'running') c.resume(); } catch { /* ignore */ }
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

  // 朗讀。有設定雲端語音（Gemini）就先用它；任何原因失敗——沒有金鑰、額度用完、
  // 網路不穩、服務商塞車、第一段聲音遲遲不來——都退回手機內建朗讀，演練不中斷。
  // 但使用者自己插話打斷的，不算失敗，不能再用內建朗讀把同一句念一次。
  async speak(text, hint = {}) {
    if (!text) return;
    this.stopSpeaking();
    const tok = this.speakTok;
    if (this._cloudUsable()) {
      const played = await this._speakCloud(text, hint, tok);
      if (played || tok !== this.speakTok) return;
    }
    if (tok !== this.speakTok) return;
    await this._speakDevice(text, hint);
  }

  // ── 雲端語音（Gemini TTS）──────────────────────────────────
  _cloudUsable() {
    return !!this.cloud && Date.now() > this.cloudOffUntil && !!(this._ctx());
  }

  _ctx() {
    if (this.actx) return this.actx;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    try { this.actx = new AC(); } catch { return null; }
    return this.actx;
  }

  // 雲端語音失敗時要冷卻多久。每回合都先撞一次再退回，會讓每句話都多等好幾秒。
  _cloudFailed(e) {
    const m = String(e?.message || e);
    this.cloudFails = (this.cloudFails || 0) + 1;
    const off = /\b429\b|quota|RESOURCE_EXHAUSTED/i.test(m) ? 10 * 60 * 1000   // 額度用完
      : /\b40[34]\b/.test(m) ? 24 * 60 * 60 * 1000                               // 這把金鑰不能用這個模型
      : this.cloudFails >= 2 ? 3 * 60 * 1000                                     // 連續失敗（塞車、網路）
      : 0;
    if (off) this.cloudOffUntil = Date.now() + off;
    this.onState?.('tts-fallback');
  }

  // 回傳 true：已經播出聲音（或被使用者打斷）；false：一個字都沒播，呼叫端該退回內建朗讀。
  async _speakCloud(text, hint, tok) {
    const ctx = this._ctx();
    if (!ctx) return false;
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch { /* ignore */ } }
    if (ctx.state !== 'running') return false;       // 沒在使用者手勢中解鎖過，iOS 不給播

    // iOS 用 Web Audio 播放的聲音，在「靜音開關」打開時會被消音（內建朗讀不會）。
    // 播放期間把音訊通道切成「媒體播放」，播完再切回自動，免得影響之後的收音。
    // 需要 Safari 16.4 以上；不支援的環境這兩行什麼都不做。
    const session = globalThis.navigator?.audioSession;
    const prevType = session?.type;
    try { if (session) session.type = 'playback'; } catch { /* ignore */ }

    const ac = new AbortController();
    this.cloudAbort = ac;
    const sources = [];
    this.cloudSources = sources;
    this._set('speaking');

    let next = 0, started = false, pending = [], pendingLen = 0, rate = 24000;
    // 第一段聲音太久沒來就放棄，改用內建朗讀——使用者寧可聽機器聲，也不要乾等
    const firstTimer = setTimeout(() => { if (!started) ac.abort(); }, TIMING.cloudFirst);

    const schedule = f32 => {
      const b = ctx.createBuffer(1, f32.length, rate);
      b.copyToChannel(f32, 0);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, next);
      s.start(at);
      next = at + b.duration;
      sources.push(s);
      if (!started) {
        started = true;
        clearTimeout(firstTimer);
        if (this.lastFinalAt) {          // 「客戶開口」的那一刻，和內建朗讀用同一個量法
          this.latencies.push(Math.round(performance.now() - this.lastFinalAt + (at - ctx.currentTime) * 1000));
          this.lastFinalAt = 0;
        }
      }
    };
    const flush = () => {
      if (!pendingLen) return;
      const all = new Float32Array(pendingLen);
      let o = 0;
      for (const p of pending) { all.set(p, o); o += p.length; }
      pending = []; pendingLen = 0;
      schedule(all);
    };
    const restore = () => { try { if (session) session.type = prevType || 'auto'; } catch { /* ignore */ } };

    try {
      for await (const chunk of this.cloud.stream(text, hint.gender, ac.signal, hint)) {
        if (tok !== this.speakTok) break;
        rate = chunk.rate;
        const f32 = new Float32Array(chunk.pcm.length);
        for (let i = 0; i < f32.length; i++) f32[i] = chunk.pcm[i] / 32768;
        // 串流每段只有約 70ms。先累積一小段再開始播，避免一開頭就因網路抖動而斷音；
        // 開始之後就一段接一段排進時間軸，前後剛好接上，不會有縫。
        if (!started) {
          pending.push(f32); pendingLen += f32.length;
          if (pendingLen / rate >= TIMING.jitter) flush();
        } else {
          schedule(f32);
        }
      }
      if (tok === this.speakTok) flush();       // 很短的句子：串流結束時還沒湊滿緩衝
    } catch (e) {
      clearTimeout(firstTimer);
      if (tok !== this.speakTok) { restore(); return true; }      // 使用者打斷，不是失敗
      if (!started) { this._stopSources(); restore(); this._cloudFailed(e); return false; }
      // 播到一半才斷：已經排進時間軸的讓它播完，客戶的話也已經顯示在畫面上
    }
    clearTimeout(firstTimer);
    if (tok !== this.speakTok) { restore(); return true; }
    if (!started) { restore(); this._cloudFailed(new Error('tts no audio')); return false; }

    this.cloudFails = 0;
    // 等最後一段播完。用時間軸算，不依賴 onended（被 stop() 時各瀏覽器行為不一）
    await new Promise(res => {
      this.cloudDone = res;
      this.cloudTimer = setTimeout(res, Math.max(0, next - ctx.currentTime) * 1000 + 120);
    });
    this.cloudDone = null;
    restore();
    if (tok === this.speakTok) this._set('idle');
    return true;
  }

  _stopSources() {
    for (const s of this.cloudSources || []) { try { s.stop(); } catch { /* 已經播完 */ } }
    this.cloudSources = [];
  }

  // ── 手機內建朗讀 ────────────────────────────────────────────
  _speakDevice(text, hint) {
    return new Promise(resolve => {
      if (!supported.tts) return resolve();
      speechSynthesis.cancel();
      // 朗讀引擎有時會卡在「暫停」狀態（iOS／Chrome 都見過），先解除
      try { speechSynthesis.resume(); } catch { /* ignore */ }
      // 只在句尾切段，不在逗號切。原本在逗號也切，每一段都被當成完整句子念——
      // 每個逗號都變成句尾降調＋停頓，聽起來像在唸清單，是機械感的主因之一。
      const parts = text.split(/(?<=[。！？!?])/).filter(s => s.trim());
      let left = parts.length, fin = false, started = false, idle = 0;
      this._set('speaking');
      const finish = () => {
        if (fin) return; fin = true;
        clearTimeout(guard); clearTimeout(startGuard); clearInterval(poll);
        if (this.state === 'speaking') this._set('idle');
        resolve();
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
      this.deviceFinish = finish;

      parts.forEach((p, i) => {
        const u = new SpeechSynthesisUtterance(p);
        u.lang = 'zh-TW';
        if (this.voice) u.voice = this.voice;
        // 語速只做小幅調整；音高固定。瀏覽器改音高是粗糙的訊號處理，
        // 偏離 1.0 就更像機器（原本人設會隨機給 0.8～1.2）。
        u.rate = Math.min(1.15, Math.max(0.9, Number(hint.rate) || 1));
        u.pitch = 1;
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
    this.speakTok = (this.speakTok || 0) + 1;       // 讓進行中的朗讀知道自己被打斷了
    this.cloudAbort?.abort(); this.cloudAbort = null;
    this._stopSources();
    clearTimeout(this.cloudTimer); this.cloudDone?.(); this.cloudDone = null;
    if (supported.tts) speechSynthesis.cancel();
    this.deviceFinish?.(); this.deviceFinish = null;
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
