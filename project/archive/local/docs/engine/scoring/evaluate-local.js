// 本機版的演練評分：完全由程式計算，不呼叫模型。
//
// 為什麼：
//   雲端版的評分要模型產生約 8,000 token 的 JSON（總評、五個構面各含證據、
//   優點、改善建議、示範話術、合規提醒、下次挑戰）。iPad 上 4B 跑這個要六分鐘以上，
//   而且量測階段已經證明小模型產生長 JSON 會塌掉。
//
//   更重要的是：**評分本來就不該交給模型。**
//   使用者最在意的產出如果每次分數都不一樣，那它就不是評量，只是意見。
//   程式算分換來三件事：可重現、可解釋（每一分都指得出扣在哪一句）、離線。
//
// 權重是我提出的初版，寫成具名常數就是為了讓你直接改。
// 每一個構面都必須能回答「這一分是從哪一句來的」，所以每個扣分點都帶證據。

// 逐字稿裡「業務員說的話」的填充詞
const FILLER_RE = /嗯+|呃+|那個|就是說|然後|欸|齁|啦/g;

// 五個構面的滿分與扣分上限（0～5，session.js 會再正規化到 0.5 級距）
const FULL = 5;

// ── 文字特徵 ────────────────────────────────────────────────────
const OPEN_Q = /(什麼|怎麼|為什麼|哪|如何|多少|嗎|呢)/;
// 開放式問題：問「什麼／怎麼／哪」；封閉式：只有「嗎／對不對」
const REAL_OPEN_Q = /(什麼|怎麼|為什麼|哪一?[塊個些]|如何|多少)/;
const POLITE = /(您|請|謝謝|不好意思|打擾|方便|抱歉|麻煩)/;
const EMPATHY = /(我了解|我知道|我理解|辛苦|不容易|難怪|我懂|聽得出)/;
const HEDGE = /(應該|可能|大概|好像|也許|差不多|我不太確定|不知道可不可以)/g;
const SELF_INTRO = /(我是|我叫|敝姓|我姓|我這邊是)/;
const PERMISSION = /(方便嗎|可以嗎|好嗎|耽誤|打擾您?一?下|兩分鐘|三分鐘|幾分鐘)/;
const CONCRETE_ASK = /(約|見面|拜訪|見個面|哪一天|禮拜|星期|時間|下次|再聯絡|過去找您?|留個)/;

const count = (s, re) => (s.match(re) || []).length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 分數下限 1.0，不是為了好看。
//
// prompts.js 的難度系統註解已經記錄過同一個判斷：
//   「實測發現太弱——連 Level 1 的客戶都會冷淡、想掛電話，
//     對新進夥伴是打擊信心而不是訓練。」
//
// 給第一次上場的人 0 分，傳達不出任何可以行動的資訊，只會讓他不想再開第二次。
// 1.0／5 仍然清楚表示「這一項要重練」，而且改善建議才是真正的資訊來源。
// 只有完全沒有發言（turns === 0）才會出現 0 分。
const FLOOR = 1;
const r5 = (v, floor = FLOOR) => Math.max(floor, Math.min(5, Math.round(v * 2) / 2));

