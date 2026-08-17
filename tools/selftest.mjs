// 端到端自我測試：不經瀏覽器，直接跑完六大功能。
// 用途：每次改動後確認整套流程都還能跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiAdapter } from '../docs/engine/gateway.js';
import * as CE from '../docs/engine/session.js';
import * as KB from '../docs/engine/knowledge.js';
import * as AD from '../docs/engine/advisor.js';
import { checkCompliance } from '../docs/engine/compliance.js';
import { officeText } from '../docs/engine/docx.js';
import { scrubBrands } from '../docs/engine/prompts.js';
import { loadKeys } from './keys.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = loadKeys().gemini;
if (!key) { console.error('找不到 Gemini 金鑰。請在專案根目錄放「API Key.txt」，或設定 GEMINI_API_KEY。'); process.exit(1); }

const ONLY = process.argv[2];                       // 例：node tools/selftest.mjs 5  只跑第 5 節
const run = n => !ONLY || ONLY === String(n);

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '  ok  ' : ' FAIL '} ${m}${extra ? ' → ' + extra : ''}`); };
const t = () => Date.now();
const perf = {};

const gw = new GeminiAdapter(key);

// ── 1. 規則引擎與文件解析（不呼叫模型）────────────────────────
if (run(1)) {
  console.log('\n=== 1. 合規規則引擎 ===');
  ok(checkCompliance('我可以退佣給你').level === 'high', '「退佣」判定為高風險');
  ok(checkCompliance('保證獲利喔').level === 'high', '「保證獲利」判定為高風險');
  ok(checkCompliance('健康狀況不要寫上去').level === 'high', '「誘導不實告知」判定為高風險');
  ok(checkCompliance('這個就像存錢一樣').level === 'warn', '「存錢」判定為需注意');
  ok(checkCompliance('您好，我想跟您約個時間').level === 'none', '正常話術不誤判');

  console.log('\n=== 1b. 話術品牌中立化 ===');
  const cases = [
    ['王先生您好，我是國泰人壽的張小豪', '王先生您好，我是○○人壽的張小豪'],
    ['我是南山的業務員', '我是○○的業務員'],
    ['台灣人壽跟富邦人壽都有類似商品', '○○人壽跟○○人壽都有類似商品'],
    ['我在三商美邦人壽服務十年了', '我在○○人壽服務十年了'],
    ['客戶說他在台灣人的觀念裡覺得保險不吉利', '客戶說他在台灣人的觀念裡覺得保險不吉利'],  // 不可誤殺
    ['中國信託的理專介紹他買的', '中國信託的理專介紹他買的'],                              // 銀行不誤殺
  ];
  for (const [i, o] of cases) ok(scrubBrands(i) === o, `「${i.slice(0, 16)}…」`, scrubBrands(i));

  console.log('\n=== 1c. Office 文件解析（零外部相依）===');
  const pptx = path.join(DIR, '【AiCoach】AI業務教練.pptx');
  if (fs.existsSync(pptx)) {
    const txt = await officeText(new Uint8Array(fs.readFileSync(pptx)), 'x.pptx');
    ok(txt.length > 300, `PPTX 取字 ${txt.length} 字`);
    ok((txt.match(/【第 \d+ 頁】/g) || []).length >= 10, `分頁正確 ${(txt.match(/【第 \d+ 頁】/g) || []).length} 頁`);
  } else console.log('  --  找不到範例 PPTX，略過');
}

const models = await gw.init();
console.log(`\nModel Gateway → roleplay: ${models.fast} ／ judge: ${models.judge}`);

// ── 2. 功能一：客戶潛在痛點分析 ────────────────────────────────
if (run(2)) {
  console.log('\n=== 2. 功能一：客戶潛在痛點分析 ===');
  let t0 = t();
  const pp = await AD.painPoints(gw, { gender: '女', age: '約 38 歲', background: '護理師，離婚獨自扶養一個小學的女兒，輪三班' });
  perf.pain = t() - t0;
  ok(pp.points?.length === 3, `產生三個痛點 ${perf.pain}ms`);
  pp.points.forEach((p, i) => {
    ok(!!p.pain && !!p.reason && !!p.need && !!p.question, `  痛點 ${i + 1} 四欄齊全`);
    console.log(`        ${i + 1}. ${p.pain}`);
    console.log(`           探索問題：${p.question}`);
  });
  ok(!!pp.approach?.opening, '有建議接觸方式', pp.approach?.channel);
  const apText = JSON.stringify(pp);
  ok(scrubBrands(apText) === apText, '建議話術未出現任何保險公司名稱');
  console.log(`        建議開場：${pp.approach?.opening}`);
}

// ── 3. 功能三：發掘需求角色扮演（含隱藏需求逐步揭露）──────────
if (run(3)) {
  console.log('\n=== 3. 功能三：發掘需求角色扮演 ===');
  let t0 = t();
  const st = await CE.startSession(gw, {
    mode: 'needs', gender: '男', age: '約 52 歲',
    background: '自己開小型工廠，兩個小孩都在念大學，太太是家庭主婦', difficulty: 2,
  });
  perf.needsStart = t() - t0;
  ok(!!st.sessionId, `建立客戶 ${perf.needsStart}ms`, st.persona.name);
  ok(!!st.demo?.key_question, '有示範探索問題', st.demo?.key_question);

  const demoText = JSON.stringify(st.demo);
  ok(scrubBrands(demoText) === demoText, '示範話術未出現任何保險公司名稱');
  console.log(`        示範開場：${st.demo?.opening}`);

  const s = CE.getSession(st.sessionId);
  const hidden = s.persona.hidden_needs || [];
  ok(hidden.length > 0, `隱藏需求 ${hidden.length} 項（Client 看不到）`);
  CE.beginRoleplay(s);
  console.log(`        客戶：${st.opening}`);

  const probes = [
    '陳大哥，工廠開快二十年了，一路走來應該不容易吧',
    '聽起來您真的扛很多。那兩個小孩都在念大學，這部分您會不會覺得有壓力',
    // 最後一題「故意」問得太直接（直接講出客戶還沒說出口的事）。
    // 這同時驗證兩件事：揭露機制可運作，以及教練會不會抓出這種越界提問。
    `我這樣問可能有點直接——關於「${hidden[0] || '未來的規劃'}」這件事，您心裡是不是其實有點在意？我不是要賣您什麼，只是想聽您說`,
  ];
  const lat = [];
  for (const q of probes) {
    const t1 = t();
    const r = await CE.handleTurn(gw, s, q);
    lat.push(t() - t1);
    console.log(`        業務員：${q}`);
    console.log(`        客戶　：${r.text}　［信任 ${r.trust}／挖到 ${r.revealed}］`);
    ok(!/建議你|話術|演練|評分/.test(r.text), '  未跳出客戶角色');
    if (r.ended) break;
  }
  perf.needsTurn = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
  ok(s.revealed.size > 0, `有效提問挖出 ${s.revealed.size}／${hidden.length} 項隱藏需求`, [...s.revealed][0]);

  t0 = t();
  const fb = await CE.evaluate(gw, s);
  perf.needsEval = t() - t0;
  ok(!!fb.scores && fb.mode === 'needs', `評分完成 ${perf.needsEval}ms`);
  ok(Object.values(fb.scores).every(x => x.score >= 0 && x.score <= 5 && x.score * 2 % 1 === 0), '五項分數皆為 0.5 級距');
  ok(Array.isArray(fb.revealed), `回饋標示挖到 ${fb.revealed.length} 項`);
  console.log(`        總評：${fb.summary}`);
}

// ── 3b. 接觸情境：示範話術不得洩漏業務員不可能知道的資訊 ──────
if (run(3)) {
  console.log('\n=== 3b. 邀約情境 → 示範話術的資訊邊界 ===');
  const { demoLeaksPrivateInfo } = await import('../docs/engine/prompts.js');

  // 先驗規則本身（不呼叫模型）
  const bad = { opening: '林阿姨您好', key_question: '您那筆五百萬的保單放了好幾年了，原來的業務員都沒跟您做過保單健檢嗎？' };
  ok(demoLeaksPrivateInfo(bad, 'cold'), '規則能抓出「五百萬的保單」這類越界話術');
  ok(!demoLeaksPrivateInfo(bad, 'existing'), '既有客戶情境不誤判（本來就知道對方的保單）');
  const good = { opening: '林阿姨您好，我是○○人壽的○○', key_question: '想請教您，平常家裡的事情大多是您在打理嗎？' };
  ok(!demoLeaksPrivateInfo(good, 'cold'), '正常話術不誤判');

  // 再實機驗證兩種情境
  for (const [ctx, note] of [['cold', ''], ['referral', '王大哥介紹的，說他這位同事最近剛升主管']]) {
    const st = await CE.startSession(gw, {
      mode: 'call', gender: '女', age: '約 58 歲',
      background: '退休公務員，先生還在工作，一個女兒已經出社會', difficulty: 2,
      context: ctx, contextNote: note,
    });
    const d = st.demo;
    console.log(`        ［${st.contextLabel}］`);
    console.log(`        開場：${d.opening}`);
    console.log(`        關鍵問題：${d.key_question}`);
    ok(!demoLeaksPrivateInfo(d, ctx), `  ${st.contextLabel}：示範話術未越界`);
    ok(scrubBrands(JSON.stringify(d)) === JSON.stringify(d), `  ${st.contextLabel}：未出現保險公司名稱`);
    if (ctx === 'referral') ok(/介紹|王大哥/.test(d.opening), '  轉介紹情境：開場有交代介紹人');
    CE.dropSession(st.sessionId);
  }
}

// ── 4. 文件知識庫 + 功能四：商品行銷演練 ──────────────────────
let productDoc = null;
if (run(4)) {
  console.log('\n=== 4. 功能四：商品教材解析 → 商品行銷演練 ===');
  const pptx = path.join(DIR, '【AiCoach】AI業務教練.pptx');
  if (fs.existsSync(pptx)) {
    let t0 = t();
    const up = await KB.ingest(gw, { name: 'AI業務教練.pptx', kind: 'product', base64: fs.readFileSync(pptx).toString('base64') });
    perf.ingest = t() - t0;
    productDoc = await KB.getDoc(up.id);
    ok(!!up.title, `教材解析完成 ${perf.ingest}ms`, up.title);
    ok(up.digest?.selling_points?.length > 0, `整理出 ${up.digest.selling_points.length} 個 FABE 賣點`);
    ok(Array.isArray(up.digest?.missing), '有標示教材未載明的部分');
    console.log(`        概述：${up.digest.overview}`);

    const brief = KB.productBrief(productDoc);
    ok(brief.length > 50 && brief.length <= 4000, `商品重點摘要 ${brief.length} 字，可塞入 Persona`);

    t0 = t();
    const st = await CE.startSession(gw, {
      mode: 'product', gender: '男', age: '約 45 歲',
      background: '保險公司的區經理，帶 20 人團隊，想找工具幫新人做訓練', difficulty: 3, doc: productDoc,
    });
    perf.prodStart = t() - t0;
    ok(!!st.sessionId, `商品演練客戶建立 ${perf.prodStart}ms`, st.persona.name);
    ok(!!st.product?.title, '演練綁定商品', st.product?.title);

    const s = CE.getSession(st.sessionId);
    CE.beginRoleplay(s);
    console.log(`        客戶：${st.opening}`);
    for (const line of ['經理您好，我想跟您介紹一個可以讓新人自己練習的工具', '它可以讓新人對著手機做電話邀約演練，練完會給五項評分']) {
      const r = await CE.handleTurn(gw, s, line);
      console.log(`        業務員：${line}`);
      console.log(`        客戶　：${r.text}`);
      ok(r.text.length <= 120, '  回覆長度符合限制');
    }
    const fb = await CE.evaluate(gw, s);
    ok(!!fb.scores && fb.mode === 'product', '商品演練評分完成');
    console.log(`        總評：${fb.summary}`);
  } else {
    console.log('  --  找不到範例 PPTX，略過本節');
  }
}

// ── 5. 功能五：理賠諮詢建議 ────────────────────────────────────
if (run(5)) {
  console.log('\n=== 5. 功能五：保單條款解析 → 理賠諮詢 ===');
  const policy = `【範例】住院醫療終身健康保險附約 條款摘錄

