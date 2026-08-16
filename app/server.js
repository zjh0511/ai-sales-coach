// AI業務教練 — 本機開發伺服器（零外部相依，只用 Node 內建模組）
// HTTPS 是必要的：iOS Safari 只在 secure context 下才給麥克風權限。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import crypto from 'node:crypto';
import { PROVIDERS, createAdapter, scrubKey, friendlyError } from './lib/gateway.js';
import * as CE from './lib/session.js';
import * as KB from './lib/knowledge.js';
import * as AD from './lib/advisor.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(DIR, 'public');
const CERT = path.join(DIR, 'certs');

// 雲端平台（Render 等）自己處理 HTTPS，只要在指定 PORT 上跑純 HTTP。
// 本機開發則需要自簽憑證，否則 iPhone 拿不到麥克風權限。
const CLOUD = process.env.CLOUD === '1' || !!process.env.RENDER;
const HTTPS_PORT = Number(process.env.PORT || 8443);
const HTTP_PORT = HTTPS_PORT + 1;

// 選用的通行碼，可再加一層擋住不相干的人打開網址
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();

// ── 每位使用者用自己的金鑰 ─────────────────────────────────────
// 金鑰只存在使用者瀏覽器，隨每次請求送來，伺服器不寫入磁碟、不寫進日誌。
// 這裡只快取「已完成模型探測的 adapter 實例」，避免每次請求都重新探測。
const adapters = new Map();
const ADAPTER_TTL = 2 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of adapters) if (now - v.touched > ADAPTER_TTL) adapters.delete(k);
}, 10 * 60 * 1000).unref?.();

const fingerprint = (provider, key) =>
  provider + ':' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);

async function getAdapter(provider, key) {
  if (!provider || !key) {
    const e = new Error('尚未設定 API 金鑰，請重新登入'); e.code = 401; throw e;
  }
  const id = fingerprint(provider, key);
  const hit = adapters.get(id);
  if (hit) { hit.touched = Date.now(); return hit.gw; }

  const gw = createAdapter(provider, key);
  try {
    await gw.init();                     // 探測可用模型，順便驗證金鑰
  } catch (err) {
    const e = new Error(friendlyError(scrubKey(err.message, key), provider));
    e.code = 401;                        // 金鑰有問題 → 讓前端回到登入畫面
    throw e;
  }
  adapters.set(id, { gw, touched: Date.now() });
  return gw;
}

// ── 靜態檔 ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not Found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// ── API ────────────────────────────────────────────────────────
const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }).end(b);
};

const MAX_BODY = 26 * 1024 * 1024;   // 檔案以 base64 夾在 JSON 裡上傳

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > MAX_BODY) { req.destroy(); reject(new Error('檔案太大')); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const need = (b, id) => {
  const s = CE.getSession(id);
  if (!s) { const e = new Error('session_not_found'); e.code = 404; throw e; }
  return s;
};

async function api(req, res, route) {
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (route === '/api/health') {
    return json(res, 200, {
      ok: true, sessions: CE.sessionCount(), auth: !!ACCESS_CODE,
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, {
        label: v.label, note: v.note, hint: v.hint, url: v.url, file: !!v.file, verified: !!v.verified,
      }])),
    });
  }

  if (route === '/api/auth') {
    return json(res, 200, { ok: !ACCESS_CODE || body.code === ACCESS_CODE });
  }

  // 通行碼（未設定 ACCESS_CODE 時等於不啟用）
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) {
    return json(res, 401, { error: '通行碼錯誤或已失效，請重新輸入' });
  }

  const provider = req.headers['x-ai-provider'];
  const apiKey = req.headers['x-ai-key'];

  // 登入：實際打一次該供應商的 API 驗證金鑰，順便回報偵測到的模型
  if (route === '/api/login') {
    const gw = await getAdapter(body.provider, body.key);
    return json(res, 200, { ok: true, provider: body.provider, fast: gw.fast, judge: gw.judge, file: gw.supportsFile });
  }

  // 其餘 API 一律使用呼叫者自己的金鑰
  const gw = await getAdapter(provider, apiKey);

  // ── 功能一：客戶潛在痛點分析 ──
  if (route === '/api/analyze/pain') {
    const { gender, age, background } = body;
    if (!gender || !age || !background) return json(res, 400, { error: '請填寫客戶性別、年齡與背景' });
    return json(res, 200, await AD.painPoints(gw, { gender, age, background }));
  }

  // ── 功能二／三／四：角色扮演 ──
  if (route === '/api/session/start') {
    const { mode, gender, age, background, difficulty, docId, context, contextNote } = body;
    if (!gender || !age || !background) return json(res, 400, { error: '請填寫客戶性別、年齡與背景' });
    let doc = null;
    if (mode === 'product') {
      doc = KB.getDoc(docId);
      if (!doc) return json(res, 400, { error: '請先選擇一份商品教材' });
    }
    return json(res, 200, await CE.startSession(gw, {
      mode: mode || 'call', gender, age, background, difficulty: Number(difficulty) || 2, doc,
      context: context || 'cold', contextNote: (contextNote || '').slice(0, 300),
    }));
  }

  if (route === '/api/session/begin') {
    return json(res, 200, CE.beginRoleplay(need(body, body.sessionId)));
  }

  if (route === '/api/session/turn') {
    const s = need(body, body.sessionId);
    return json(res, 200, await CE.handleTurn(gw, s, body.text));
  }

  if (route === '/api/session/end') {
    const s = need(body, body.sessionId);
    const out = await CE.evaluate(gw, s);
    CE.dropSession(s.id);
    return json(res, 200, out);
  }

  if (route === '/api/session/abort') {
    CE.dropSession(body.sessionId);
    return json(res, 200, { ok: true });
  }

  // ── 文件知識庫（功能四、五共用）──
  if (route === '/api/doc/list') return json(res, 200, { docs: KB.listDocs(body.kind) });

  if (route === '/api/doc/upload') {
    const { name, kind, base64 } = body;
    if (!name || !base64) return json(res, 400, { error: '沒有收到檔案' });
    if (kind !== 'product' && kind !== 'policy') return json(res, 400, { error: '未指定文件用途' });
    return json(res, 200, await KB.ingest(gw, { name, kind, base64 }));
  }

  if (route === '/api/doc/get') {
    const d = KB.getDoc(body.id);
    if (!d) return json(res, 404, { error: '找不到這份文件' });
    return json(res, 200, { id: d.id, name: d.name, kind: d.kind, title: d.title, digest: d.digest });
  }

  if (route === '/api/doc/delete') return json(res, 200, { ok: KB.deleteDoc(body.id) });

  // ── 功能五：理賠諮詢建議 ──
  if (route === '/api/claim/ask') {
    const doc = KB.getDoc(body.docId);
    if (!doc) return json(res, 400, { error: '請先選擇一份保單條款' });
    if (!body.question?.trim()) return json(res, 400, { error: '請描述客戶的狀況' });
    return json(res, 200, await AD.claimAdvice(gw, doc, { question: body.question, history: body.history }));
  }

  // ── 功能六：行銷諮詢建議 ──
  if (route === '/api/coach/chat') {
    if (!body.message?.trim()) return json(res, 400, { error: '請輸入內容' });
    return json(res, 200, await AD.coachChat(gw, { history: body.history, message: body.message }));
  }

  return json(res, 404, { error: 'unknown_endpoint' });
}

