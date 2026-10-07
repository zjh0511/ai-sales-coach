// 串流播報：一邊生成、一邊開口。
//
// 為什麼需要這一層（本機模型體驗的關鍵）：
//   iPad 上 Qwen3-4B 每回合要 3,525 ms 才生成完，但首 token 只要 2,434 ms 就到了。
//   如果等全部生成完才開口，使用者感受到的延遲是 3.5 秒；
//   如果第一句一出現就開口，感受到的是「客戶開始說話」的時間。
//
//   **語音對練裡使用者感知的延遲是「對方何時開始說話」，不是「何時說完」。**
//   規格 §29 的 2 秒目標應該用前者衡量。
//
// 沿用 voice.js 已經付過代價的兩個教訓（handbook §4.5）：
//   ・iOS 必須在使用者手勢中先解鎖一次 speechSynthesis，否則之後 speak() 不會出聲
//   ・iOS 的 onend 偶爾不觸發，所以任何「等播完」的流程都要有保險絲逾時
//
// ⚠ 送進來的文字必須已經清洗過。
//   這裡不做任何內容清理——清理由 prompts.small.js 的 SayStream 在串流途中完成，
//   目的是讓「唸出來的」與「畫面顯示的」是同一份文字。
//   若在這裡再清一次，就又變成兩個清洗器各自有結果，那正是「對不上」的來源。

// 句子邊界。中文標點為主，並允許逗號——
// 逗號切得比較碎，但「早一點開口」比「句子完整」重要。
const BOUNDARY = /[。！？!?…；;，,]/;

// 第一句刻意用較寬的條件：只要有標點就送，或累積到一定長度也送。
// 目的是把「開始說話」的時間壓到最短。
const FIRST_MIN_CHARS = 4;
const LATER_MIN_CHARS = 8;
const FORCE_CHARS = 24;          // 一直沒有標點時的強制斷點

// 「完全沒開口」的判定時限。
//
// 為什麼是 2,600 ms 而不是原本的 1,200 ms：
//   iPad 實測首次發聲是 765 ms，1,200 ms 只留下 435 ms 餘裕。
//   稍微慢一點，救援就會在語音**正常但較慢**的情況下誤觸發。
//   這個保險絲要對付的是「整段完全不出聲」，那種情況等 2.6 秒完全沒差；
//   誤觸發的代價卻是真的把好好的語音打斷。所以寧可晚一點、不要誤判。
const FIRST_SPEECH_TIMEOUT = 2600;

// 挑語音。優先順序刻意把「加強版」放最前面：
// iOS 預設給 Web Speech 的是壓縮版語音，實機聽起來明顯是機器聲。
// 使用者在「設定 → 輔助使用 → 旁白 → 語音 → 中文」下載加強版之後，
// 那個語音就會出現在 getVoices() 裡，音質差距很大。
export function pickVoice(lang = 'zh-TW') {
  const vs = speechSynthesis.getVoices();
  const zhTW = vs.filter(v => v.lang === lang || /zh[-_]TW|Hant/i.test(v.lang));
  const better = /enhanced|premium|加強|優化|siri/i;
  return zhTW.find(v => better.test(v.name))
    || zhTW[0]
    || vs.find(v => /^zh/i.test(v.lang))
    || null;
}

export class StreamSpeaker {
  constructor({ lang = 'zh-TW', rate = 1.0, onFirstSpeech = null, onDone = null } = {}) {
    this.lang = lang;
    this.rate = rate;
    this.onFirstSpeech = onFirstSpeech;   // 第一句「真正開始播放」時呼叫（用 utterance.onstart）
    this.onDone = onDone;
    this.buf = '';
    // 已經送去播放的段落。記著它們是為了救援時能重送**全部還沒播完的段落**，
    // 而不是只重送第一段（那會讓使用者只聽到第一句話）。
    this.segments = [];
    this.spokeFirst = false;
    this.flushed = false;
    this._retried = false;
    this.voice = pickVoice(lang);
    this.supported = 'speechSynthesis' in window;
    if (this.supported && !this.voice) {
      // iOS 的語音清單是非同步載入的，第一次拿常常是空的
      speechSynthesis.onvoiceschanged = () => { this.voice = this.voice || pickVoice(lang); };
    }
  }

  // 必須在使用者手勢中呼叫一次（iOS 音訊解鎖）。
  // 用音量 0 的空白語句，使用者聽不到。
  unlock() {
    if (!this.supported || this._unlocked) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.lang = this.lang;
    speechSynthesis.speak(u);
    this._unlocked = true;
  }

