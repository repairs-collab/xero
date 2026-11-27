#!/usr/bin/env python3
"""Publish and serve the latest age-encrypted AccountPulse database export."""

import datetime as dt
import hashlib
import hmac
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time


EXPORT = Path("/var/lib/accountpulse/backup-export")
RECIPIENT = Path("/etc/accountpulse/backup/age-recipient")
READER_GROUP = "accountpulse-backup"
MAX_BYTES = 128 * 1024 * 1024
FREE_RESERVE = 1024 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
KEEP = 3
ARCHIVE = r"accountpulse-(\d{8}T\d{6}Z)-[0-9a-f]{16}\.dump\.age"
MANIFEST = re.compile(rf"({ARCHIVE}) ([1-9][0-9]{{0,8}}) ([0-9a-f]{{64}})\n")


def parse_manifest(data):
    match = MANIFEST.fullmatch(data.decode("ascii"))
    if not match or int(match[3]) > MAX_BYTES:
        raise ValueError("The backup metadata is invalid.")
    dt.datetime.strptime(match[2], "%Y%m%dT%H%M%SZ")
    return match[1], int(match[3]), match[4]


def open_export(path):
    stream = os.fdopen(os.open(path, os.O_NOFOLLOW | os.O_NONBLOCK | os.O_RDONLY), "rb")
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o037:
        stream.close()
        raise ValueError("The backup export file is not protected.")
    return stream


def serve(directory, command, output):
    fetch = re.fullmatch(r"fetch ([0-9a-f]{64})", command)
    if command != "metadata" and not fetch:
        raise ValueError("Only backup metadata and its ciphertext may be requested.")
    with open_export(directory / "latest") as manifest:
        data = manifest.read(257)
    basename, size, digest = parse_manifest(data)
    if fetch and not hmac.compare_digest(digest, fetch[1]):
        return 75
    with open_export(directory / basename) as encrypted:
        if os.fstat(encrypted.fileno()).st_size != size:
            raise ValueError("The backup archive size differs from its metadata.")
        if fetch:
            while size:
                block = encrypted.read(min(size, CHUNK_BYTES))
                if not block:
                    raise ValueError("The backup archive was truncated.")
                output.write(block)
                size -= len(block)
        else:
            output.write(data)
    output.flush()
    return 0


def secure_output(stream, group):
    os.fchown(stream.fileno(), 0, group)
    os.fchmod(stream.fileno(), 0o640)


def is_owned_archive(path):
    info = path.lstat()
    return stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o037


def prune(directory, latest):
    old = sorted((path for path in directory.iterdir()
                  if path.name != latest and re.fullmatch(ARCHIVE, path.name) and is_owned_archive(path)),
                 reverse=True)
    for path in old[KEEP - 1:]:
        path.unlink()


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(directory, group, write_encrypted):
    now = dt.datetime.now(dt.timezone.utc)
    archive = directory / f"accountpulse-{now:%Y%m%dT%H%M%SZ}-{secrets.token_hex(8)}.dump.age"
    staged_archive = staged_manifest = None
    published = False
    try:
        with tempfile.NamedTemporaryFile(mode="w+b", dir=directory, prefix=".archive-", delete=False) as target:
            staged_archive = Path(target.name)
            write_encrypted(target)
            size = target.tell()
            if size > MAX_BYTES:
                raise ValueError("The encrypted backup exceeded the root disk limit.")
            target.seek(0)
            if target.readline(22) != b"age-encryption.org/v1\n":
                raise ValueError("The backup process did not produce an age archive.")
            target.seek(0)
            checksum = hashlib.sha256()
            for block in iter(lambda: target.read(CHUNK_BYTES), b""):
                checksum.update(block)
            secure_output(target, group)
            os.fsync(target.fileno())
        with tempfile.NamedTemporaryFile(mode="wb", dir=directory, prefix=".latest-", delete=False) as target:
            staged_manifest = Path(target.name)
            target.write(f"{archive.name} {size} {checksum.hexdigest()}\n".encode("ascii"))
            target.flush()
            secure_output(target, group)
            os.fsync(target.fileno())
        os.replace(staged_archive, archive)
        os.replace(staged_manifest, directory / "latest")
        published = True
        sync_directory(directory)
    finally:
        for staged in (staged_archive, staged_manifest):
            if staged is not None:
                staged.unlink(missing_ok=True)
        if not published:
            archive.unlink(missing_ok=True)
    prune(directory, archive.name)


