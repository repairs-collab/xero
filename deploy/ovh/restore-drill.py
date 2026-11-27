"""Verify one existing logical backup in disposable, network-isolated PostgreSQL."""

import datetime
import fcntl
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path


BACKUP_NAME = re.compile(r"pre-[a-f0-9]{40}-(\d{8}T\d{6}Z)\.dump")
DEPLOY_ROOT = re.compile(r"/[A-Za-z0-9._/-]+")
CONTAINER_ID = re.compile(r"[a-f0-9]{64}")
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MIN_MEM_AVAILABLE_KIB = 1536 * 1024
DRILL_LABEL = "com.accountpulse.restore-drill"
DRILL_DB = "accountpulse_restore_drill"
PG_IMAGE = "postgres:17-alpine"
CORE_TABLES = (
    "organisations",
    "users",
    "contacts",
    "invoices",
    "reminder_sequences",
    "stage_instances",
    "outbound_messages",
    "message_attempts",
    "audit_events",
    "webhook_events",
)


class DrillError(Exception):
    """A safe, bounded message suitable for the workflow log."""


def available_memory_kib():
    for line in Path("/proc/meminfo").read_text(encoding="ascii").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1])
    raise DrillError("Could not verify the host's available memory.")


def newest_archive(directory_fd):
    candidates = []
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            match = BACKUP_NAME.fullmatch(entry.name)
            if match and entry.is_file(follow_symlinks=False):
                try:
                    stamp = datetime.datetime.strptime(match[1], "%Y%m%dT%H%M%SZ")
                except ValueError:
                    continue
                candidates.append((stamp, entry.name))
    if not candidates:
        raise DrillError("No eligible logical release backup was found.")
    return max(candidates)[1]


