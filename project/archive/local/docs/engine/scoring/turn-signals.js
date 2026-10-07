// 每回合的確定性訊號 —— 把「數字」從模型手上收回程式。
//
// 為什麼要有這一層（L1-a 實測依據）：
//   壓縮提示詞之後，Qwen3.5-0.8B 已經能穩定輸出四個欄位（5／5），但**數字全是假的**：
//     ・trust_delta 五回合都填 0（照抄示範值），信任度完全不動 → 難度系統失效
//     ・revealed 五回合都是 []，隱藏需求 0／3 → D009 的編號機制形同不存在
//
//   這不是提示詞寫得不好，是**要求錯了對象**。0.8B 不會評估「這句話讓我更信任嗎」，
//   它只會複製看到的格式。handbook §9.3 第 15 條已經寫過：
//   「若某個參數很重要，就不要只用提示詞描述它。」
//
// 所以本模組把 D025（評分由程式計算）的原則往前推到**每一回合**：
//   模型負責「說什麼」（它擅長），程式負責「這一回合發生了什麼」（可量測）。
//
// 兩層防護（handbook §2.7）：模型仍然可以回報 trust_delta 與 revealed，
// 但程式的判定優先，且程式偵測到的 reveal 會與模型回報的取聯集。

import { checkCompliance } from '../compliance.js';

// ── 中文近似比對：用 2-gram 交集 ────────────────────────────────
//
// 沒有分詞器可用（也不想為此引入一個），但我們要判斷的都是「兩段話是不是在講同一件事」，
// 2-gram（相鄰兩字）的交集比例對這件事已經足夠，而且完全確定性、可測試。
const bigrams = s => {
  const t = String(s || '').replace(/[\s，。！？、；：「」『』（）\.,!?"'()]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

const overlap = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size);
};

// 功能字。兩個字都是功能字的 2-gram（例如「就是」「可以」「什麼」）幾乎出現在任何句子裡，
// 拿它們算主題相似度只會製造誤判，所以計數時排除。
const FUNC = new Set([...'的了是我你您有在不就都會要跟和很也沒嗎呢啊吧那這個什麼怎以可到說去他她們一二三好對還而且但因所如果天上下來個把被讓對於']);
const weak = g => FUNC.has(g[0]) && FUNC.has(g[1]);

// 共同的「實詞 2-gram」個數。
//
// 為什麼用個數而不是比例：實測發現業務員會換句話說——
//   隱藏需求：「擔心自己萬一倒下，女兒的生活費與學費沒人接手」
//   業務員問：「如果哪一天您身體不舒服沒辦法工作，女兒的學費怎麼辦？」
// 兩句講的是同一件事，但比例只有 0.14（被兩句的長度稀釋掉），
// 用比例判斷會漏掉這種**最重要的命中**。共同實詞的個數對長度不敏感，更貼近「有沒有講到同一件事」。
const sharedTerms = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  let hit = 0;
  for (const g of A) if (B.has(g) && !weak(g)) hit++;
  return hit;
};

// ── 一、鸚鵡式重複 ──────────────────────────────────────────────
//
// 實測症狀：客戶回「您說您想跟您介紹一下我們的新商品？」——把業務員的句子原樣丟回。
// 提示詞已經寫了「不要重複對方剛說過的話」，模型照樣做。所以改由程式攔，攔到就重新生成。
export function isEcho(say, userText, threshold = 0.45) {
  return overlap(say, userText) >= threshold;
}

// ── 一之二、跟自己前幾回重複 ────────────────────────────────────
//
// 實測（L1-a 第二輪）：0.8B 在低溫下會鎖進同一句台詞，五回合講幾乎一樣的話。
// 這比重複對方的話更糟——使用者會覺得「壞掉的錄音機」，直接失去練習意願。
//
// 判定用比例（不是實詞個數）：句型幾乎相同時比例會很高，而換句話說時會明顯下降。
export function isSelfRepeat(say, prevSays = [], threshold = 0.6) {
  return prevSays.some(prev => overlap(say, prev) >= threshold);
}

