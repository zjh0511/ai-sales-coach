// 本機模型的 Gateway ——「長得像雲端 adapter 的物件」。
//
// 為什麼用這個形狀：
//   session.js 只透過一個方法跟外界說話：`gw.generate(prompt, opts)`。
//   只要提供同名同形狀的方法，整台狀態機（INTAKE → READY → ROLEPLAY → COMPLETED
//   → FEEDBACK_READY）、合規攔截、卡住偵測、信任度夾定、結束條件判定
//   **一行都不用改**。session.js／prompts.js／compliance.js 維持紅線不動。
//
// 三種呼叫的分工（量測結果決定的，不是偏好）：
//   建立人設   → 程式組裝（personas.js）。雲端版要 4,000 token JSON，4B 要跑三四分鐘。
//   每回合對話 → 呼叫模型。這是唯一一處，也是本機模型真正不可取代的地方。
//   評分回饋   → 程式計算（evaluate-local.js）。雲端版要 8,000 token JSON。
//   痛點分析   → 程式組裝。原型本身就帶著痛點與異議，比 4B 即興生成的更貼近現場。
//
// 換句話說：**模型只做即時的語言生成，其餘全部由程式負責。**
// 這是整個量測階段最重要的結論——小模型做結構化長輸出會塌掉，
// 但做「接下來這位客戶會說的一句話」表現得很好（iPad 感知延遲 0.77 秒）。

import { roleplayRawPrompt, rawStops, SHOT_LINES, SayStream } from '../prompts.small.js';
import { turnSignals } from '../scoring/turn-signals.js';
import { evaluateLocal } from '../scoring/evaluate-local.js';
import { buildPersona, hiddenWithKeywords, matchArchetype, seedOf, trimTail } from './personas.js';
import { GgufRuntime } from './runtime-gguf.js';

// 一回合最多重試幾次。
// 攔截到跳出角色就重抽，但不能無限重抽——每次都要 3.5 秒，
// 使用者等兩次已經是體驗的極限。第三次就用 session.js 的保底句。
const MAX_TRIES = 2;

export class LocalGateway {
  constructor({ model = 'qwen3-4b-gguf', dtype = 'q3', runtimeOpts = {} } = {}) {
    this.provider = 'local';
    this.modelKey = model;
    this.dtype = dtype;
    this.rt = new GgufRuntime(runtimeOpts);
    this.onEvent = null;

    // 串流播報用。app.js 設 onDelta，就能一邊生成一邊送去 TTS。
    // session.js 完全不知道有這件事——它只是在 await 一個 Promise。
    this.onDelta = null;
    this.onStreamAbort = null;      // 前綴守門攔截時通知呼叫端把已說出的話取消
    // 呼叫端提供：「這一回合的語音已經真的出聲了嗎」。
    // 決定軟性缺陷該不該取消重講——已經在唸了就不打斷。
    this.hasSpoken = null;

    // api.js 在呼叫 session.js 之前設定的側通道。
    // 本機版需要的是「結構化輸入」，不是渲染好的雲端提示詞——
    // 關鍵字（隱藏需求的判定依據）刻意不放進提示詞，所以拿不到 persona 就算不出訊號。
    this._kind = null;
    this._session = null;

    this.lastSignals = null;        // 給 UI 顯示這一回合程式判定了什麼
    this.label = '';
  }

  // ── 雲端 adapter 的介面表面 ────────────────────────────────────
  get fast() { return this.label || this.modelKey; }
  get judge() { return this.label || this.modelKey; }
  get supportsFile() { return false; }   // 本機沒有雲端的文件解析能力

  async init(onProgress = null) {
    const { plan } = await this.rt.plan_(this.modelKey);
    if (this.dtype && this.dtype !== plan.dtype) plan.dtype = this.dtype;
    this.label = `${plan.label}（${plan.dtype}）`;
    const { ms } = await this.rt.load(onProgress);
    this.loadMs = ms;
    return this;
  }

  // 暖身：把 shader 編譯與前綴 KV 的一次性成本挪到使用者開始說話之前。
  // 實測差 20 倍（不暖身首 token 6,998 ms，暖身後 351 ms），所以這不是選項。
  async warmup(persona, mode = 'call', context = 'cold') {
    const prompt = roleplayRawPrompt(persona, mode, context, {
      history: [], userText: '您好', trust: 70, guidance: 0,
      difficulty: 1, maxGuidance: 5, canEnd: false,
    });
    return this.rt.warmup(prompt);
  }

