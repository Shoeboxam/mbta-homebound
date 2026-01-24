// sw.js (shell-only, no MBTA/API caching)

const VERSION = "v6";
const SHELL_CACHE = `shell-${VERSION}`;

// Keep this list in sync with your actual built assets.
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./mbta.js",
  "./planner.js",
  "./state.js",
  "./ui.js",
  "./notify.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Remove old shell caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("shell-") && k !== SHELL_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle GET.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // IMPORTANT: do not intercept cross-origin requests (MBTA, etc.)
  if (url.origin !== self.location.origin) return;

  // Navigation: network-first, fallback to cached index.html for offline
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        // Try the network first so deploys show up immediately
        return await fetch(req);
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        // Offline fallback to app shell
        return (await cache.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // Same-origin assets: cache-first, then network, then (optional) offline fallback
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);

    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && res.ok) {
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      // If you have an offline asset fallback (optional), you can return it here.
      // For now, just fail normally.
      return Response.error();
    }
  })());
});