// ── 一之三、同一句話裡自我重複 ──────────────────────────────────
//
// 實測（iPad，Qwen3-4B Q3，2026-08-20）：
//   「嗯…那我現在要接孩子，可能要再說一次。我現在要接孩子，可能要再說一次。」
//
// isSelfRepeat() 只比對「跟前幾回合」，這種**同一句話內部**的重複完全漏掉，
// 所以總結畫面顯示「六項全部通過」。漏判讓問題看不見（D044 的同一個教訓）。
//
// 判法：依標點切成子句，任兩個子句高度相似就算。
// 比「找最長重複子字串」便宜，而且對「講兩次同一件事」這個症狀更貼切。
export function repeatsWithin(say, threshold = 0.8, minChars = 5) {
  const parts = String(say || '')
    .split(/[。！？!?，,；;…]+/)
    .map(x => x.trim())
    .filter(x => x.length >= minChars);
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (overlap(parts[i], parts[j]) >= threshold) return true;
    }
  }
  return false;
}

// ── 二、自稱業務員 ──────────────────────────────────────────────
//
// 現有的 validateRoleplay() 只比對後設用語（演練、AI、教練），
// 攔不到「我是做保險的」這種**演錯角色**的情況（§13.4）。
//
// 注意：判斷刻意排除「引用對方說法」的情況——那是 isEcho() 的職責，
// 兩者混在一起會讓錯誤分類失準（handbook §9.2 第 8 條：
// 相似的症狀可能是完全不同的問題）。
const SELF_AGENT = /(^|[，。！？\s])我(是|們是|在)(做|賣|跑)?(保險|壽險|保單|業務)|我是[^，。？！]{0,6}(人壽|保險公司|公司)的|我是[^，。？！]{0,6}助理/;

export function claimsToBeAgent(say) {
  const s = String(say || '');
  // 「你說你是做保險的」這種轉述不算
  if (/(您|你)(說|是說|剛說)/.test(s.slice(0, 8))) return false;
  return SELF_AGENT.test(s);
}

// ── 二之二、過度順從 ────────────────────────────────────────────
//
// 實測（MiniCPM5-1B Q8_0）：業務員說「我下週三過去說明二十分鐘可以嗎」，
// 客戶回「好的，請您不要擔心，這個保險我一定會買。」
//
// **這比講不通的話更危險。** 講不通只是體驗差；秒答應購買會給新人虛假的成功感，
// 讓他以為那套結巴、沒重點的開場是有效的。
// handbook §9.3 第 14 條說訓練工具不能打擊信心——但同樣不能給假的成功。
//
// 難度的規則本來就分得很清楚（prompts.js 的 DIFFICULTY）：
//   Level 1 的客戶「會答應合理的請求（例如約時間）」——那是約時間，不是買保險。
// 所以這裡分兩級判定：答應見面／約時間是允許的，承諾購買一律攔下。
const PROMISE_BUY = /(我)?(一定|肯定|馬上|立刻|現在就)?(會|要|想)?(買|投保|簽|保這個|辦這個)/;
const OVER_AGREE = /(都聽你的|你說什麼都好|完全同意|沒問題我都可以|你決定就好)/;

export function isTooCompliant(say, difficulty = 1) {
  const s = String(say || '');
  // 「不買」「還不想買」這類否定不算承諾
  if (/(不|沒有|不會|不用|還不)想?(買|投保|簽)/.test(s)) return false;
  if (PROMISE_BUY.test(s)) return true;
  // 高難度連「都聽你的」都不該出現；Level 1 允許客氣但不允許無條件順從
  if (OVER_AGREE.test(s)) return true;
  return false;
}