  // 用「這一場真正會用到的提示詞前綴」暖身，並且不 await。
  //
  // 為什麼一定要做：實測不暖身的第一回合首 token 是 6,998 ms，暖身後 795 ms——差 20 倍。
  // 原因有兩個：WebGPU 的 shader 首次編譯，以及 llama.cpp 對相同前綴的 KV cache 重用。
  //
  // 為什麼要用「真正的」前綴：KV 重用只在前綴相同時發生。
  // 用一段隨便的文字暖身只付掉 shader 編譯，省不到 prefill。
  //
  // 為什麼不 await：呼叫點是「開始演練」，那時客戶的開場白正在播語音（約 2 秒），
  // 暖身（約 6 秒）剛好躲在使用者聽開場白與思考第一句話的時間裡。
  warmupFor(session) {
    if (!session?.persona) return;
    const prompt = roleplayRawPrompt(session.persona, session.mode, session.context, {
      history: [], userText: '您好', trust: session.trust, guidance: 0,
      difficulty: session.difficulty, maxGuidance: session.maxGuidance, canEnd: session.canEnd,
    });
    this._warming = this.rt.warmup(prompt).catch(() => null);
  }

  pin() { return this.status(); }
  status() {
    return {
      provider: 'local',
      models: [{ id: this.modelKey, label: this.label, local: true }],
      recommended: [this.modelKey],
      pinned: this.modelKey,
      auto: { fast: this.modelKey, judge: this.modelKey },
      active: { fast: this.modelKey, judge: this.modelKey },
      cooling: [],
      local: { loadMs: this.loadMs, warmupMs: this.rt.warmupMs || null },
    };
  }

  abort() { this.rt.abort(); }
  async dispose() { return this.rt.dispose?.(); }

  // ── 側通道：api.js 在每次呼叫前告訴我們這是哪一種請求 ───────────
  useSession(kind, session = null) {
    this._kind = kind;
    this._session = session;
    this._streamedThisTurn = false;
  }

  // ── session.js／advisor.js 看到的唯一入口 ─────────────────────
  async generate(prompt, opts = {}) {
    const t0 = performance.now();
    const kind = this._kind || guessKind(opts);
    let text;

    switch (kind) {
      case 'persona':  text = JSON.stringify(this._persona()); break;
      case 'turn':     text = JSON.stringify(await this._turn(prompt, opts)); break;
      case 'evaluate': text = JSON.stringify(this._evaluate()); break;
      case 'pain':     text = JSON.stringify(this._pain()); break;
      default: {
        // 分類不出來就要直說。
        // 靜靜地把提示詞丟給 4B 只會得到一段看起來像答案的垃圾——
        // 那比明確的錯誤更難查（量測階段吃過這個苦）。
        const e = new Error('本機模型目前只支援角色扮演演練與痛點分析。理賠諮詢、行銷諮詢與文件解析需要雲端模型，請改用 API 金鑰登入。');
        e.localUnsupported = true;
        throw e;
      }
    }

    // 用完就清掉，避免下一次呼叫沿用上一次的分類（這種殘留最難查）
    this._kind = null;
    return { text, ms: Math.round(performance.now() - t0), model: this.modelKey };
  }

  // ── 人設：程式組裝 ────────────────────────────────────────────
  _persona() {
    const a = this._args || {};
    return buildPersona(a);
  }

  // api.js 把使用者填的條件先交給我們（session.js 不會轉手這些原始輸入）
  useArgs(args) { this._args = args || {}; }

