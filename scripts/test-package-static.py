import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import zipfile

spec = importlib.util.spec_from_file_location("package_static", Path(__file__).with_name("package-static.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "out"
        for name in ("index.html", "icons/icon-192.png", "icons/icon-512.png", "_next/static/main.js"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
        (self.source / "index.html").write_text('<script src="/_next/static/main.js?v=1"></script>')
        (self.source / "manifest.webmanifest").write_text(json.dumps({"start_url": "./", "scope": "./"}))
        for name in ("LICENSE", "NOTICE", ".env"):
            (self.root / name).write_text(name)

    def package(self, revision="a" * 40):
        return module.package(self.source, self.root / "dist", revision, self.root)

    def test_archive_provenance_and_checksum(self):
        archive = self.package()
        with zipfile.ZipFile(archive) as output:
            self.assertNotIn(".env", output.namelist())
            self.assertIn("LICENSE", output.namelist())
            self.assertIn("NOTICE", output.namelist())
            self.assertEqual(json.loads(output.read("build-info.json"))["commit"], "a" * 40)
        self.assertEqual(archive.with_suffix(".zip.sha256").read_text(), f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")

    def test_reject_missing_asset(self):
        (self.source / "icons/icon-192.png").unlink()
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_symlink(self):
        (self.source / "leak").symlink_to(self.root / ".env")
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_missing_notice(self):
        (self.root / "NOTICE").unlink()
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_short_revision(self):
        with self.assertRaises(ValueError):
            self.package("abc123")

    def test_reject_external_start_url(self):
        (self.source / "manifest.webmanifest").write_text(json.dumps({"start_url": "https://example.com", "scope": "./"}))
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_root_symlink(self):
        link = self.root / "linked-out"
        link.symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.package(link, self.root / "dist", "a" * 40, self.root)

    def test_reject_destination_symlink(self):
        (self.root / "dist").symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_output_symlinks(self):
        destination = self.root / "dist"
        destination.mkdir()
        for name in ("m3e-canvas-next-aaaaaaaaaaaa-static.zip", "m3e-canvas-next-aaaaaaaaaaaa-static.zip.sha256"):
            path = destination / name
            path.symlink_to(self.root / ".env")
            with self.assertRaises(ValueError):
                self.package()
            path.unlink()

    def test_reject_license_symlink(self):
        (self.root / "LICENSE").unlink()
        (self.root / "LICENSE").symlink_to(self.root / ".env")
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_reserved_entries(self):
        for name in ("LICENSE", "NOTICE", "build-info.json"):
            path = self.source / name
            path.write_text("collision")
            with self.assertRaises(ValueError):
                self.package()
            path.unlink()

    def test_reject_missing_referenced_asset(self):
        (self.source / "index.html").write_text('<script src="/_next/static/missing.js"></script>')
        with self.assertRaises(ValueError):
            self.package()

    def test_reject_subpath_asset(self):
        (self.source / "index.html").write_text('<script src="/repo/_next/static/main.js"></script>')
        with self.assertRaises(ValueError):
            self.package()

    def test_deterministic_archive(self):
        first = self.package().read_bytes()
        self.assertEqual(first, self.package().read_bytes())

    def test_reject_wrong_head(self):
        with patch.object(module.subprocess, "check_output", return_value="b" * 40):
            with self.assertRaises(ValueError):
                module.verify_revision("a" * 40)

    def test_reject_dirty_tracked_source(self):
        with patch.object(module.subprocess, "check_output", return_value="a" * 40):
            with patch.object(module.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "git")):
                with self.assertRaises(subprocess.CalledProcessError):
                    module.verify_revision("a" * 40)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(PackageTests)
    result = unittest.TextTestRunner().run(suite)
    raise SystemExit(0 if result.testsRun > 0 and result.wasSuccessful() else 1)