// ── 弱點偵測 ────────────────────────────────────────────────────
// 每一個偵測器對應一條具體的改善建議。
// 這是整份回饋真正有用的部分：不講「要更專業」，而是講「你這一場沒有做這件事」。
export function detectWeaknesses({ turns, all, persona, metrics, violations, mode, context }) {
  const w = [];
  const first = turns[0] || '';
  const qTurns = turns.filter(t => /[？?]/.test(t) || OPEN_Q.test(t));
  const openQ = turns.filter(t => REAL_OPEN_Q.test(t));

  if (context !== 'warm' && context !== 'existing' && !SELF_INTRO.test(first)) {
    w.push({ id: 'noIntro', evidence: `第一句是「${first.slice(0, 24)}」，沒有自我介紹` });
  }
  if (!PERMISSION.test(all)) {
    w.push({ id: 'noPermission', evidence: '整場沒有問過對方現在方不方便' });
  }
  if (turns.length >= 3 && qTurns.length / turns.length < 0.34) {
    w.push({ id: 'fewQuestions', evidence: `${turns.length} 次發言裡只有 ${qTurns.length} 次在提問` });
  }
  if (qTurns.length > 0 && openQ.length === 0) {
    w.push({ id: 'closedOnly', evidence: '問題都是「是不是、對不對」這類只能回答是或不是的問法' });
  }
  if (mode === 'call' && !CONCRETE_ASK.test(all)) {
    w.push({ id: 'noAsk', evidence: '整場沒有提出見面或下次聯繫的具體要求' });
  }
  if (metrics.avgLen > 70) {
    w.push({ id: 'tooLong', evidence: `平均每次說 ${metrics.avgLen} 個字，客戶沒有插話的空間` });
  }
  if (metrics.avgLen > 0 && metrics.avgLen < 10) {
    w.push({ id: 'tooShort', evidence: `平均每次只說 ${metrics.avgLen} 個字` });
  }
  const fillerPer100 = all.length ? (metrics.fillers / all.length) * 100 : 0;
  if (fillerPer100 > 4) {
    w.push({ id: 'fillers', evidence: `每 100 字出現 ${fillerPer100.toFixed(1)} 個「嗯、那個、就是說」` });
  }
  if (metrics.stuck >= 2) {
    w.push({ id: 'stuck', evidence: `有 ${metrics.stuck} 次接不上話，需要客戶主動幫你接` });
  }
  if (!EMPATHY.test(all)) {
    w.push({ id: 'noEmpathy', evidence: '客戶講完自己的狀況後，沒有一句回應他的感受' });
  }
  const total = (persona?.hidden_needs || []).length;
  if (total && metrics.revealed.length === 0) {
    w.push({ id: 'noReveal', evidence: `這位客戶心裡有 ${total} 件在意的事，這一場一件都沒被問出來` });
  }
  if (count(all, HEDGE) >= 3) {
    w.push({ id: 'hedging', evidence: `說了 ${count(all, HEDGE)} 次「應該、可能、大概」這類不確定的話` });
  }
  if (metrics.repeats > 0) {
    w.push({ id: 'repeats', evidence: `有 ${metrics.repeats} 次把同樣的話又說了一遍` });
  }
  if (violations.length) {
    w.push({ id: 'compliance', evidence: violations.map(v => v.type).join('、') });
  }
  return w;
}