def encrypt_postgres(deploy_root, age, recipient, target):
    compose = [
        "docker", "compose", "--project-directory", str(deploy_root),
        "--env-file", str(deploy_root / "accountpulse.env"),
        "--env-file", str(deploy_root / "current-images.env"),
        "--file", str(deploy_root / "docker-compose.yml"),
        "exec", "-T", "postgres", "sh", "-c",
        'exec pg_dump --format=custom --lock-wait-timeout=5s -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
    ]
    deadline = ["timeout", "--kill-after=5s", "900s"]
    with subprocess.Popen(deadline + compose, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as dump:
        try:
            with subprocess.Popen(deadline + [str(age), "--encrypt", "--recipient", recipient],
                                  stdin=dump.stdout, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as encrypted:
                dump.stdout.close()
                size = 0
                try:
                    for block in iter(lambda: encrypted.stdout.read(CHUNK_BYTES), b""):
                        size += len(block)
                        if size > MAX_BYTES:
                            raise ValueError("The encrypted backup exceeded the root disk limit.")
                        target.write(block)
                except (OSError, ValueError):
                    if encrypted.poll() is None:
                        encrypted.terminate()
                    raise
                if encrypted.wait() != 0 or dump.wait() != 0:
                    raise ValueError("The database dump or encryption did not complete.")
        finally:
            dump.stdout.close()
            if dump.poll() is None:
                dump.terminate()


def create_backup(deploy_root, age):
    import fcntl
    import grp

    group = grp.getgrnam(READER_GROUP).gr_gid
    directory = EXPORT.lstat()
    if (os.geteuid() != 0 or not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0
            or directory.st_gid != group or stat.S_IMODE(directory.st_mode) != 0o750
            or directory.st_dev != Path("/").stat().st_dev):
        raise ValueError("The backup export requires a protected directory on the root filesystem.")
    with open_export(RECIPIENT) as source:
        recipient = source.read(64).decode("ascii").strip()
        if source.read(1) or not re.fullmatch(r"age1[0-9a-z]{58}", recipient):
            raise ValueError("The backup age public recipient is invalid.")
    with open_export(age):
        pass
    with os.fdopen(os.open(EXPORT / ".writer-lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600), "rb") as writer:
        fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for path in EXPORT.iterdir():
            if re.fullmatch(r"\.(archive|latest)-[a-z0-9_]{8}", path.name) and is_owned_archive(path):
                path.unlink()
        if shutil.disk_usage(EXPORT).free < MAX_BYTES + FREE_RESERVE:
            raise ValueError("The root filesystem does not have enough free space for a backup.")
        with os.fdopen(os.open(deploy_root / ".release.lock", os.O_NOFOLLOW | os.O_NONBLOCK | os.O_RDONLY), "rb") as release:
            if not stat.S_ISREG(os.fstat(release.fileno()).st_mode):
                raise ValueError("The AccountPulse release lock is invalid.")
            deadline = time.monotonic() + 90
            while True:
                try:
                    fcntl.flock(release, fcntl.LOCK_SH | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ValueError("The backup could not acquire the AccountPulse release lock.") from None
                    time.sleep(1)
            publish(EXPORT, group, lambda target: encrypt_postgres(deploy_root, age, recipient, target))
    print("AccountPulse encrypted database backup published.")


def main():
    os.umask(0o077)
    if sys.argv[1:] == ["serve"]:
        return serve(EXPORT, os.environ.get("SSH_ORIGINAL_COMMAND", ""), sys.stdout.buffer)
    if sys.argv[1:] == ["create"]:
        deploy_root = Path(os.environ["ACCOUNT_PULSE_BACKUP_DEPLOY_ROOT"]).resolve(strict=True)
        if not (deploy_root / "docker-compose.yml").is_file():
            raise ValueError("The configured AccountPulse deployment directory is invalid.")
        create_backup(deploy_root, Path("/usr/local/libexec/accountpulse/age"))
        return 0
    raise ValueError("The backup operation is invalid.")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, KeyError, ValueError, subprocess.SubprocessError):
        print("AccountPulse encrypted backup could not complete.", file=sys.stderr)
        raise SystemExit(1) from None