// ── 二之二之二、角色反轉（客戶變成供給方）──────────────────────
//
// 實測（MiniCPM5-1B Q8_0）：
//   「沒問題，請您查閱，我還有兩個保險產品供您選。」
//
// 它沒有自稱業務員，所以 claimsToBeAgent() 攔不到；但它扮演了**供給方**。
// 這是同一類問題的第三種變形：
//   自稱業務員（明說身分）→ 照抄人設（複製文字）→ 角色反轉（做業務員的事）
//
// 客戶講「我們公司有保團保」是合理的，所以判定只看「提供／安排給對方」這件行為，
// 不看「公司」「保險」這些詞本身——否則會把正常的客戶發言誤判掉。
// ⚠ 這個判斷式改過一次。第一版只認「我有…產品」，漏掉了 iPad 實測（2026-08-20）
//   出現的第三種說法——**用「我們／我們公司」自稱供給方**：
//     「對啊，我們公司這個產品有很好的儲蓄功能」
//     「讓您更了解我們公司的產品」
//     「孩子教育金的事情，我們有兩個方案可選」
//   五回合裡出現三次，而檢查回報 0 次。**漏判比誤判更危險**：
//   它讓總結畫面顯示全綠，於是我差點把「品質不行」歸因於別的地方。
const ROLE_INVERT = new RegExp([
  // 提供選項給對方
  '(供|給)(您|你)(選|參考|挑|看)',
  // 我／我們（公司）有…產品｜方案
  '我(們)?(這邊|這裡|公司|還)?(有|可以提供)[^。！？]{0,14}(產品|商品|方案|保單|保險)',
  // 介紹「我們公司的」東西——客戶不會這樣講
  // 「我們公司的產品」與「我們公司這個產品有…」——後者的『產品』在『有』之前，
  // 所以上面那條「我們…有…產品」的順序抓不到，必須單獨列。
  // 只認產品／商品／方案這三個賣方詞：客戶描述自己的保障會說「團保」「保險」，不會說「方案」。
  '我們(公司)?(的|這個|這些|那個)?[^。！？]{0,6}(產品|商品|方案)',
  '讓(您|你)(更|)(了解|認識)我們',
  // 請對方查閱／幫對方處理
  '請(您|你)查閱',
  '我(們)?(可以|會|來)(幫|為|替)(您|你)(安排|規劃|辦理|處理|查)',
  '我(們)?(來|幫你|幫您)介紹',
].join('|'));

export function invertsRole(say) {
  const s = String(say || '');
  // 客戶講「我們公司有保團保」是合理的——那是描述自己的保障，不是在賣東西。
  // 這個例外必須放在前面，否則會被上面的「我們公司…保險」規則誤殺。
  if (/我們公司(有|幫我們)(保|投保|加保)?(團保|團體保險)/.test(s)) return false;
  return ROLE_INVERT.test(s);
}

// ── 二之三、逐字複製人設 ────────────────────────────────────────
//
// 實測：隱藏需求原文是「擔心自己萬一倒下，女兒的生活費與學費沒人接手」，
// 模型回「我一直很懷疑自己萬一倒下，女兒的生活費與學費沒人接手。」——幾乎逐字照抄。
//
// 程式偵測得到「碰到主題」（那是好事），但**照抄設定文字不像真人講話**，
// 真的客戶會用自己的話講。這與 D030（示範台詞會被照抄）是同一個病。
export function copiesPersonaText(say, hiddenNeeds = [], threshold = 0.55) {
  return hiddenNeeds.some(h => overlap(say, needText(h)) >= threshold);
}

// 照抄提示詞裡的示範句。
//
// 為什麼需要獨立一項（實測 2026-08-20，桌面實機，Qwen3-4B Q3）：
//   第二回合客戶回了「說真的…就是我要是有一天倒下了，家裡怎麼辦。」
//   ——與提示詞裡的示範句一字不差。
//
//   而六項檢查全部通過：不是鸚鵡式重複（跟業務員說的不像）、
//   不是自我重複（前幾回合沒說過）、不是句內重複、沒有自稱業務員、
//   沒有角色反轉、也不算照抄人設（示範句不在隱藏需求裡）。
//   **每一項都盡忠職守，而缺陷從它們中間走過去了。**
//
// 這是同一個病的第三次出現（DIFFICULTY[1] 的「你慢慢說沒關係」、
// 我自己的 one-shot「嗯…請問是什麼事？」）。前兩次都是靠改提示詞解決，
// 但改提示詞只降低機率；能保證的只有程式層的檢查。
//
// 門檻比照抄人設寬鬆（0.75）：示範句短，而且我們寧可多重抽一次，
// 也不要讓每一位客戶都對每一位使用者講同一句話。
export function copiesExample(say, examples = [], threshold = 0.75) {
  const s = String(say || '').trim();
  if (!s) return false;
  return examples.some(e => {
    const t = String(e || '').trim();
    if (!t) return false;
    if (s === t) return true;
    return overlap(s, t) >= threshold;
  });
}

