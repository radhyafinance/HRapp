const CACHE_NAME = "radhya-hr-v11";
const STATIC_ASSETS = [
  "/manifest.json",
  "/logo192.png",
  "/logo512.png",
  "/favicon.png",
  "/favicon-32.png",
  "/apple-touch-icon.png"
];

// Install — cache the app shell, but DO NOT skip waiting.
// Staying in "waiting" lets the app show an "Update available" prompt
// and only activate when the user explicitly confirms the refresh.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Note: skipWaiting() is intentionally NOT called here.
  // It is triggered via a postMessage from the app after user confirmation.
});

// Activate — clean up old caches, then take control immediately
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// The app sends this message after the user taps "Refresh" in the update prompt.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Fetch strategy:
//  - /api/*           → network only (no cache)
//  - Navigation/HTML  → network first, fallback to cache root (so refresh on any SPA route stays fresh)
//  - JS/CSS           → network first, fallback to cache (so updates always reach users)
//  - Images/icons etc → cache first (long-lived assets)
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API: never cache
  if (url.pathname.startsWith("/api")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // SPA navigation (refresh on any client-side route like /attendance, /leaves)
  // Always go network-first; fall back to the cached app shell on offline.
  // Without this, refresh on a deep route could serve a stale HTML referencing
  // JS chunk hashes that no longer exist after a redeploy → blank page.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && event.request.method === "GET") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", clone));
          }
          return response;
        })
        .catch(() => caches.match("/").then((c) => c || caches.match(event.request)))
    );
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
