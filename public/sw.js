// MonteCarloEdge service worker.
// - App shell / navigations: network-first (so updates land immediately when
//   online), falling back to cache when offline.
// - Hashed assets & others: stale-while-revalidate (instant, refresh in bg).
const CACHE = "mce-v110";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Treat navigations and the HTML document as "shell" → network-first.
  const isShell = req.mode === "navigate" ||
    (req.destination === "document") ||
    url.pathname.endsWith("/") || url.pathname.endsWith("index.html");

  if (isShell) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("./"))),
    );
    return;
  }

  // Everything else: stale-while-revalidate.
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