// ── 三、隱藏需求是否被碰到 ──────────────────────────────────────
//
// 模型該做的是「挑編號」（D009），但 0.8B 連編號都不挑。
// 程式這邊用 2-gram 交集判斷客戶這句話有沒有碰到某一項隱藏需求的主題。
//
// 這是啟發式判斷，會有誤差，所以：
//   ・門檻設得保守（寧可漏判，不要誤判成「已經挖到」而讓評分虛高）
//   ・與模型回報的編號取聯集，兩邊任一命中就算
// 隱藏需求可以是字串，或 { text, keywords } —— 後者才擋得住「換句話說」。
//
// 為什麼需要關鍵詞（實測 2026-08-20，Qwen3-4B）：
//   隱藏需求原文：「擔心自己萬一倒下，女兒的生活費與學費沒人接手」
//   模型實際講出：「嗯…就是我如果倒下了，家裡怎麼辦。」
//   **模型正確地用自己的話透露了那件事，而字面比對完全沒抓到**（只有「倒下」重疊）。
//
// 這個漏判的方向特別糟：它會告訴使用者「你沒挖到」，而事實上他挖到了。
// 誤判讓評分虛高、漏判打擊信心——handbook §9.3 第 14 條的兩面都不能碰。
//
// 字面比對永遠追不上換句話說，所以改成：人設建立時就為每項隱藏需求附上關鍵詞
// （2～3 個核心詞），比對關鍵詞而不是整句。關鍵詞是「概念」的程式可讀表示。
const needText = n => (typeof n === 'string' ? n : (n?.text || ''));
const needKeywords = n => (typeof n === 'string' ? [] : (n?.keywords || []));

export function detectReveals(say, hiddenNeeds = [], modelReported = [], minTerms = 3) {
  const s = String(say || '');
  const found = new Set(
    (Array.isArray(modelReported) ? modelReported : [])
      .map(Number)
      .filter(n => Number.isInteger(n) && n >= 1 && n <= hiddenNeeds.length),
  );
  hiddenNeeds.forEach((need, i) => {
    const kws = needKeywords(need);
    // 有關鍵詞就以關鍵詞為準（命中任一即算）——這是對抗換句話說的主要機制
    if (kws.length && kws.some(k => k && s.includes(k))) { found.add(i + 1); return; }
    // 沒有關鍵詞時退回字面比對。門檻仍偏嚴，避免評分虛高。
    if (sharedTerms(s, needText(need)) >= minTerms) found.add(i + 1);
  });
  return [...found].sort((a, b) => a - b);
}

// ── 四、信任度變化 ──────────────────────────────────────────────
//
// 依「業務員這一回合做了什麼」計分，全部可從逐字稿判定。
// 每一條都對應 02_AI_COACH_ENGINE.md 的教練觀點，不是憑感覺配權重。
const OPEN_Q = /(什麼|怎麼|為什麼|哪些|哪一|多久|如何|是不是可以|方便嗎|好嗎)/;
const CLOSED_ONLY = /^[^？?]*(嗎|對不對|好不好)[？?]?$/;
const ACK = /(我了解|我明白|原來|聽起來|您剛(才|)說|你剛(才|)說|辛苦)/;
const PUSH = /(商品|保單|方案|儲蓄|投資|報酬|保費|利率|規劃一下|介紹一下)/;
const PRESSURE = /(一定要|最後機會|錯過|限時|今天不|只剩|趕快決定)/;
const FILLER = /^[\s呃嗯那個…\.。，,、]*$/;

