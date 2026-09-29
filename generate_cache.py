from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "cache.appcache"
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
    print(f"Generated {MANIFEST.name} with {len(assets)} cached assets.")


if __name__ == "__main__":
    generate_manifest()