  // ── 一回合對話：唯一呼叫模型的地方 ─────────────────────────────
  async _turn(_cloudPrompt, _opts) {
    const s = this._session;
    if (!s) throw new Error('local_turn_without_session');

    const persona = s.persona;
    const userText = s.lastUser || '';
    const history = s.history.filter(h => h.speaker !== 'system').slice(-8);
    const prevSays = s.history.filter(h => h.speaker === 'customer').map(h => h.text).slice(-4);

    // turnSignals 需要 {text, keywords}；persona 存的是兩個平行陣列
    // （hidden_needs 必須維持字串，app.js 是直接串字串顯示的）
    const personaForSignals = { ...persona, hidden_needs: hiddenWithKeywords(persona) };

    const turnArgs = {
      history, userText, trust: s.trust, guidance: s.guidance,
      difficulty: s.difficulty, maxGuidance: s.maxGuidance, canEnd: s.canEnd,
    };

    // 暖身可能還在跑（它是刻意不 await 的）。同一個 wllama 實例不能同時跑兩個生成，
    // 所以這裡等它結束——通常已經結束了，因為使用者還要聽開場白、還要打字。
    if (this._warming) { await this._warming; this._warming = null; }

    // session.js 自己也有一層重試：validateRoleplay 回 null（跳出角色）時它會再呼叫一次
    // generate。那一次會再串流一遍，如果不先取消，使用者會聽到兩段疊在一起的話。
    // api.js 每回合只呼叫 useSession 一次，所以這個旗標剛好對應「同一回合的第二次生成」。
    if (this._streamedThisTurn) this.onStreamAbort?.();
    this._streamedThisTurn = true;

    let best = null;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const raw = roleplayRawPrompt(persona, s.mode, s.context, turnArgs);

      // 前綴守門：一邊串流一邊檢查。
      //
      // 為什麼要在串流「途中」檢查而不是等生成完：
      //   串流的整個意義是「第一句一出現就開口說話」。等生成完才檢查就沒有串流了；
      //   完全不檢查就會把「我是業務員…」這種跳出角色的句子直接念給使用者聽。
      //   所以在前綴上跑那幾個便宜的正規表示式，攔到就停止送話並通知取消。
      let acc = '';
      let blocked = false;

      // 逐字清洗器：唸出去的、顯示的、最終的 say 全部來自這一個物件。
      //
      // 這是 iPad 實機回報「AI 說的話跟出現的文字對不上」的修法。
      // 原本 onDelta 直接把原始 delta 送去 TTS，而 cleanPlainSay 在生成結束後才跑，
      // 於是「（停頓）」「李先生：」這些會被清掉的東西都已經先唸出來了。
      const stream = new SayStream(persona.name);

      const onDelta = d => {
        acc += d;
        if (blocked) return;
        // 守門仍然看**原始**輸出：清洗器會把「李先生：」當格式雜訊砍掉，
        // 但「業務員：」是真的跳出角色，必須攔下來重抽而不是默默清掉。
        if (badPrefix(acc, persona.name)) {
          blocked = true;
          this.rt.abort();                 // 壞掉的續寫沒必要跑完
          this.onStreamAbort?.();
          return;
        }
        const safe = stream.push(d);        // 只吐出確定不會被清掉的字
        if (safe) this.onDelta?.(safe);
      };

      let r;
      try {
        r = await this.rt.generate([], {
          tier: 'roleplay',
          raw,
          stops: rawStops(persona.name),
          onDelta,                       // 守門即使沒有 TTS 也要跑：壞掉的續寫提早中止
          sampling: attempt === 0 ? null : { temperature: 0.6, top_p: 0.9 },
        });
      } catch (err) {
        if (blocked) { continue; }        // 我們自己中止的，重抽
        throw err;
      }

      // 若 onDelta 完全沒被呼叫（執行期不支援串流），改用回傳的整段文字餵進同一個清洗器，
      // 維持「唸出去的＝顯示的＝最終的」這個不變式。
      if (!acc && r.text) {
        const safe = stream.push(r.text);
        if (safe) this.onDelta?.(safe);
      }
      const tail = stream.end();
      if (tail && !blocked) this.onDelta?.(tail);

      // 最終的 say 就是清洗器吐出去的全部內容——**不再另外清洗一次**。
      // 兩段程式各自清洗就會有各自的結果，那正是「對不上」的來源。
      const say = stream.text.trim();
      const sig = turnSignals({
        modelJson: { say }, userText, persona: personaForSignals,
        difficulty: s.difficulty, prevSays, examples: SHOT_LINES,
      });

      // 攔截分兩級，依據是「重抽的代價會不會被聽見」。
      //
      // 問題出在時間差：語音在 0.77 秒就開口，但七項檢查要等生成結束（約 3.5 秒）才跑得完。
      // 所以生成結束後才攔截到問題時，話已經唸出去了——取消重講聽起來就是
      // 「唸一半突然停掉、換一句重講」，使用者回報的正是這個。
      //
      // 那為什麼不等驗證完再開口？因為感知延遲會從 0.77 秒變回約 3.5 秒，
      // 超過規格 §29 的 2 秒。串流不是效能微調，是這個產品能不能用的前提。
      //
      // 於是按「聽起來的傷害」分級：
      //
      //   硬性——會破壞角色或洩漏提示詞：自稱業務員、角色反轉、照抄示範句、照抄人設。
      //          **一定重抽，即使已經開口。** 讓使用者聽到「我是保險業務員」
      //          或聽到我們的提示詞被唸出來，比聽到一次卡頓嚴重得多。
      //
      //   軟性——只是品質不好：鸚鵡式重複、自我重複、句內重複。
      //          **只在還沒開口時才重抽。** 已經在唸了就讓它講完——
      //          客戶偶爾重複業務員的話還算像真人，唸一半被切斷不像。
      //          （旗標仍然記錄在 lastSignals 裡，不會因為不重抽就消失。）
      const hard = blocked || sig.wrongRole || sig.invertsRole || sig.copiesExample || sig.copiesPersona;
      const soft = sig.echo || sig.selfRepeat || sig.repeatsWithin;
      const spoke = !!this.hasSpoken?.();
      const bad = hard || (soft && !spoke);
      if (!best || !bad) best = { say, sig, blocked };
      if (!bad && !blocked && say) break;
      if (attempt === MAX_TRIES - 1) break;
      this.onStreamAbort?.();              // 要重抽，把已經說出去的取消掉
    }

