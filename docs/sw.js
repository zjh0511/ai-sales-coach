// Service Worker — 讓 App 可以「加到主畫面」並在離線時至少開得起來。
//
// 策略刻意選 network-first（而不是常見的 cache-first）：
//   這個 App 的靜態檔加起來不到 400 KB，GitHub Pages 又快，
//   cache-first 省下的時間有限，卻會帶來「使用者拿到舊版程式」的風險。
//   開發期間我們已經被舊快取咬過一次（伺服器送出舊檔案，除錯半天），
//   在使用者裝置上發生同樣的事更難查。
//   所以：有網路就一定拿最新的，沒網路才用快取。
//
// 注意：離線時只有「介面」打得開。演練需要呼叫 AI 服務商的 API，
//   那一定要網路。這一點會在畫面上明確告知，不假裝可以離線練習。

const VERSION = 'v4';                 // 改版時遞增，activate 時會清掉舊快取
const CACHE = `aicoach-${VERSION}`;

// 應用外殼：離線時要能顯示介面與說明
const SHELL = [
  './', './index.html', './style.css', './app.js', './voice.js',
  './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png',
  './apple-touch-icon.png', './guide.html',
  './account-setup.html',
  './firebase-config.js',
  './engine/account.js',
  './engine/api.js', './engine/gateway.js', './engine/prompts.js',
  './engine/session.js', './engine/advisor.js', './engine/knowledge.js',
  './engine/docx.js', './engine/store.js', './engine/compliance.js', './engine/oauth.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 個別加入：任何一個 404 都不該讓整個安裝失敗
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                          // 只處理讀取
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                // AI API 一律直連，不經過快取

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // 導覽請求離線時退回首頁外殼
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('離線中，且這個資源沒有快取。', {
        status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
