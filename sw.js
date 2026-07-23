/* Service Worker · Offline-Cache für die Sprint-Kraftanalyse-PWA
 * Strategie: App-Shell beim Install vorab cachen, alles Übrige (CDN-Libs,
 * MediaPipe-WASM, Modell) zur Laufzeit "cache-first" nachladen.
 */
const CACHE = "sprint-kraft-v2";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./analysis.js",
  "./overlay.js",
  "./charts.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./pose_landmarker_full.task",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // Erfolgreiche GETs (auch CDN/WASM) zur Laufzeit cachen
        if (res && (res.ok || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);
    })
  );
});
