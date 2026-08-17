// Compliance Engine（規則優先，不依賴 LLM 自行判斷）
// Level 1 關鍵字 → Level 3 高風險阻擋 → Level 4 演練後回饋
// 註：詞庫需依最新「保險業務員管理規則」與所屬公司規範持續校正。
// 參考來源：https://law.lia-roc.org.tw/Law/Content?lsid=FL006761

const HIGH = [
  { re: /退佣|退傭|折佣|回扣|佣金.{0,4}退|退.{0,4}佣金/, type: '退佣', why: '以佣金回饋招攬，違反保險業務員管理規則之不得有不當招攬行為。' },
  { re: /紅包|包紅包|現金回饋|給你.{0,3}現金|請你吃飯換|送你.{0,4}(禮券|現金|禮金)/, type: '不當利益', why: '以財物、折扣或其他利益作為招攬對價，屬不正當招攬。' },
  { re: /保證(獲利|賺|收益|報酬|還本|不賠|通過)|穩賺|穩賺不賠|一定.{0,3}(賺|不會賠)|絕對不會賠|包你賺/, type: '保證收益', why: '對保險商品之投資報酬或核保結果作保證性承諾，屬不實招攬。' },
  { re: /代簽|幫你簽|幫忙簽名|代填(要保書|保單)|你不用看直接簽/, type: '代簽文件', why: '代要保人或被保險人簽章，屬重大違規行為。' },
  { re: /先不要跟公司說|不要告訴(核保|公司)|健康(狀況)?不要寫|隱瞞病史|不用告知/, type: '誘導不實告知', why: '誘導要保人不實告知，可能構成保險詐欺並導致理賠爭議。' },
];

const WARN = [
  { re: /存錢|定存|存款/, type: '類儲蓄用語', why: '將保險比擬為存款，易誤導商品性質。' },
  { re: /利息|利率比|報酬率|比銀行(好|高)/, type: '收益比較', why: '與銀行存款作收益比較，須有合規文件依據且不得誤導。' },
  { re: /停售|最後一天|最後.{0,3}機會|只剩.{0,4}名額|限量/, type: '促銷話術', why: '以停售或急迫性促銷，屬不當招攬手法。' },
  { re: /免費|送你|不用錢/, type: '贈與暗示', why: '易被認定為以利益招攬，用語需謹慎。' },
];

export function checkCompliance(text) {
  if (!text) return { level: 'none', hits: [] };
  const hits = [];
  for (const r of HIGH) if (r.re.test(text)) hits.push({ ...r, re: undefined, level: 'high' });
  for (const r of WARN) if (r.re.test(text)) hits.push({ ...r, re: undefined, level: 'warn' });
  const level = hits.some(h => h.level === 'high') ? 'high' : hits.length ? 'warn' : 'none';
  return { level, hits };
}

// 高風險 → 立即中斷演練並提示（產品規格 §35：演練期間即時阻止）
export function interventionMessage(hits) {
  const h = hits.filter(x => x.level === 'high');
  const list = h.map(x => `・${x.type}：${x.why}`).join('\n');
  return `⚠️ 合規提醒（演練暫停）\n\n你剛才的說法可能涉及違規：\n${list}\n\n請改用不涉及利益交換與收益保證的說法，再繼續演練。`;
}
