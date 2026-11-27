import base64
import datetime as dt
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from unittest.mock import patch


source = Path(__file__).with_name("owner-backup-copy.py")
spec = importlib.util.spec_from_file_location("owner_backup_copy", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
age = Path(sys.argv[1]).resolve(strict=True)
keygen = Path(sys.argv[2]).resolve(strict=True)
os.umask(0o077)

with tempfile.TemporaryDirectory(prefix="accountpulse-owner-copy-test-") as path:
    root = Path(path)
    backup_dir = root / "backups"
    backup_dir.mkdir()
    (root / ".release.lock").touch()
    now = dt.datetime.now(dt.timezone.utc)
    archive = backup_dir / f"pre-{'a' * 40}-{now:%Y%m%dT%H%M%SZ}.dump"
    plaintext = b"PGDMP" + os.urandom(16000)
    archive.write_bytes(plaintext)
    (backup_dir / f"pre-{'b' * 40}-{now:%Y%m%dT%H%M%SZ}.dump").symlink_to(archive)
    ssh_dir = root / "ssh"
    ssh_dir.mkdir()
    authorized = ssh_dir / "authorized_keys"
    initial = b"# existing grants\nssh-example existing-key original\n"
    authorized.write_bytes(initial)
    recovery_key = root / "recovery"
    subprocess.run([keygen, "-o", recovery_key], stderr=subprocess.DEVNULL, check=True)
    recipient = subprocess.check_output([keygen, "-y", recovery_key], text=True).strip()
    public = base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + os.urandom(32)).decode("ascii")
    transfer_id = "0" * 24
    stage = root / f".owner-copy-{transfer_id}"
    stage.mkdir()
    shutil.copyfile(source, stage / "copy.py")
    shutil.copyfile(age, stage / "age")
    (stage / "age").chmod(0o700)

    with patch.object(module, "ssh_files", return_value=authorized), patch("sys.stdout", new_callable=io.StringIO):
        module.stage_copy(root, stage, transfer_id, recipient, public)
        ciphertext = (stage / "archive.age").read_bytes()
        checksum = hashlib.sha256(ciphertext).hexdigest()
        assert plaintext not in ciphertext
        restored = subprocess.check_output([age, "--decrypt", "--identity", recovery_key, stage / "archive.age"])
        assert restored == plaintext
        key_data = authorized.read_bytes()
        assert key_data.startswith(initial)
        assert b'restrict,expiry-time="' in key_data and b'command="/usr/bin/timeout 120 ' in key_data
        for command in ("sh", f"confirm:{'0' * 64}"):
            with patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command):
                try:
                    module.transfer(stage)
                except ValueError:
                    assert authorized.read_bytes() == key_data and stage.is_dir()
                else:
                    raise AssertionError("Unexpected transfer action was accepted")
        payload = io.BytesIO()
        with patch.dict(os.environ, SSH_ORIGINAL_COMMAND="download"), patch.object(sys.stdout, "buffer", payload, create=True):
            module.transfer(stage)
        assert payload.getvalue() == ciphertext
        with patch.dict(os.environ, SSH_ORIGINAL_COMMAND=f"confirm:{checksum}"):
            module.transfer(stage)
        assert authorized.read_bytes() == initial
        assert not stage.exists() and archive.read_bytes() == plaintext

print("Encrypted owner backup copy synthetic test passed.")