def run_docker(arguments, *, timeout, source=None):
    try:
        return subprocess.run(
            ["docker", "--host", "unix:///var/run/docker.sock", *arguments],
            stdin=source if source is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise DrillError("An isolated Docker operation reached its time limit.") from None


def cleanup_container(name):
    result = run_docker(
        ["ps", "--all", "--no-trunc", "--quiet", "--filter", f"label={DRILL_LABEL}={name}"],
        timeout=6,
    )
    if result.returncode:
        raise DrillError(f"Could not verify cleanup of isolated container {name}.")
    matches = result.stdout.split()
    if not matches:
        return
    if len(matches) != 1 or not CONTAINER_ID.fullmatch(matches[0]):
        raise DrillError(f"Could not identify isolated container {name} for cleanup.")
    result = run_docker(["rm", "--force", "--volumes", matches[0]], timeout=12)
    if result.returncode:
        raise DrillError(f"Could not remove isolated container {name}.")


def await_postgres(container):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        status = run_docker(
            ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", DRILL_DB],
            timeout=5,
        )
        if status.returncode == 0:
            return
        time.sleep(1)
    raise DrillError("Temporary PostgreSQL did not become ready.")


def verify_schema(container):
    aggregate_fields = ", ".join(
        f"'{table}', (SELECT count(*) FROM public.{table})" for table in CORE_TABLES
    )
    result = run_docker(
        [
            "exec", container, "psql", "-XqAt", "-h", "127.0.0.1", "-U", "postgres",
            "-d", DRILL_DB, "-v", "ON_ERROR_STOP=1", "-c",
            f"BEGIN READ ONLY; SELECT json_build_object({aggregate_fields}); ROLLBACK;",
        ],
        timeout=15,
    )
    if result.returncode:
        raise DrillError("Expected core tables could not be verified in the restored database.")
    try:
        counts = json.loads(result.stdout)
    except ValueError:
        raise DrillError("Temporary PostgreSQL did not return valid aggregate evidence.") from None
    if (
        not isinstance(counts, dict)
        or set(counts) != set(CORE_TABLES)
        or any(type(value) is not int or value < 0 for value in counts.values())
        or counts["organisations"] == 0
    ):
        raise DrillError("Restored core table counts failed verification.")
    return counts


def exercise_restore(archive):
    name = f"accountpulse-restore-drill-{uuid.uuid4().hex}"
    started = time.monotonic()
    try:
        result = run_docker(
            [
                "run", "--detach", "--name", name, "--label", f"{DRILL_LABEL}={name}",
                "--pull", "never", "--network", "none", "--restart", "no",
                "--memory", "768m", "--memory-swap", "768m", "--cpus", "0.50",
                "--pids-limit", "128", "--shm-size", "64m", "--log-driver", "none",
                "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=512m",
                "--security-opt", "no-new-privileges",
                "--env", f"POSTGRES_DB={DRILL_DB}",
                "--env", "POSTGRES_HOST_AUTH_METHOD=trust",
                PG_IMAGE, "-c", "max_connections=10", "-c", "shared_buffers=32MB",
                "-c", "maintenance_work_mem=32MB",
            ],
            timeout=20,
        )
        container = result.stdout.strip()
        if result.returncode or not CONTAINER_ID.fullmatch(container):
            raise DrillError("Could not start the bounded temporary PostgreSQL container.")
        await_postgres(container)
        result = run_docker(
            [
                "exec", "-i", container, "pg_restore", "--exit-on-error",
                "--no-owner", "--no-privileges", "-h", "127.0.0.1", "-U", "postgres",
                "-d", DRILL_DB,
            ],
            timeout=120,
            source=archive,
        )
        if result.returncode:
            raise DrillError("The backup did not restore within the temporary database limits.")
        counts = verify_schema(container)
    finally:
        cleanup_container(name)
    return counts, round(time.monotonic() - started, 1)


def run_drill(root):
    lock_fd = os.open(
        root / ".release.lock", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    )
    try:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise DrillError("The existing OVH release lock is not a regular file.")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DrillError("Another AccountPulse release or repair holds the deployment lock.") from None
        if available_memory_kib() < MIN_MEM_AVAILABLE_KIB:
            raise DrillError("The host has less than 1.5 GiB available for an isolated restore drill.")
        backup_fd = os.open(root / "backups", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            name = newest_archive(backup_fd)
            archive_fd = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=backup_fd
            )
        finally:
            os.close(backup_fd)
        # Docker reads the underlying descriptor directly after the checksum pass.
        with os.fdopen(archive_fd, "rb", buffering=0) as archive:
            initial = os.fstat(archive.fileno())
            if not stat.S_ISREG(initial.st_mode) or not 5 < initial.st_size <= MAX_ARCHIVE_BYTES:
                raise DrillError("The selected backup is not a regular archive within the 32 MiB limit.")
            if archive.read(5) != b"PGDMP":
                raise DrillError("The selected backup is not a PostgreSQL custom-format archive.")
            archive.seek(0)
            checksum = hashlib.sha256()
            remaining = initial.st_size
            while remaining:
                block = archive.read(min(remaining, 1024 * 1024))
                if not block:
                    raise DrillError("The selected archive changed before the restore drill.")
                checksum.update(block)
                remaining -= len(block)
            archive.seek(0)
            counts, duration = exercise_restore(archive)
            final = os.fstat(archive.fileno())
            if final.st_size != initial.st_size or final.st_mtime_ns != initial.st_mtime_ns:
                raise DrillError("The selected archive changed during the restore drill.")
    finally:
        os.close(lock_fd)
    return {
        "result": "passed",
        "scope": "same-host isolated logical restore",
        "completedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "backup": name,
        "backupBytes": initial.st_size,
        "sha256": checksum.hexdigest(),
        "elapsedSeconds": duration,
        "coreTablesVerified": len(counts),
    }


def interrupted(_signal, _frame):
    raise DrillError("The bounded restore drill was interrupted.")


if __name__ == "__main__":
    for interrupt in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(interrupt, interrupted)
    try:
        if len(sys.argv) != 2 or not DEPLOY_ROOT.fullmatch(sys.argv[1]):
            raise DrillError("The protected OVH deployment directory is invalid.")
        print(json.dumps(run_drill(Path(sys.argv[1]))), flush=True)
    except (DrillError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, DrillError) else "Could not read the protected backup or host metadata."
        print(f"Restore drill declined or failed. {message}", file=sys.stderr, flush=True)
        sys.exit(1)
