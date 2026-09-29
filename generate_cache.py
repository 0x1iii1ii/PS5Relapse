import json
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "cache.appcache"
SERVICE_WORKER = ROOT / "service-worker.js"
GENERATED_FILES = {SERVICE_WORKER.name}
CACHEABLE_SUFFIXES = {
    ".bin",
    ".css",
    ".elf",
    ".gif",
    ".htm",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
}


def iter_assets():
    for path in sorted(ROOT.rglob("*")):
        relative_path = path.relative_to(ROOT)
        if (
            not path.is_file()
            or path.suffix.lower() not in CACHEABLE_SUFFIXES
            or path.name in GENERATED_FILES
            or any(part.startswith(".") for part in relative_path.parts)
        ):
            continue
        yield path, relative_path.as_posix()


def generate_manifest():
    assets = list(iter_assets())
    digest = sha256()
    for path, relative_path in assets:
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as asset:
            for chunk in iter(lambda: asset.read(1024 * 1024), b""):
                digest.update(chunk)

    lines = [
        "CACHE MANIFEST",
        f"# {digest.hexdigest()}",
        "",
        "CACHE:",
        "./",
        *(relative_path for _, relative_path in assets),
        "",
        "NETWORK:",
        "*",
        "",
    ]
    MANIFEST.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    write_service_worker(assets, digest.hexdigest())
    print(f"Generated {MANIFEST.name} with {len(assets)} cached assets.")


def write_service_worker(assets, build_id):
    urls = ["./", *(relative_path for _, relative_path in assets)]
    source = f"""const CACHE_PREFIX = "ps5-relapse-";
const CACHE_NAME = CACHE_PREFIX + {json.dumps(build_id)};
const PRECACHE_URLS = {json.dumps(urls, indent=2)};

self.addEventListener("install", (event) => {{
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
}});

self.addEventListener("activate", (event) => {{
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
}});

self.addEventListener("fetch", (event) => {{
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {{
    return;
  }}

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {{
        if (cached) return cached;
        return fetch(request).then((response) => {{
          if (response.ok && response.type === "basic") {{
            cache.put(request, response.clone());
          }}
          return response;
        }}).catch((error) => {{
          if (request.mode === "navigate") {{
            return cache.match(new URL("index.html", self.registration.scope));
          }}
          throw error;
        }});
      }}),
    ),
  );
}});
"""
    SERVICE_WORKER.write_text(source, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    generate_manifest()
