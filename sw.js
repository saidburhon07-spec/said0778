/* Вместе — service worker.
   Задача скромная: дать установить сайт как приложение и показать
   понятную страницу, если интернет пропал. Кэш держим коротким,
   чтобы после обновления люди не сидели на старой версии. */

const CACHE = 'vmeste-v4';
const ASSETS = ['/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Страницы всегда берём из сети: иначе обновления не доедут до людей.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => new Response(
        '<!doctype html><meta charset="utf-8"><style>body{background:#08090b;color:#e7eaf0;' +
        'font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:24px}' +
        '</style><div><h2>Нет интернета</h2><p>Проверьте соединение и обновите страницу.</p></div>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      ))
    );
    return;
  }

  // Картинки и манифест — из кэша, если сеть недоступна.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && ASSETS.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