    const sig = best?.sig || null;
    this.lastSignals = sig;

    // 結束訊號由程式判定，不問模型（D004）。
    // 條件：難度允許結束、信任度掉到很低、而且已經練了幾個回合。
    const userTurns = s.history.filter(h => h.speaker === 'user').length;
    const wantEnd = s.canEnd && userTurns >= 4
      && (s.trust + (sig?.trustDelta || 0) <= 15 || /(先這樣|不用了|我要掛|沒興趣|不要再打)/.test(best?.say || ''));

    // 回傳雲端版的 JSON 形狀。session.js 會自己 parseJson、validateRoleplay、
    // 夾定 trust、映射 revealed、判斷 ended——那些邏輯我們一點都不想重寫。
    return {
      say: best?.say || '',              // 空字串 → session.js 用它的保底句
      trust_delta: sig?.trustDelta || 0,
      revealed: sig?.revealed || [],
      end: wantEnd,
    };
  }

  // ── 評分：程式計算 ────────────────────────────────────────────
  _evaluate() {
    const s = this._session;
    if (!s) throw new Error('local_evaluate_without_session');
    const transcript = s.history.filter(h => h.speaker !== 'system');
    const userTurns = transcript.filter(h => h.speaker === 'user');
    const texts = userTurns.map(t => t.text || '');
    const metrics = {
      turns: userTurns.length,
      avgLen: userTurns.length ? Math.round(texts.join('').length / userTurns.length) : 0,
      fillers: (texts.join('').match(/嗯|呃|那個|就是說|然後|欸/g) || []).length,
      repeats: texts.length - new Set(texts).size,
      stuck: s.stuck,
      finalTrust: s.trust,
      durationSec: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
      revealed: [...s.revealed],
    };
    return evaluateLocal({
      persona: s.persona, transcript, metrics,
      violations: s.violations, mode: s.mode, context: s.context, difficulty: s.difficulty,
    });
  }

  // ── 痛點分析：程式組裝 ────────────────────────────────────────
  // 原型本身就帶著三個隱藏需求，每一個都附了「為什麼推測」「可能需求」「怎麼問」，
  // 那正是痛點分析要的東西——所以這裡只是換一個形狀輸出，不需要模型。
  //
  // ⚠ 2026-08-21 實機事故：使用者填「約 40 歲的家庭主婦、單薪、女兒上幼兒園」，
  //   輸出的痛點卻是「公司貸款、沒人接手工廠、人情保單」（小工廠老闆的內容），
  //   而且三點的「推測原因」一模一樣、句子還是壞的。
  //   兩個原因：關鍵字比對全部沒中就退回雜湊亂挑；以及原因是用一句樣板套出來的。
  //   現在比對不到會用通用原型並**明說**，而原因來自每個痛點自己的 why。
  _pain() {
    const { gender = '', age = '', background = '' } = this._args || {};
    const seed = seedOf(`${gender}|${age}|${background}`);
    const { archetype: a, weak, also } = matchArchetype({ background, age, seed });
    const bg = trimTail(background) || a.background;
    // 年齡只在背景描述裡「沒提到」時才補上。
    // 使用者常常把年齡寫進背景（「約 40 歲的家庭主婦…」），
    // 再補一次就會變成「推測約 40 歲的約 40 歲的家庭主婦」。
    const ageNum = String(age).match(/\d+/)?.[0];
    const ageInBg = ageNum && bg.includes(ageNum);
    const who = ageNum && !ageInBg ? `約 ${ageNum} 歲的${bg}` : bg;

    return {
      profile: weak
        ? `注意：以下是通用方向，不是針對您填的背景做的比對。「${bg}」`
          + '沒有對應到系統內建的典型情境，所以請把這三點當成起點而不是結論，靠提問確認。'
        : `推測${who}，目前的重心在家庭責任與收入的穩定性上。`
          + '以下三點都是推測，不是已知的事實，需要靠提問確認。'
          // 背景同時提到兩種身分時要說出來——那兩組的重點不一樣，兩邊都該問。
          + (also ? `

另外：您填的背景同時提到「${also.background}」這一類的情境，`
            + '那一組客戶在意的事會不一樣（例如' + also.hidden[0].text + '）。'
            + '如果實際狀況是那一種，建議兩邊都問一下。' : ''),
      points: a.hidden.map(h => ({
        pain: h.text,
        reason: h.why,
        need: h.need,
        question: h.ask,
      })),
      approach: {
        channel: a.pressure === 'high'
          ? '這類客戶時間零碎，建議先用訊息約時間，通話控制在三分鐘以內，避開上班與接送小孩的時段。'
          : a.pressure === 'low'
            ? '這類客戶願意聊，可以直接電話聯繫，時間不必壓得太短，但要準備好具體的下一步。'
            : '可以直接電話聯繫，晚上七點到九點較容易講得完整。',
        // ⚠ 開場刻意不放稱謂。
        //   痛點分析階段我們不知道對方的姓，而「這位先生您好」不是真人會講的話。
        //   實機也踩到：使用者填「家庭主婦」但性別欄位留在預設值，
        //   就組出了「這位先生您好」——猜錯稱謂比不猜更糟。
        //   業務員自己會把名字加進去，這裡只給句型。
        opening: '您好，不好意思打擾您一下，我是做保險規劃的。'
          + '我今天不是要跟您談商品，只想用兩分鐘跟您確認一件事，聽完您覺得沒需要，我就不再打擾，這樣可以嗎？',
        avoid: '開頭記得換成對方真正的稱謂（例如「陳小姐您好」），這裡只給句型。'
          + '不要一開口就講出上面那三個推測——那是要靠提問確認的，直接說出來會讓對方覺得被調查。'
          + `也不要提到保額、保單或收入數字。這位客戶最可能的拒絕是：${a.objections.join('、')}。`,
      },
    };
  }
}