// ── Router ─────────────────────────────────────────────────────
async function handler(req, res) {
  const route = new URL(req.url, 'http://x').pathname;
  if (!route.startsWith('/api/')) return serveStatic(req, res);
  try {
    await api(req, res, route);
  } catch (e) {
    const code = e.code === 401 ? 401 : e.code === 404 ? 404 : 500;
    // 錯誤訊息不得回吐金鑰
    const safe = friendlyError(scrubKey(e.message, req.headers['x-ai-key']), req.headers['x-ai-provider']);
    console.error(`[api] ${route} → ${safe.slice(0, 200)}`);
    const msg = code === 401 ? safe
      : code === 404 ? '這次練習的連線已經逾時，請重新開始。'
        : /金鑰|額度|權限|不支援|連不上|服務商/.test(safe) ? safe
          : '剛剛好像卡了一下，請再試一次。';
    json(res, code, { error: msg });
  }
}

// ── 啟動 ───────────────────────────────────────────────────────
console.log(`可用 AI 服務商：${Object.values(PROVIDERS).map(p => p.label).join('、')}`);
console.log('每位使用者需在登入畫面輸入自己的 API 金鑰');
if (ACCESS_CODE) console.log('已啟用通行碼保護');

if (CLOUD) {
  // 雲端：平台負責 TLS，這裡只跑 HTTP
  http.createServer(handler).listen(HTTPS_PORT, '0.0.0.0',
    () => console.log(`\n  AI業務教練 已啟動（雲端模式）port ${HTTPS_PORT}\n`));
} else {
  if (!fs.existsSync(path.join(CERT, 'cert.pem'))) {
    console.error('\n找不到憑證。請先執行：  node tools/gencert.mjs\n');
    process.exit(1);
  }

  const lanIPs = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

  https.createServer({
    key: fs.readFileSync(path.join(CERT, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT, 'cert.pem')),
  }, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`\n  AI業務教練 已啟動\n`);
    console.log(`  電腦：   https://localhost:${HTTPS_PORT}`);
    for (const ip of lanIPs) console.log(`  手機：   https://${ip}:${HTTPS_PORT}`);
    console.log(`\n  手機第一次開啟會出現憑證警告 → 「顯示詳細資訊」→「瀏覽此網站」\n`);
  });

  // HTTP：localhost 直接服務（瀏覽器視 localhost 為安全來源，麥克風可用）；
  // 其他位址一律導轉 HTTPS，否則手機拿不到麥克風權限。
  http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host === 'localhost' || host === '127.0.0.1') return handler(req, res);
    res.writeHead(301, { location: `https://${host}:${HTTPS_PORT}${req.url}` }).end();
  }).listen(HTTP_PORT, '0.0.0.0', () => console.log(`  本機除錯（免憑證）： http://localhost:${HTTP_PORT}\n`));
}