// 改善建議庫：每一條都要能照著做，不能只是形容詞。
const ADVICE = {
  noIntro: {
    point: '開場沒有先讓對方知道你是誰',
    why: '對方接起電話時最想知道的是「你是誰、為什麼找我」。這兩件事沒交代，後面講什麼他都在防備。',
    how: '前三句固定講完三件事：我是誰、為什麼打給你、只要幾分鐘。例如「陳先生您好，我是做保險規劃的小林，今天打來只想用兩分鐘跟您確認一件事。」',
  },
  noPermission: {
    point: '沒有徵求對方的同意就繼續講',
    why: '沒問過就講下去，對方會覺得被強迫；問一句反而讓他有掌控感，答應了之後也更願意聽完。',
    how: '講完來意就停下來問一句：「您現在方便講兩分鐘嗎？」對方說不方便，就約下一個時間，這通電話仍然算成功。',
  },
  fewQuestions: {
    point: '整場幾乎都是你在講',
    why: '客戶不會因為聽懂而買，他是因為自己講出需求才願意往下走。你講得越多，他講得越少。',
    how: '設一個比例：每講兩句就問一個問題。問完閉嘴，等他講完再接。',
  },
  closedOnly: {
    point: '問題都是「是不是」這種只能回答是或不是的問法',
    why: '封閉式問題只能換到一個字，換不到資訊。他回答「沒有」你就沒有下一步了。',
    how: '把問句開頭換成「什麼、怎麼、哪一塊」。例如不要問「您有保險嗎」，改問「您現在的保險是什麼時候買的、當時是為了什麼？」',
  },
  noAsk: {
    point: '沒有提出具體的要求就結束了',
    why: '電話邀約的目的不是聊得愉快，是拿到下一次的機會。沒有開口要，對方就沒有理由答應。',
    how: '收尾一定要給兩個選擇：「那我這禮拜三下午或禮拜五晚上過去，哪一天對您比較方便？」二選一比「有空再約」有效得多。',
  },
  tooLong: {
    point: '一次講太多，對方插不上話',
    why: '一口氣講五十個字以上，對方會開始聽不進去，也找不到接話的地方，最後只會說「好啊我知道了」。',
    how: '一次只講一個意思，講完就停。心裡數兩秒，讓對方接話。',
  },
  tooShort: {
    point: '回話太短，沒有把意思講完',
    why: '太短會讓對方不知道你要什麼，也感覺不到你的誠意，他只能用「喔」來回應。',
    how: '每次發言至少完成一個結構：回應他剛講的 → 講你的一句話 → 問一個問題。',
  },
  fillers: {
    point: '「嗯、那個、就是說」出現太多',
    why: '填充詞會讓對方覺得你不熟、沒準備，尤其在電話裡沒有表情可以彌補。',
    how: '把開場白跟三個常用問句寫下來練到不用想。想不到話的時候用停頓代替，停兩秒比「那個那個」好聽得多。',
  },
  stuck: {
    point: '客戶回應之後你接不上話',
    why: '接不上話通常不是不會講，是沒準備好對方可能怎麼回。你一卡住，主導權就換到他手上。',
    how: '先把這位客戶最可能的三個拒絕寫下來，每個準備一句回應。卡住時先用萬用句接住：「您這樣說是因為…？」',
  },
  noEmpathy: {
    point: '對方講了自己的狀況，你沒有回應他的感受',
    why: '客戶願意講出私事是在測試你會不會聽。你直接跳到下一個問題，他就不會再講第二件。',
    how: '他講完先重複一次他的處境再往下：「所以您現在是一個人在顧兩邊，那真的很不容易。」——重複他的話比講你的道理有用。',
  },
  noReveal: {
    point: '沒有問到客戶心裡真正在意的事',
    why: '表層資訊（年齡、職業、有沒有保險）不會讓人想買。真正推動決定的是他自己說出口的那個擔心。',
    how: '用「如果」開頭的假設題往下探：「如果有一天您沒辦法工作，最先受影響的會是誰？」問完不要急著給答案，等他講。',
  },
  hedging: {
    point: '講話太多不確定的字',
    why: '「應該、可能、大概」會讓對方懷疑你自己也沒把握，他就不會把家裡的事交給你。',
    how: '不確定的事直接說「我幫您查清楚，明天回覆您」；確定的事就講肯定句。',
  },
  repeats: {
    point: '同一段話重複講了',
    why: '重複通常代表你在等對方反應，但對方會覺得你沒在聽他剛剛說什麼。',
    how: '重複之前先問自己：他剛剛回了什麼？把他的回答當成下一句的開頭。',
  },
  compliance: {
    point: '用了可能違規的說法',
    why: '不管業績多好，違規招攬會讓保單失效、也可能讓你自己被處分。這一條沒有商量空間。',
    how: '不承諾收益、不比較銀行利率、不用停售促銷、不代簽、不誘導不實告知。想強調價值就講「確定拿得到」，不要講「保證賺」。',
  },
};

