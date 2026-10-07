import { assert, fetchChecked, AppError } from './security.mjs';
export const lawUrl = 'https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=G0390016';
export function parseLaw(html) {
  assert(html.includes('保險業務員管理規則'), 'LAW_SOURCE', '官方法規頁面無法辨識，已暫停教練回答。', 503);
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  const start = cleaned.search(/第\s*1\s*條/);
  assert(start >= 0, 'LAW_BODY', '未取得官方條文正文，請稍後重試。', 503);
  // Exclude navigation and footer contact details from the model's source material.
  const text = cleaned.slice(start, start + 21000).split(':::')[0].trim();
  assert(/第\s*19\s*條/.test(text) && /不實/.test(text), 'LAW_BODY', '官方條文不完整，已暫停教練回答。', 503);
  const version = cleaned.match(/修正日期\s*[:：]?\s*(民國\s*)?\d+\s*年\s*\d+\s*月\s*\d+\s*日/)?.[0] || '以本次官方正文為準';
  return { text, version };
}
export async function getLaw() {
  try {
    const response = await fetchChecked(lawUrl);
    const { text, version } = parseLaw(await response.text());
    const references = [];
    const article19 = text.match(/第\s*19\s*條([\s\S]*?)(?=第\s*19-1\s*條)/)?.[1] || '';
    for (const [label, id] of [['一','truth'],['四','rebate'],['五','misleading'],['十三','deposit-comparison']]) {
      const quote = article19.match(new RegExp(`(?:^|\\s)${label}、([^。]+。)`))?.[1];
      if (quote) references.push({ id, article: 19, quote });
    }
    assert(references.length === 4, 'LAW_REFERENCE', '官方條文段落辨識失敗，請稍後重試。', 503);
    return { id: 'insurance-sales-rules', title: '保險業務員管理規則', url: lawUrl, checkedAt: new Date().toISOString(), version, text, references };
  } catch { throw new AppError('LAW_UNAVAILABLE', '目前無法取得全國法規資料庫的完整條文，已暫停實質回答。請稍後重試。', 503); }
}
export function publicSource(source) { const { text, references, ...metadata } = source; return metadata; }

export function reviewSource(input){
 const source={...input};
 const article=source.text.match(/第\s*19\s*條([\s\S]*?)(?=第\s*19-1\s*條|第\s*20\s*條|$)/)?.[1]||'';
 source.references=(source.references||[]).map(r=>({...r}));
 for(const match of article.matchAll(/(?:^|\s)([一二三四五六七八九十]+)、([^。]+。)/g)){
  if(match[2].length>240)continue;
  const existing=source.references.find(r=>r.quote===match[2]);
  if(existing)existing.clause=match[1];
  else source.references.push({id:'article19-'+match[1],article:19,clause:match[1],quote:match[2]});
 }
 return source;
}
