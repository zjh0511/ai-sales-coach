// Knowledge Engine — 文件上傳 → 解析 → 結構化知識庫。
// 依規格 §41：Ingestion → Knowledge Structuring → Retrieval → Coaching。
//
// 解析策略（零外部相依）：
//   .docx / .pptx  → 瀏覽器內解 ZIP+XML 取字（engine/docx.js）
//   .pdf           → 交給模型原生讀取（中文與掃描版都比自寫解析器可靠）
//   .txt / .md     → 直接讀
//
// 所有文件都存在使用者自己裝置的 IndexedDB，不會上傳到任何伺服器。

import { officeText } from './docx.js';
import { parseJson } from './gateway.js';
import { digestPrompt } from './prompts.js';
import { allDocs, putDoc, delDoc, getDocById } from './store.js';

const MAX_BYTES = 18 * 1024 * 1024;
const MAX_TEXT = 300_000;
const SOURCE_LIMIT = 6 * 1024 * 1024;

const ext = n => (n.split('.').pop() || '').toLowerCase();
const newId = () => Math.random().toString(36).slice(2, 10);

export async function listDocs(kind) {
  const docs = await allDocs();
  return docs
    .filter(d => !kind || d.kind === kind)
    .map(({ id, name, kind, title, at, chars, pages }) => ({ id, name, kind, title, at, chars, pages }))
    .sort((a, b) => b.at - a.at);
}

export const getDoc = id => getDocById(id);
export const deleteDoc = id => delDoc(id);

// base64 ↔ bytes（不經過 Node Buffer，瀏覽器也能用）
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// ── 上傳並建立知識庫 ────────────────────────────────────────────
export async function ingest(gw, { name, kind, base64 }) {
  const bytes = b64ToBytes(base64);
  const e = ext(name);

  if (bytes.length > MAX_BYTES) throw new Error(`檔案 ${(bytes.length / 1048576).toFixed(1)}MB 超過上限 18MB，請壓縮或分割後再上傳`);
  if (e === 'doc' || e === 'ppt' || e === 'xls') throw new Error(`不支援舊版 .${e} 格式，請用 Office 另存成 .${e}x 或 PDF`);

  // 1) 取得可送進模型的內容
  let text = null, file = null;
  if (e === 'pdf') {
    if (!gw.supportsFile) {
      throw new Error('你目前使用的 AI 服務商無法直接讀取 PDF。請改上傳 .docx／.pptx／.txt，或改用 Google Gemini 或 Anthropic Claude 的金鑰。');
    }
    file = { mime: 'application/pdf', data: base64 };
  } else if (e === 'docx' || e === 'pptx') {
    text = (await officeText(bytes, name)).slice(0, MAX_TEXT);
    if (text.length < 20) throw new Error('這個檔案讀不到文字，可能內容都是圖片。請改用 PDF 上傳。');
  } else if (e === 'txt' || e === 'md') {
    text = new TextDecoder('utf-8').decode(bytes).slice(0, MAX_TEXT);
  } else {
    throw new Error(`不支援的格式 .${e}，可用：PDF、DOCX、PPTX、TXT`);
  }

  // 2) Knowledge Structuring — 一次解析，之後查詢只用摘要，不必每次重送整份文件
  const prompt = digestPrompt(kind, name) + (text ? `\n\n【文件內容】\n${text}` : '');
  let digest = null;
  for (let i = 0; i < 3 && !digest?.title; i++) {
    const r = await gw.generate(prompt, {
      json: true, temp: 0.1 + i * 0.15, max: 32000, tier: 'judge', noThink: true, file,
    });
    digest = parseJson(r.text);
  }
  if (!digest?.title) throw new Error('這份文件解析失敗，可能格式特殊或內容過少');

  // 3) 保存（理賠查詢會回頭引用原文，所以 PDF 原檔也留著）
  const id = newId();
  const doc = {
    id, name, kind, title: digest.title || name, at: Date.now(),
    raw: e === 'pdf' && bytes.length <= SOURCE_LIMIT ? base64 : null,
    mime: e === 'pdf' ? 'application/pdf' : null,
    text, chars: text ? text.length : null,
    pages: (text?.match(/【第 \d+ 頁】/g) || []).length || null,
    digest,
  };
  await putDoc(doc);

  // 投影片多半是圖片時，取到的字會很少 → 明確提醒，而不是讓使用者拿到空洞的摘要
  let warning = null;
  if (text && text.length < 800 && (e === 'docx' || e === 'pptx')) {
    warning = `這份檔案只讀到 ${text.length} 個字，內容可能大多是圖片。`
      + '建議用 Office 另存成 PDF 再上傳，PDF 可以連圖片裡的文字一起讀。';
  } else if (kind === 'product' && (digest.selling_points || []).length < 2) {
    warning = '教材可辨識的商品資訊偏少，演練時 AI 能引用的內容有限。';
  } else if (kind === 'policy' && (digest.benefits || []).length < 2) {
    warning = '這份條款只解析出很少的給付項目，理賠判斷可能不完整，請確認上傳的是完整條款。';
  }

  return { id, title: doc.title, kind, digest, warning };
}

// ── 取得查詢時要附帶的原文（理賠判斷要求高準確度，值得回送原始檔）──
export function sourceFor(doc, gw) {
  if (doc.text) return { text: doc.text.slice(0, 120_000), file: null };
  if (!gw?.supportsFile || !doc.raw) return { text: null, file: null };
  return { text: null, file: { mime: doc.mime, data: doc.raw } };
}

// 給角色扮演用的商品重點（要短，塞進 persona prompt）
export function productBrief(doc) {
  const d = doc.digest || {};
  const lines = [`商品：${d.title || doc.name}`];
  if (d.overview) lines.push(`概述：${d.overview}`);
  if (d.target) lines.push(`適合對象：${d.target}`);
  for (const c of (d.coverages || []).slice(0, 8)) lines.push(`保障・${c.name}：${c.detail}`);
  for (const s of (d.selling_points || []).slice(0, 5)) lines.push(`賣點・${s.feature} → ${s.benefit}`);
  for (const o of (d.objections || []).slice(0, 4)) lines.push(`常見疑慮・${o.q}`);
  if (d.missing?.length) lines.push(`教材未載明（不得亂講）：${d.missing.join('；')}`);
  return lines.join('\n').slice(0, 4000);
}
