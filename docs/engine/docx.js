// 極簡 ZIP 讀取 + Office 文件取字（零外部相依）
// .docx / .pptx 本質都是 ZIP 裡的 XML。
// 解壓用瀏覽器內建的 DecompressionStream，Node 18+ 也有同一個 API，
// 所以同一份程式碼在瀏覽器與自我測試中都能跑。

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = (u8, a, b) => new TextDecoder('utf-8').decode(u8.subarray(a, b));

// ── ZIP ─────────────────────────────────────────────────────────
// 從尾端找 End of Central Directory，再走中央目錄取出各檔案項目。
function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP／Office 檔案');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();

  for (let i = 0; i < count && p + 46 <= u8.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    files.set(utf8(u8, p + 46, p + 46 + nameLen), { method, compSize, offset });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  return {
    names: () => [...files.keys()],
    async read(name) {
      const f = files.get(name);
      if (!f) return null;
      // 本地檔頭的名稱／額外欄位長度才是實際值，中央目錄的不一定相同
      if (dv.getUint32(f.offset, true) !== 0x04034b50) return null;
      const start = f.offset + 30 + dv.getUint16(f.offset + 26, true) + dv.getUint16(f.offset + 28, true);
      const data = u8.subarray(start, start + f.compSize);
      return f.method === 0 ? data : inflateRaw(data);
    },
  };
}

// ── XML 取字 ────────────────────────────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#'
    ? String.fromCodePoint(parseInt(e.slice(/^#x/i.test(e) ? 2 : 1), /^#x/i.test(e) ? 16 : 10))
    : (ENT[e] ?? m));

function texts(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(unesc(m[1]));
  return out;
}

const decode = u8 => new TextDecoder('utf-8').decode(u8);

// ── 對外：從 Office 檔案取出純文字 ──────────────────────────────
export async function officeText(bytes, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const zip = readZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  if (ext === 'docx') {
    const xml = decode(await zip.read('word/document.xml') || new Uint8Array());
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
      if (m) notes.set(+m[1], texts(decode(await zip.read(n)), 'a:t').join('').trim());
    }

    const out = [];
    for (let i = 0; i < slides.length; i++) {
      const xml = decode(await zip.read(slides[i])).replace(/<\/a:p>/g, '\n');
      const body = texts(xml, 'a:t').join('').trim();
      const note = notes.get(i + 1);
      out.push(`【第 ${i + 1} 頁】\n${body}${note ? `\n（備忘稿）${note}` : ''}`);
    }
    return out.join('\n\n').trim();
  }

  throw new Error(`不支援的格式：.${ext}`);
}