// ── 主函式 ──────────────────────────────────────────────────────
export function evaluateLocal({ persona, transcript, metrics, violations = [], mode = 'call', context = 'cold', difficulty = 1 }) {
  const turns = transcript.filter(h => h.speaker === 'user').map(h => h.text || '');
  const all = turns.join('\n');
  const custTurns = transcript.filter(h => h.speaker === 'customer').map(h => h.text || '');
  const totalHidden = (persona?.hidden_needs || []).length;
  const w = detectWeaknesses({ turns, all, persona, metrics, violations, mode, context });
  const has = id => w.some(x => x.id === id);
  const ev = id => w.find(x => x.id === id)?.evidence || '';

  // ── 流暢度 ──
  // 起點不是滿分：滿分要靠「沒有卡住、填充詞少、長度適中」三件都做到。
  let fluency = 4.5;
  const fillerPer100 = all.length ? (metrics.fillers / all.length) * 100 : 0;
  fluency -= clamp(fillerPer100 / 3, 0, 2);            // 每 100 字 3 個填充詞扣 1 分
  fluency -= clamp(metrics.stuck * 0.7, 0, 2);
  if (has('tooShort')) fluency -= 1;
  if (has('tooLong')) fluency -= 0.5;
  if (has('repeats')) fluency -= 0.5;

  // ── 親和力 ──
  let friendliness = 2.5;
  if (POLITE.test(all)) friendliness += 1;
  if (EMPATHY.test(all)) friendliness += 1.5;
  if (has('noPermission')) friendliness -= 0.5;
  // 有回應客戶剛講的內容（用字重疊）才算真的在聽
  const listened = custTurns.filter((c, i) => {
    const next = turns[i + 1] || '';
    if (!c || !next) return false;
    const chars = new Set([...c].filter(ch => /[一-鿿]/.test(ch)));
    let hit = 0;
    for (const ch of new Set([...next])) if (chars.has(ch)) hit++;
    return hit >= 3;
  }).length;
  if (custTurns.length >= 2 && listened / custTurns.length > 0.5) friendliness += 0.5;

  // ── 需求覺察 ── 這一項最客觀：挖到幾項就是幾分
  let awareness = totalHidden
    ? 1 + (metrics.revealed.length / totalHidden) * 3.5
    : 2.5;
  const openQ = turns.filter(t => REAL_OPEN_Q.test(t)).length;
  if (openQ >= 2) awareness += 0.5;
  if (has('closedOnly')) awareness -= 0.5;
  if (has('fewQuestions')) awareness -= 1;

  // ── 自信 ──
  let confidence = 3.5;
  confidence -= clamp(count(all, HEDGE) * 0.4, 0, 1.5);
  confidence -= clamp(metrics.stuck * 0.4, 0, 1.5);
  if (CONCRETE_ASK.test(all)) confidence += 1;
  if (has('noAsk')) confidence -= 1;
  if (has('tooShort')) confidence -= 0.5;

  // ── 專業度 ──
  let professionalism = 3.5;
  if (violations.some(v => v.level === 'high')) professionalism -= 2.5;
  else if (violations.length) professionalism -= 1;
  if (has('noIntro')) professionalism -= 1;
  if (SELF_INTRO.test(turns[0] || '')) professionalism += 0.5;
  if (openQ >= 2) professionalism += 0.5;
  if (has('noEmpathy')) professionalism -= 0.5;

  // 信任度的變化本身就是結果，讓它影響整體但不主導
  const trustBonus = clamp((metrics.finalTrust - 50) / 40, -0.5, 0.5);

  const floor = turns.length ? FLOOR : 0;   // 完全沒發言就不套下限
  const scores = {
    fluency: { score: r5(fluency + trustBonus * 0.5, floor), evidence: evFluency(metrics, fillerPer100) },
    friendliness: { score: r5(friendliness + trustBonus, floor), evidence: evFriend(all, listened, custTurns.length) },
    awareness: { score: r5(awareness, floor), evidence: evAware(metrics, totalHidden, openQ) },
    confidence: { score: r5(confidence + trustBonus * 0.5, floor), evidence: evConf(all, metrics, has) },
    professionalism: { score: r5(professionalism, floor), evidence: evPro(violations, has) },
  };

  // ── 優點：只講真的做到的事，講不出來就不硬湊 ──
  const positives = [];
  if (SELF_INTRO.test(turns[0] || '')) positives.push('開場就講清楚自己是誰，對方不用猜。');
  if (PERMISSION.test(all)) positives.push('有先問對方方不方便，這是把主導權交回去的好習慣。');
  if (EMPATHY.test(all)) positives.push('客戶講到自己的處境時，你有回應他的感受，不是急著往下賣。');
  if (openQ >= 2) positives.push(`用了 ${openQ} 次「什麼／怎麼／哪一塊」的開放式問法，這是能問出東西的問法。`);
  if (metrics.revealed.length) positives.push(`問出了 ${metrics.revealed.length} 件客戶原本沒說出口的事。`);
  if (CONCRETE_ASK.test(all)) positives.push('最後有開口提出具體的下一步，沒有讓對話懸在空中。');
  if (!violations.length) positives.push('全程沒有出現違規用語。');
  if (metrics.stuck === 0 && metrics.turns >= 3) positives.push('全程沒有接不上話，節奏穩定。');
  if (!positives.length) {
    positives.push(`完成了 ${metrics.turns} 個回合的練習——第一次上場能把話講完就是進度。`);
  }

  // ── 改善建議：取最該先改的三個 ──
  // 排序不是隨意的：合規最優先，其次是「沒有這個動作整場就不成立」的缺口，
  // 再來才是表達層面的問題。一次給三個以上沒有人會照著做。
  const ORDER = ['compliance', 'noIntro', 'noAsk', 'noReveal', 'fewQuestions', 'closedOnly',
    'noEmpathy', 'noPermission', 'stuck', 'tooLong', 'tooShort', 'fillers', 'hedging', 'repeats'];
  const improvements = w
    .slice()
    .sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
    .slice(0, 3)
    .map(x => ({
      point: ADVICE[x.id].point,
      why: ADVICE[x.id].why,
      how: `${ADVICE[x.id].how}\n（這一場的情況：${x.evidence}）`,
    }));

  // 沒有偵測到缺口時不能交白卷。
  // 教練工具的價值在「下一步是什麼」，表現好的人更需要知道往哪裡進階。
  if (!improvements.length) {
    improvements.push(totalHidden && metrics.revealed.length < totalHidden
      ? {
        point: `還有 ${totalHidden - metrics.revealed.length} 件客戶心裡的事沒被問出來`,
        why: '結構已經沒問題了，接下來的差距在深度。挖到一件跟挖到三件，成交機率不一樣。',
        how: '客戶回答之後不要馬上換題目，用「還有呢？」「那除了這個以外？」往下追第二層。一個話題至少追三輪再換。',
      }
      : {
        point: '把同一套流程放到更難的客戶身上',
        why: '在願意配合的客戶身上做對，不代表在會擋你的客戶身上也做得到。真正的能力差距出現在被拒絕之後。',
        how: `把難度調到 ${Math.min(5, difficulty + 1)}，客戶會主動拿異議出來擋。目標不是說服他，是在被擋之後還能問出下一個問題。`,
      });
  }

  // ── 示範話術：針對最該補的那一個缺口，不是給一段通用範本 ──
  const top = w.slice().sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))[0];
  const demo = persona?.demo || {};
  const example_script = top && SCRIPT[top.id]
    ? SCRIPT[top.id](persona)
    : [demo.opening, demo.key_question].filter(Boolean).join('\n\n');

  const avg = Object.values(scores).reduce((a, b) => a + b.score, 0) / 5;

  return {
    summary: buildSummary({ avg, metrics, totalHidden, w, mode }),
    scores,
    positives: positives.slice(0, 4),
    improvements,
    example_script,
    compliance_note: violations.length
      ? violations.map(v => `・${v.type}：${v.why}`).join('\n')
      : '本次未發現違規用語。',
    next_challenge: nextChallenge({ difficulty, avg, w, mode }),
  };
}