  reset() {
    if (this.supported) speechSynthesis.cancel();
    this.buf = '';
    this.segments = [];
    this.spokeFirst = false;
    this.flushed = false;
    this._retried = false;
  }

  // 餵入串流片段。內部只在「切出完整的一段」時才送去播放。
  push(delta) {
    if (!this.supported || !delta) return;
    this.buf += delta;
    for (;;) {
      const piece = this._take();
      if (!piece) break;
      this._speak(piece);
    }
  }

  // 生成結束：把剩下的送出去
  flush() {
    if (!this.supported) return;
    this.flushed = true;
    const rest = this.buf.trim();
    this.buf = '';
    if (rest) this._speak(rest);
    // 完全沒有東西可播的情況（例如輸出被清空），也要通知呼叫端
    if (!this.segments.length) this.onDone?.();
    else this._checkDone();
  }

  cancel() { if (this.supported) speechSynthesis.cancel(); }

  // 從緩衝區切出可以立刻播放的一段；切不出來就回傳空字串
  _take() {
    const min = this.spokeFirst || this.segments.length ? LATER_MIN_CHARS : FIRST_MIN_CHARS;
    const s = this.buf;
    if (!s) return '';

    // 找第一個標點
    for (let i = 0; i < s.length; i++) {
      if (BOUNDARY.test(s[i]) && i + 1 >= min) {
        const piece = s.slice(0, i + 1);
        this.buf = s.slice(i + 1);
        return piece.trim();
      }
    }
    // 沒有標點但已經很長：強制斷，避免一直不開口
    if (s.length >= FORCE_CHARS) {
      const piece = s.slice(0, FORCE_CHARS);
      this.buf = s.slice(FORCE_CHARS);
      return piece.trim();
    }
    return '';
  }

  _speak(text) {
    const seg = { text, done: false };
    this.segments.push(seg);
    this._enqueue(seg);

    // 保險絲一：iOS 偶發暫停（handbook §4.5）
    setTimeout(() => {
      try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch { /* 忽略 */ }
    }, 250);

    // 保險絲二只掛在**第一段**上。
    //
    // 原本掛在每一段上，而救援會呼叫 speechSynthesis.cancel()——
    // 那會取消**整個佇列**，包括還沒播的第二、三段，然後只重送觸發它的那一段。
    // 結果是使用者只聽到第一句話，畫面卻顯示完整的一段。
    // 這正是 iPad 上「說的話跟出現的文字對不上」的第二個原因。
    if (this.segments.length === 1) {
      setTimeout(() => this._rescue(), FIRST_SPEECH_TIMEOUT);
    }
  }

  _enqueue(seg) {
    const u = new SpeechSynthesisUtterance(seg.text);
    u.lang = this.lang;
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;

    u.onstart = () => {
      if (!this.spokeFirst) {
        this.spokeFirst = true;
        this.onFirstSpeech?.();          // ← 這是我們要量的那個時間點
      }
    };
    const done = () => { seg.done = true; this._checkDone(); };
    u.onend = done;
    u.onerror = done;

    speechSynthesis.speak(u);
  }

  // 完成判定改成「以段落為單位」，不用計數器。
  // 救援會重新排入同一個段落，計數器在那種情況下會算錯。
  _checkDone() {
    if (this.flushed && this.segments.length && this.segments.every(s => s.done)) this.onDone?.();
  }

  // 救援：整段完全沒有開口過。
  //
  // iPad 實測（2026-08-20）第三輪整段沒有發聲，onstart 也沒有觸發——
  // 已知的 iOS speechSynthesis 卡住現象（連續 cancel／speak 之後）。
  // 語音產品不能「靜靜地不出聲」，所以重送一次。
  //
  // 重點：重送的是**所有還沒播完的段落**，而且維持原本的順序。
  // 只重送一段會讓內容缺一半，比不出聲更難理解。
  // 只救援一次：重複救援會讓使用者聽到疊在一起的聲音。
  _rescue() {
    if (this.spokeFirst || this._retried) return;
    const pending = this.segments.filter(s => !s.done);
    if (!pending.length) return;
    this._retried = true;
    try {
      speechSynthesis.cancel();
      for (const seg of pending) this._enqueue(seg);
    } catch { /* 重送也失敗就放棄，由呼叫端顯示「沒有發聲」 */ }
  }
}