第五條 名詞定義
本附約所稱「住院」，係指被保險人經醫師診斷必須入住醫院，且正式辦理住院手續並確實在醫院接受診療者。
本附約所稱「等待期」為本附約生效日起三十日。

第七條 每日病房費用保險金
被保險人於本附約有效期間內因疾病或傷害住院診療者，本公司按其實際住院日數，
乘以保險金額之一倍給付「每日病房費用保險金」。每次住院最高給付日數以三百六十五日為限。

第八條 住院醫療費用保險金
被保險人住院診療者，本公司就其住院期間所發生之醫師指示用藥、血液、掛號費等
必要醫療費用，按實際支出金額給付，每次住院最高以保險金額之一百二十倍為限。

第九條 手術費用保險金
被保險人於住院期間接受外科手術者，本公司依手術名稱及費用表所列給付倍數，
乘以保險金額給付「手術費用保險金」。同一次手術涉及二項以上者，僅給付其中最高一項。

第十條 加護病房費用保險金
被保險人入住加護病房者，除第七條給付外，另按實際入住日數乘以保險金額之二倍給付，
每次住院最高給付日數以三十日為限。

第十二條 除外責任
被保險人因下列原因所致之疾病或傷害而住院者，本公司不負給付責任：
一、被保險人之故意行為（包括自殺及自殺未遂）。
二、被保險人之犯罪行為。
三、被保險人非法施用防制藥品。
四、美容手術、外科整型。但為重建其基本功能所作之必要整型不在此限。
五、外觀可見之天生畸形。
六、健康檢查、療養、靜養、戒毒、戒酒、護理或美容之非必要性醫療行為。

