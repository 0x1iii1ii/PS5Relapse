const CACHE_PREFIX = "ps5-relapse-";
const CACHE_NAME = CACHE_PREFIX + "9b5e0a2905ce47d27e544e6fafc809d2b529ce8354e8c404f2177af15d87c1e0";
const PRECACHE_URLS = [
  "./",
  "index.html",
  "offsets/10.00.js",
  "offsets/10.01.js",
  "offsets/10.20.js",
  "offsets/10.40.js",
  "offsets/10.60.js",
  "offsets/11.00.js",
  "offsets/11.20.js",
  "offsets/11.60.js",
  "offsets/12.00.js",
  "offsets/12.02.js",
  "offsets/12.20.js",
  "offsets/12.40.js",
  "offsets/12.60.js",
  "offsets/12.70.js",
  "offsets/13.00.js",
  "offsets/13.20.js",
  "offsets/13.40.js",
  "offsets/13.42.js",
  "offsets/13.60.js",
  "offsets/7.00.js",
  "offsets/7.01.js",
  "offsets/7.20.js",
  "offsets/7.40.js",
  "offsets/7.60.js",
  "offsets/7.61.js",
  "offsets/8.00.js",
  "offsets/8.20.js",
  "offsets/8.40.js",
  "offsets/8.60.js",
  "offsets/9.00.js",
  "offsets/9.20.js",
  "offsets/9.40.js",
  "offsets/9.60.js",
  "payloads/elfldr-ps5-1360.elf",
  "payloads/kexp_2026_05_25.bin",
  "payloads/pldmgr.elf",
  "src/appcache.js",
  "src/firmware.js",
  "src/kexp.js",
  "src/main.js",
  "src/relapse_exploit.js",
  "src/rop.js",
  "src/site.js",
  "src/utils/int64.js",
  "src/utils/mem.js",
  "src/utils/rop_slave.js",
  "src/utils/syscalls.js",
  "src/webkit.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === "basic") {
            cache.put(request, response.clone());
          }
          return response;
        }).catch((error) => {
          if (request.mode === "navigate") {
            return cache.match(new URL("index.html", self.registration.scope));
          }
          throw error;
        });
      }),
    ),
  );
});