// ── 前綴守門：在串流途中就能判斷的壞徵兆 ────────────────────────
// 只放便宜且不會誤判的規則。完整的六項檢查在生成結束後由 turnSignals 做。
function badPrefix(acc, name) {
  const s = acc.trim();
  if (!s) return false;
  if (/^(業務員|我是業務|好的|以下是|作為|身為|根據)/.test(s)) return true;
  // ⚠ 這裡刻意**不**攔「李先生：」這種自己把名字又寫一次的情況。
  //   那是格式雜訊，SayStream 會直接砍掉；為它重抽一次要多等 3.5 秒，不值得。
  //   「業務員：」則相反——那是真的跳出角色，由上面那一條攔下。
  if (/我是.{0,6}(業務|保險業務|理財顧問|規劃師)/.test(s)) return true;
  if (/我們(公司)?的?(產品|方案|商品)/.test(s)) return true;        // 角色反轉
  return false;
}
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 沒有側通道時的退路。
// 依 session.js 與 advisor.js 實際傳的參數分辨：
//   評分   tier:'judge' 且 max 很大
//   對話   有 system（roleplaySystem）
//   人設   json 且 max 4000
// 這是退路而不是主要機制——主要機制是 api.js 明確呼叫 useSession()。
function guessKind(opts = {}) {
  if (opts.tier === 'judge' && (opts.max || 0) >= 8000) return 'evaluate';
  if (opts.system) return 'turn';
  if (opts.json && (opts.max || 0) >= 4000) return 'persona';
  return null;
}

export { guessKind, badPrefix };