export function trustDelta({ userText, hiddenNeeds = [], say = '', difficulty = 1 }) {
  const u = String(userText || '');
  let d = 0;
  const why = [];

  const add = (n, reason) => { d += n; why.push(`${n > 0 ? '+' : ''}${n} ${reason}`); };

  // 加分：問開放式問題、承接客戶說過的話、禮貌徵詢
  if (OPEN_Q.test(u) && !CLOSED_ONLY.test(u)) add(4, '問了開放式問題');
  if (ACK.test(u)) add(3, '承接了客戶說過的話');
  // 問到隱藏需求的主題（用業務員的問句去比對，不是用客戶的回答）
  // 門檻 2：兩個共同實詞就算碰到主題（實測「女兒＋學費」正是 2～3 個）
  const touched = hiddenNeeds.filter(h => {
    const kws = needKeywords(h);
    if (kws.length && kws.some(k => k && u.includes(k))) return true;
    return sharedTerms(u, needText(h)) >= 2;
  }).length;
  if (touched) add(Math.min(6, 3 * touched), `問題碰到 ${touched} 項客戶在意的事`);

  // 扣分：一開口就推商品、施壓、講太長、沒有內容
  if (PUSH.test(u) && !OPEN_Q.test(u)) add(-4, '直接推商品，沒有先了解需求');
  if (PRESSURE.test(u)) add(-6, '使用施壓話術');
  if (u.length > 120) add(-2, '一次講太長');
  if (FILLER.test(u) || u.replace(/[呃嗯那個…\s]/g, '').length < 6) add(-1, '沒有實質內容');

  // 合規紅線一律重扣（規則優先於模型，handbook §2.7）
  const c = checkCompliance(u);
  const types = (c.hits || []).map(h => h.type).join('、');
  if (c.level === 'high') add(-10, `合規紅線：${types}`);
  else if (c.level === 'warn') add(-3, `用語需注意：${types}`);

  // 依難度夾住區間 —— 這正是 handbook §2.4 的做法：
  // 難度不是一行描述，而是程式夾住的數值。原本靠提示詞「建議」的區間改成硬性上下限。
  const band = DELTA_BAND[Number(difficulty)] || DELTA_BAND[2];
  const clamped = Math.max(band[0], Math.min(band[1], d));

  return { delta: clamped, raw: d, band, why };
}

// 對應 prompts.js 的 DIFFICULTY 各級 trust_delta 傾向（§2.4 的表）
const DELTA_BAND = {
  1: [-3, 8],
  2: [-3, 6],
  3: [-6, 5],
  4: [-8, 4],
  5: [-10, 4],
};

// ── 五、一次算完一回合 ──────────────────────────────────────────
//
// 呼叫端只需要這一個函式。回傳的每個欄位都可以直接餵進 session.js 的狀態機，
// 而且**不依賴模型有沒有正確填欄位**。
export function turnSignals({ modelJson, userText, persona, difficulty, prevSays = [], examples = [] }) {
  const j = modelJson || {};
  const say = String(j.say || '');
  const hidden = persona?.hidden_needs || [];
  const t = trustDelta({ userText, hiddenNeeds: hidden, say, difficulty });

  return {
    say,
    trustDelta: t.delta,
    trustWhy: t.why,                                    // 給教練回饋當證據用（§6.2）
    revealed: detectReveals(say, hidden, j.revealed),
    echo: isEcho(say, userText),
    selfRepeat: isSelfRepeat(say, prevSays),
    repeatsWithin: repeatsWithin(say),
    wrongRole: claimsToBeAgent(say),
    tooCompliant: isTooCompliant(say, difficulty),
    copiesPersona: copiesPersonaText(say, hidden),
    copiesExample: copiesExample(say, examples),
    invertsRole: invertsRole(say),
    // end 仍由 session.js 判定（D004：演練結束時機由程式決定），這裡只轉述模型的訊號
    modelWantsEnd: j.end === true,
    difficulty: Number(difficulty) || 1,
    band: t.band,
  };
}
