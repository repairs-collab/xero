import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "owner_recurring_backup", Path(__file__).with_name("owner-recurring-backup.py")
)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

ARCHIVE = "accountpulse-20261127T023000Z-0123456789abcdef.dump.age"
PAYLOAD = b"age-encryption.org/v1\nsynthetic ciphertext only\n"
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
MANIFEST = f"{ARCHIVE} {len(PAYLOAD)} {DIGEST}\n".encode("ascii")


class OwnerBackupTest(unittest.TestCase):
    def test_manifest_has_fixed_bounds_and_an_exact_filename(self):
        self.assertEqual(backup.parse_manifest(MANIFEST), (ARCHIVE, len(PAYLOAD), DIGEST))
        for invalid in (
            MANIFEST.replace(b"accountpulse-", b"../accountpulse-"),
            MANIFEST.replace(b"20261127", b"20261341"),
            MANIFEST.replace(f" {len(PAYLOAD)} ".encode(), b" 134217729 "),
            MANIFEST.replace(DIGEST.encode(), b"A" * 64),
            MANIFEST + b"extra\n",
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                backup.parse_manifest(invalid)

    def test_latest_only_and_binary_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "latest").write_bytes(MANIFEST)
            (path / ARCHIVE).write_bytes(PAYLOAD)
            with patch.object(backup, "open_export", side_effect=lambda entry: entry.open("rb")):
                output = io.BytesIO()
                self.assertEqual(backup.serve(path, "metadata", output), 0)
                self.assertEqual(output.getvalue(), MANIFEST)
                output = io.BytesIO()
                self.assertEqual(backup.serve(path, f"fetch {DIGEST}", output), 0)
                self.assertEqual(output.getvalue(), PAYLOAD)
                output = io.BytesIO()
                self.assertEqual(backup.serve(path, f"fetch {'0' * 64}", output), 75)
                self.assertEqual(output.getvalue(), b"")
                for command in ("ls", "fetch ../../other", "metadata; sh"):
                    with self.assertRaises(ValueError):
                        backup.serve(path, command, output)
                (path / ARCHIVE).write_bytes(b"partial")
                with self.assertRaises(ValueError):
                    backup.serve(path, "metadata", io.BytesIO())

    def test_failed_backup_preserves_previous_export(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "latest").write_bytes(MANIFEST)
            (path / ARCHIVE).write_bytes(PAYLOAD)
            with patch.object(backup, "secure_output"), self.assertRaises(RuntimeError):
                def interrupted(target):
                    target.write(b"incomplete")
                    raise RuntimeError("synthetic interrupted dump")

                backup.publish(path, 42, interrupted)
            self.assertEqual(sorted(entry.name for entry in path.iterdir()), [ARCHIVE, "latest"])
            self.assertEqual((path / "latest").read_bytes(), MANIFEST)

    def test_success_atomically_publishes_ciphertext_and_verified_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "latest").write_bytes(MANIFEST)
            (path / ARCHIVE).write_bytes(PAYLOAD)
            fresh = PAYLOAD + b"new data"
            with patch.object(backup, "secure_output"), patch.object(backup, "sync_directory"):
                backup.publish(path, 42, lambda target: target.write(fresh))
            name, size, checksum = backup.parse_manifest((path / "latest").read_bytes())
            self.assertNotEqual(name, ARCHIVE)
            self.assertEqual((path / name).read_bytes(), fresh)
            self.assertEqual((size, checksum), (len(fresh), hashlib.sha256(fresh).hexdigest()))
            self.assertEqual(sorted(entry.name for entry in path.iterdir()), sorted([ARCHIVE, name, "latest"]))

    def test_retention_removes_only_old_owned_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            for day in range(1, 6):
                (path / ARCHIVE.replace("20261127", f"2026110{day}")).write_bytes(PAYLOAD)
            (path / "private-file").write_bytes(b"unrelated")
            with patch.object(backup, "is_owned_archive", return_value=True):
                backup.prune(path, ARCHIVE)
            copies = sorted(item.name for item in path.glob("*.age"))
            self.assertEqual(copies, [ARCHIVE.replace("20261127", f"2026110{d}") for d in (4, 5)])
            self.assertTrue((path / "private-file").is_file())


if __name__ == "__main__":
    unittest.main()