// ── 證據字串 ────────────────────────────────────────────────────
// 每一個構面都必須指得出「這一分是從哪裡來的」。
function evFluency(m, fp) {
  const bits = [`平均每次發言 ${m.avgLen} 字`, `填充詞 ${m.fillers} 個（每 100 字 ${fp.toFixed(1)} 個）`];
  if (m.stuck) bits.push(`接不上話 ${m.stuck} 次`);
  if (m.repeats) bits.push(`重複發言 ${m.repeats} 次`);
  return bits.join('；') + '。';
}
function evFriend(all, listened, custN) {
  const bits = [];
  bits.push(POLITE.test(all) ? '有使用「您、請、不好意思」等禮貌用語' : '幾乎沒有出現禮貌用語');
  bits.push(EMPATHY.test(all) ? '有回應客戶的感受' : '沒有出現「我了解、辛苦了」這類回應感受的話');
  if (custN >= 2) bits.push(`客戶說完之後你接住他話裡內容的比例是 ${listened}/${custN}`);
  return bits.join('；') + '。';
}
function evAware(m, total, openQ) {
  return total
    ? `這位客戶設定了 ${total} 件沒說出口的事，你問出 ${m.revealed.length} 件；開放式問題 ${openQ} 次。`
    : `開放式問題 ${openQ} 次。`;
}
function evConf(all, m, has) {
  const h = count(all, HEDGE);
  const bits = [`不確定用語（應該、可能、大概）${h} 次`];
  bits.push(CONCRETE_ASK.test(all) ? '有提出具體的下一步要求' : '沒有提出具體的下一步要求');
  if (m.stuck) bits.push(`卡住 ${m.stuck} 次`);
  return bits.join('；') + '。';
}
function evPro(violations, has) {
  const bits = [];
  bits.push(violations.length ? `出現 ${violations.length} 處合規風險用語` : '無違規用語');
  bits.push(has('noIntro') ? '開場沒有自我介紹' : '開場有交代身分');
  return bits.join('；') + '。';
}