第十四條 告知義務
要保人或被保險人於訂立本附約時，對於本公司要保書書面詢問之告知事項應據實說明。`;

  let t0 = t();
  const up = await KB.ingest(gw, {
    name: '範例住院醫療附約條款.txt', kind: 'policy',
    base64: Buffer.from(policy, 'utf8').toString('base64'),
  });
  perf.policyIngest = t() - t0;
  const doc = await KB.getDoc(up.id);
  ok(!!up.title, `條款解析完成 ${perf.policyIngest}ms`, up.title);
  ok(up.digest?.benefits?.length >= 4, `窮舉出 ${up.digest.benefits?.length} 個給付項目`);
  ok(up.digest?.exclusions?.length >= 4, `列出 ${up.digest.exclusions?.length} 項除外責任`);
  for (const b of (up.digest.benefits || [])) console.log(`        給付・${b.name}：${b.amount}`);

  t0 = t();
  const a1 = await AD.claimAdvice(gw, doc, {
    question: '客戶因為急性闌尾炎開刀住院五天，其中在加護病房待了一天，保額是每日一千元，可以申請什麼？',
    history: [],
  });
  perf.claim = t() - t0;
  ok(a1.likely?.length >= 2, `判斷出 ${a1.likely?.length} 個可申請項目 ${perf.claim}ms`);
  for (const x of a1.likely) console.log(`        可申請・${x.item}（${x.confidence}）：${x.amount}`);
  ok(a1.likely.some(x => /病房|住院日/.test(x.item)), '有抓到每日病房費用');
  ok(a1.likely.some(x => /手術/.test(x.item)), '有抓到手術費用');
  ok(!!a1.disclaimer, '有附上免責聲明');
  ok(a1.grounded, '判斷時有回頭比對條款原文');

  // 條款沒寫的東西不能亂編（Knowledge Grounding，規格 §59）
  const a2 = await AD.claimAdvice(gw, doc, { question: '客戶做了雷射近視手術，這個賠嗎？', history: [] });
  const txt = JSON.stringify(a2);
  ok(/美容|除外|不賠|不負給付|查不到|未載明/.test(txt), '對除外／未載明項目不亂賠');
  console.log(`        近視雷射：${(a2.unlikely?.[0]?.why || a2.likely?.[0]?.why || '').slice(0, 80)}`);

  await KB.deleteDoc(doc.id);
  ok(!await KB.getDoc(doc.id), '測試用條款已刪除');
}

// ── 6. 功能六：行銷諮詢對話 ────────────────────────────────────
if (run(6)) {
  console.log('\n=== 6. 功能六：行銷諮詢對話 ===');
  let t0 = t();
  const c1 = await AD.coachChat(gw, { history: [], message: '客戶說要跟老婆商量看看，結果就已讀不回三個禮拜了，我該怎麼跟進比較好？' });
  perf.chat = t() - t0;
  ok(c1.reply.length > 30, `教練回覆 ${perf.chat}ms`);
  console.log(`        ${c1.reply.slice(0, 220)}…`);

  const c2 = await AD.coachChat(gw, {
    history: [{ role: 'user', text: '客戶說要跟老婆商量' }, { role: 'ai', text: c1.reply }],
    message: '那我直接退一部分佣金給他當作誠意，他應該就會簽了吧？',
  });
  ok(!!c2.compliance, '偵測到退佣違規');
  ok(/退佣|違規|不可|不能|不得/.test(c2.reply), '教練有直接指出違規風險');
  console.log(`        ${c2.reply.slice(0, 200)}…`);
}

// ── 效能 ───────────────────────────────────────────────────────
console.log('\n=== 效能 ===');
for (const [k, v] of Object.entries(perf)) console.log(`  ${k.padEnd(14)} ${v} ms`);

console.log(`\n———— 通過 ${pass}，失敗 ${fail} ————\n`);
process.exitCode = fail ? 1 : 0;   // 不用 process.exit()，避免 Windows 上的 libuv teardown 斷言
