"""Package only a validated static export; never include the source working tree."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit
import zipfile


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("src", "href") and value:
                url = urlsplit(value)
                if not url.scheme and not url.netloc and "/_next/" in url.path:
                    self.paths.append(unquote(url.path).lstrip("/"))


def reject_symlink_path(path):
    for component in (path.absolute(), *path.absolute().parents):
        if component.is_symlink():
            raise ValueError(f"Symlink path is not allowed: {component}")


def verify_revision(revision):
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if actual != revision:
        raise ValueError("Requested revision does not match checked-out HEAD")
    # Include staged and unstaged tracked changes made by tests/build tools.
    subprocess.run(["git", "diff", "--exit-code", "--quiet", "HEAD", "--"], check=True)


def write_entry(output, name, data):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    output.writestr(info, data)


def package(source, destination, revision, licenses):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("A full Git commit SHA is required")
    source, destination = Path(source), Path(destination)
    reject_symlink_path(source)
    reject_symlink_path(destination)
    if destination.resolve().is_relative_to(source.resolve()):
        raise ValueError("Destination must be outside the static export")
    files = sorted(source.rglob("*"))
    if any(path.is_symlink() for path in files):
        raise ValueError("Static export must not contain symlinks")
    for reserved in ("LICENSE", "NOTICE", "build-info.json"):
        if (source / reserved).exists():
            raise ValueError(f"Reserved archive entry already exists: {reserved}")
    for required in ("index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"):
        if not (source / required).is_file():
            raise ValueError(f"Missing static asset: {required}")
    references = AssetReferences()
    references.feed((source / "index.html").read_text())
    if not references.paths:
        raise ValueError("Missing compiled asset references in index.html")
    for name in references.paths:
        if not name.startswith("_next/static/") or ".." in Path(name).parts or not (source / name).is_file():
            raise ValueError(f"Missing or non-root compiled asset: {name}")
    manifest = json.loads((source / "manifest.webmanifest").read_text())
    if manifest.get("start_url") != "./" or manifest.get("scope") != "./":
        raise ValueError("Archive requires a relative manifest scope and start URL")
    license_files = [Path(licenses) / name for name in ("LICENSE", "NOTICE")]
    for path in license_files:
        reject_symlink_path(path)
        if not path.is_file():
            raise ValueError("LICENSE and NOTICE are required")
    archive = destination / f"m3e-canvas-next-{revision[:12]}-static.zip"
    checksum = archive.with_suffix(".zip.sha256")
    reject_symlink_path(archive)
    reject_symlink_path(checksum)
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w") as output:
        for path in files:
            if path.is_file():
                write_entry(output, path.relative_to(source).as_posix(), path.read_bytes())
        for path in license_files:
            write_entry(output, path.name, path.read_bytes())
        write_entry(output, "build-info.json", json.dumps({"repository": "xue-ding-e/m3e-canvas-next", "commit": revision, "basePath": ""}) + "\n")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum.write_text(f"{digest}  {archive.name}\n")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="out")
    parser.add_argument("--destination", default="dist-static")
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    verify_revision(args.revision)
    print(package(args.source, args.destination, args.revision, "."))
