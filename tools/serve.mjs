// 本機開發用的靜態檔案伺服器。
// 正式站是 GitHub Pages，這支只是為了在手機上測試——
// iOS Safari 只在 HTTPS（或 localhost）下才給麥克風權限。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const CERT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
const HTTPS_PORT = Number(process.env.PORT || 8443);
const HTTP_PORT = HTTPS_PORT + 1;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function handler(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return res.writeHead(404).end('Not Found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

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
  console.log('\n  AI業務教練（本機開發）\n');
  console.log(`  電腦：   https://localhost:${HTTPS_PORT}`);
  for (const ip of lanIPs) console.log(`  手機：   https://${ip}:${HTTPS_PORT}`);
  console.log('\n  手機第一次開啟會出現憑證警告 → 「顯示詳細資訊」→「瀏覽此網站」\n');
});

// localhost 也算安全來源，走 HTTP 免憑證警告，方便電腦上除錯
http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1') return handler(req, res);
  res.writeHead(301, { location: `https://${host}:${HTTPS_PORT}${req.url}` }).end();
}).listen(HTTP_PORT, '0.0.0.0', () => console.log(`  本機除錯（免憑證）： http://localhost:${HTTP_PORT}\n`));
