#!/usr/bin/env python3
"""Prepare and retrieve one encrypted release backup with a scoped SSH grant."""

import datetime as dt
import fcntl
import hashlib
import hmac
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time


MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
BACKUP_NAME = re.compile(r"pre-[0-9a-f]{40}-(\d{8}T\d{6}Z)\.dump")
SHA256 = re.compile(r"[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def protected(path, *, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    require(expected(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o022, "Unprotected file or directory.")
    return info


def ssh_files():
    directory = Path.home() / ".ssh"
    protected(directory, directory=True)
    return directory / "authorized_keys"


def change_keys(keys, stage, extra=None):
    marker = f" accountpulse-copy-{stage.name.removeprefix('.owner-copy-')}".encode()
    lock = keys.parent / ".accountpulse-owner-copy.lock"
    with os.fdopen(os.open(lock, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600), "r+") as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        previous = protected(keys)
        require(previous.st_size <= 131072, "Unexpected authorised keys size.")
        with os.fdopen(os.open(keys, os.O_NOFOLLOW | os.O_RDONLY), "rb") as source:
            original = source.read(131073)
        lines = original.splitlines(keepends=True)
        matching = [line for line in lines if line.startswith(b"restrict,expiry-time=")
                    and line.rstrip(b"\r\n").endswith(marker)]
        if extra is not None:
            require(not matching, "This transfer identifier already has a grant.")
            separator = b"\n" if original and not original.endswith(b"\n") else b""
            updated = original + separator + extra
        else:
            require(len(matching) <= 1, "Multiple entries match the transfer identifier.")
            if not matching:
                return
            updated = b"".join(line for line in lines if line not in matching)
        fd, name = tempfile.mkstemp(prefix=".owner-copy-keys-", dir=keys.parent)
        try:
            with os.fdopen(fd, "wb") as target:
                os.fchmod(target.fileno(), stat.S_IMODE(previous.st_mode))
                target.write(updated)
                target.flush()
                os.fsync(target.fileno())
            current = protected(keys)
            require((current.st_ino, current.st_mtime_ns, current.st_size) ==
                    (previous.st_ino, previous.st_mtime_ns, previous.st_size),
                    "Authorised keys changed during transfer preparation.")
            os.replace(name, keys)
        finally:
            Path(name).unlink(missing_ok=True)


def cleanup(stage):
    change_keys(ssh_files(), stage)
    for name in ("archive.age", "archive.sha256", "copy.py", "age"):
        (stage / name).unlink(missing_ok=True)
    stage.rmdir()


def select_backup(directory):
    protected(directory, directory=True)
    now = dt.datetime.now(dt.timezone.utc)
    candidates = []
    for path in directory.iterdir():
        match = BACKUP_NAME.fullmatch(path.name)
        if match and not path.is_symlink() and path.is_file():
            try:
                recorded = dt.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
            except ValueError:
                continue
            if dt.timedelta(minutes=-5) <= now - recorded <= dt.timedelta(days=2):
                candidates.append((recorded, path))
    require(candidates, "No eligible recent restore archive is present.")
    return max(candidates)[1]


def stage_copy(root, stage, transfer_id, recipient, ssh_public):
    require(re.fullmatch(r"age1[0-9a-z]{58}", recipient), "Invalid age public recipient.")
    require(re.fullmatch(r"AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}", ssh_public),
            "Invalid Ed25519 transfer public key.")
    protected(stage / "age")
    protected(stage / "copy.py")
    lock = os.open(root / ".release.lock", os.O_NOFOLLOW | os.O_RDONLY)
    with os.fdopen(lock, "rb") as guard:
        fcntl.flock(guard, fcntl.LOCK_SH | fcntl.LOCK_NB)
        backup = select_backup(root / "backups")
        with os.fdopen(os.open(backup, os.O_NOFOLLOW | os.O_RDONLY), "rb", buffering=0) as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode) and 5 < info.st_size <= MAX_ARCHIVE_BYTES
                    and shutil.disk_usage(stage).free >= info.st_size + 256 * 1024 * 1024,
                    "Backup size or staging capacity is outside the allowed bound.")
            require(source.read(5) == b"PGDMP", "Backup is not a PostgreSQL custom archive.")
            source.seek(0)
            with (stage / "archive.age").open("xb") as target:
                subprocess.run([str(stage / "age"), "--encrypt", "--recipient", recipient],
                               stdin=source, stdout=target, stderr=subprocess.DEVNULL,
                               check=True, timeout=120)
    digest = hashlib.sha256()
    with (stage / "archive.age").open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    checksum = digest.hexdigest()
    (stage / "archive.sha256").write_text(checksum, encoding="ascii")
    expiry = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15)
    forced = f"/usr/bin/timeout 120 /usr/bin/python3 {stage}/copy.py transfer {root} {transfer_id}"
    line = (f'restrict,expiry-time="{expiry:%Y%m%d%H%M%SZ}",command="{forced}" '
            f"ssh-ed25519 {ssh_public} accountpulse-copy-{transfer_id}\n")
    change_keys(ssh_files(), stage, line.encode("ascii"))
    print(f"ciphertext_sha256={checksum}")
    print(f"expires_utc={expiry:%Y-%m-%dT%H:%M:%SZ}")


def transfer(stage):
    requested = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if requested == "download":
        with (stage / "archive.age").open("rb") as source:
            shutil.copyfileobj(source, sys.stdout.buffer)
        sys.stdout.buffer.flush()
        return
    action, _, supplied = requested.partition(":")
    require(action == "confirm" and SHA256.fullmatch(supplied), "Transfer command is not allowed.")
    checksum = (stage / "archive.sha256").read_text(encoding="ascii")
    require(hmac.compare_digest(checksum, supplied), "Ciphertext verification did not match.")
    cleanup(stage)


def main():
    os.umask(0o077)
    mode, root_name, transfer_id, *arguments = sys.argv[1:]
    require(re.fullmatch(r"[0-9a-f]{24}", transfer_id), "Invalid transfer identifier.")
    require(re.fullmatch(r"/[A-Za-z0-9._/-]+", root_name), "Invalid deployment directory.")
    root = Path(root_name).resolve(strict=True)
    require(str(root) == root_name, "The deployment directory must be its canonical path.")
    stage = root / f".owner-copy-{transfer_id}"
    protected(stage, directory=True)
    require(stat.S_IMODE(stage.stat().st_mode) == 0o700, "Unprotected transfer directory.")
    require(Path(__file__).resolve() == stage / "copy.py", "Unexpected transfer script location.")
    if mode == "stage" and len(arguments) == 2:
        stage_copy(root, stage, transfer_id, *arguments)
    elif mode == "transfer" and not arguments:
        transfer(stage)
    elif mode == "cleanup" and not arguments:
        cleanup(stage)
    else:
        raise ValueError("Transfer action is not allowed.")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except (OSError, subprocess.SubprocessError):
        print("The encrypted backup operation could not complete.", file=sys.stderr)
        raise SystemExit(1) from None
