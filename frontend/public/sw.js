const CACHE_NAME = "radhya-hr-v3";
const STATIC_ASSETS = [
  "/manifest.json",
  "/logo192.png",
  "/logo512.png",
  "/favicon.png",
  "/favicon-32.png",
  "/apple-touch-icon.png"
];

// Install — cache the app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//  - /api/*           → network only (no cache)
//  - JS/CSS/HTML      → network first, fallback to cache (so updates always reach users)
//  - Images/icons etc → cache first (long-lived assets)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API: never cache
  if (url.pathname.startsWith("/api")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell / code: network first so new deploys are picked up immediately
  const isCode =
    url.pathname === "/" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.includes("/static/js/") ||
    url.pathname.includes("/static/css/");

  if (isCode) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else: cache first (images, fonts, manifest)
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// Background Sync — notify the app to replay queued location pings
self.addEventListener("sync", (event) => {
  if (event.tag === "location-ping") {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "REPLAY_LOCATION_PING" }));
      })
    );
  }
});
