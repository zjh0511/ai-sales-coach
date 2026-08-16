// 產生本機開發用自簽憑證（含所有區網 IP 的 SAN，iPhone 才連得上）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');
fs.mkdirSync(DIR, { recursive: true });

const CANDIDATES = ['openssl', 'C:/Program Files/Git/mingw64/bin/openssl.exe',
  'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files (x86)/Git/mingw64/bin/openssl.exe'];

const openssl = CANDIDATES.find(c => spawnSync(c, ['version'], { shell: false }).status === 0);
if (!openssl) {
  console.error('找不到 openssl。請安裝 Git for Windows（內含 openssl）後再執行。');
  process.exit(1);
}

const ips = Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(i => `IP:${i}`)].join(',');

const r = spawnSync(openssl, [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-sha256',
  '-keyout', path.join(DIR, 'key.pem'), '-out', path.join(DIR, 'cert.pem'),
  '-subj', '/CN=AiCoach Dev', '-addext', `subjectAltName=${san}`,
], { stdio: 'inherit' });

if (r.status !== 0) process.exit(1);
console.log(`\n憑證已產生於 ${DIR}`);
console.log(`涵蓋位址：${san}\n`);
