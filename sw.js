// sw.js - makes the app work without internet after the first visit (same idea as Modather Hub).
// To publish an update: change VERSION, upload the files, and the app tells the user to reopen it.
const VERSION = "v23";
const SHELL_CACHE = "mtranslate-shell-" + VERSION;
const CDN_CACHE = "mtranslate-cdn-v1";

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./layout.js",
  "./pdfwriter.js",
  "./zipwriter.js",
  "./worker.js",
  "./tts-worker.js",
  "./supertonic-worker.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-64.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

async function tell(msg) {
  const all = await self.clients.matchAll();
  all.forEach((c) => c.postMessage(msg));
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const old = keys.filter((k) => k.startsWith("mtranslate-shell-") && k !== SHELL_CACHE);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (old.length) tell("updated"); // an update, not the first install
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(shellFirst(req));
  } else if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com" || url.hostname === "unpkg.com") {
    e.respondWith(cdnFirst(req));
  }
  // everything else (the translation model files) is cached by the library itself
});

// network first (so files from different versions never get mixed), cache as the offline fallback
async function shellFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res && res.ok) {
      cache.put(req, res.clone());
      return res;
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    return hit || (await cache.match("./index.html")) || new Response("Offline", { status: 503 });
  }
}

async function cdnFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // only real, successful answers are kept (an opaque or failed answer must never be cached forever)
  if (res && res.ok && res.status === 200) cache.put(req, res.clone());
  return res;
}
