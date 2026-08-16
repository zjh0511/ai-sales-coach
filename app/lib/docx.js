// 極簡 ZIP 讀取 + Office 文件取字（零外部相依，只用 Node 內建 zlib）
// .docx / .pptx / .xlsx 本質都是 ZIP 裡的 XML，不需要任何套件。

import zlib from 'node:zlib';

// ── ZIP ─────────────────────────────────────────────────────────
// 從尾端找 End of Central Directory，再走中央目錄取出各檔案項目。
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP／Office 檔案');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, offset });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return {
    names: () => [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      // 本地檔頭的名稱／額外欄位長度才是實際值，中央目錄的不一定相同
      const lh = f.offset;
      if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + f.compSize);
      return f.method === 0 ? data : zlib.inflateRawSync(data);
    },
  };
}

// ── XML 取字 ────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : (ENT[e] ?? m));

function texts(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(unesc(m[1]));
  return out;
}

// ── 對外：從 Office 檔案取出純文字 ──────────────────────────────
export function officeText(buf, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const zip = readZip(buf);

  if (ext === 'docx') {
    const xml = zip.read('word/document.xml')?.toString('utf8') || '';
    // 先把段落／換行標記轉成換行，再抽 <w:t>
    return texts(xml.replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n'), 'w:t').join('').trim();
  }

  if (ext === 'pptx') {
    const slides = zip.names()
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
    const notes = new Map();
    for (const n of zip.names()) {
      const m = n.match(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/);
      if (m) notes.set(+m[1], texts(zip.read(n).toString('utf8'), 'a:t').join('').trim());
    }
    return slides.map((n, i) => {
      const body = texts(zip.read(n).toString('utf8').replace(/<\/a:p>/g, '\n'), 'a:t').join('').trim();
      const note = notes.get(i + 1);
      return `【第 ${i + 1} 頁】\n${body}${note ? `\n（備忘稿）${note}` : ''}`;
    }).join('\n\n').trim();
  }

  throw new Error(`不支援的格式：.${ext}`);
}