// ── 針對缺口的示範話術 ──────────────────────────────────────────
const SCRIPT = {
  noIntro: p => `${p.name}您好，不好意思打擾您一下，我是做保險規劃的小林。\n我今天打這通電話不是要跟您談商品，只想用兩分鐘讓您知道一件事，聽完您覺得沒需要，我就不再打擾，這樣可以嗎？`,
  noAsk: p => `${p.name}，那我不佔用您太多時間。\n我這禮拜三下午或禮拜五晚上會在您那一區，哪一天對您比較方便？我過去十五分鐘就好，把該講的講清楚，要不要做完全由您決定。`,
  noReveal: p => `${p.name}，我問一個可能有點直接的問題——\n如果有一天您突然沒辦法工作，家裡最先受影響的會是誰？\n（問完停下來，讓他自己講。他講出來的那件事，才是後面所有規劃的起點。）`,
  fewQuestions: p => `${p.name}，我不多講，先問您一件事就好：\n您現在最放不下心的，大概是家裡哪一塊？\n（他回答之後，重複一次他的話，再問「那這件事您有想過怎麼辦嗎？」）`,
  closedOnly: p => `不要問：「${p.name}您有保險嗎？」\n改問：「${p.name}，您現在的保險是什麼時候買的？當時是為了什麼才買的？」\n前者只會換到「有」，後者會換到一整段故事。`,
  noEmpathy: p => `${p.name}講完他的狀況之後，先不要接你的話，先講這一句：\n「所以您現在是一個人在撐兩邊，那真的很不容易。」\n停兩秒，再問：「那這件事，您有想過怎麼安排嗎？」`,
  noPermission: p => `${p.name}您好，我是做保險規劃的小林。\n我知道這通電話來得突然，所以我只問一句：您現在方便講兩分鐘嗎？如果不方便，我改晚上再打給您。`,
  compliance: p => `想強調價值，但不要碰到紅線——\n不要說：「這個保證賺」「比銀行利息好」「這個月停售」。\n可以說：「這筆錢是契約上寫明、確定拿得到的，不會因為市場好壞改變。」\n同樣有力，而且合規。`,
};

// ── 總評與下次挑戰 ──────────────────────────────────────────────
function buildSummary({ avg, metrics, totalHidden, w, mode }) {
  const level = avg >= 4 ? '這一場的完成度很高' : avg >= 3 ? '基本的架構有了' : avg >= 2 ? '開得了口，但架構還沒成形' : '這一場主要是熟悉流程';
  const got = totalHidden ? `挖到 ${metrics.revealed.length}／${totalHidden} 件客戶沒說出口的事` : '';
  const gap = w.length
    ? `最該先補的是「${w.map(x => ({ compliance: '合規用語', noIntro: '開場自我介紹', noAsk: '提出具體要求', noReveal: '問出真正的擔心', fewQuestions: '把話給客戶講', closedOnly: '改用開放式問法', noEmpathy: '回應客戶的感受' }[x.id])).filter(Boolean)[0] || '表達的細節'}」。`
    : '這一場沒有明顯的結構性缺口，接下來可以往更難的難度練。';
  return [
    `${level}：${metrics.turns} 個回合、平均每次 ${metrics.avgLen} 字${got ? '，' + got : ''}。`,
    gap,
  ].join('');
}

function nextChallenge({ difficulty, avg, w, mode }) {
  const first = w[0]?.id;
  if (first === 'compliance') return '下一場的目標只有一個：全程不出現任何保證收益、利率比較、停售促銷的說法。';
  if (first === 'noIntro') return '下一場練「前三句」：我是誰、為什麼打給你、只要兩分鐘。三句講完再往下。';
  if (first === 'noAsk') return '下一場一定要在結束前給出二選一的時間：「禮拜三下午還是禮拜五晚上？」';
  if (first === 'noReveal') return '下一場的唯一任務：問出至少一件客戶原本沒說出口的擔心。問出來就算成功，其他都不重要。';
  if (first === 'fewQuestions') return '下一場給自己一個限制：每次發言不超過三句話，而且每次都要以問句結尾。';
  if (avg >= 4 && difficulty < 5) return `這個難度已經穩了，下一場把難度調到 ${difficulty + 1}，客戶會開始拿異議出來擋。`;
  return '下一場維持同樣的難度，但換一個接觸情境（例如從陌生開發換成轉介紹），練習開場的調整。';
}
