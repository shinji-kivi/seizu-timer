// 製図時間管理ツール Service Worker
//
// 方針:
//   - HTML はネットワーク優先。オンラインなら常に最新が表示され、
//     オフラインのときだけキャッシュを使う。PWA にありがちな
//     「更新したのに古い画面が貼り付く」事故を避けるため
//   - JS・画像はキャッシュ優先。オフラインでも分析画面のグラフまで動く
//
// vendor/chart.umd.min.js やアイコンを差し替えたときは CACHE の版数を上げる
// (HTML はネットワーク優先なので、HTML だけの更新では上げ直す必要はない)
const CACHE = 'seizu-v1';

const ASSETS = [
  './',
  './index.html',
  './help.html',
  './manifest.json',
  './vendor/chart.umd.min.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cachePut(request, response) {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy));
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== location.origin) return;

  // 画面遷移(HTML)はネットワーク優先、失敗したらキャッシュ
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => cachePut(request, res))
        .catch(() => caches.match(request).then(res => res || caches.match('./index.html')))
    );
    return;
  }

  // それ以外はキャッシュ優先
  event.respondWith(
    caches.match(request).then(res => res || fetch(request).then(r => cachePut(request, r)))
  );
});
