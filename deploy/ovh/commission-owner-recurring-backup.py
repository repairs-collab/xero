"""Commission the reviewed AccountPulse backup with the production SSH grant."""

import base64
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time


DEPLOY_ROOT = Path("/opt/bc5000")
EXPORT = Path("/var/lib/accountpulse/backup-export")
SERVICE = "accountpulse-daily-backup.service"
TIMER = "accountpulse-daily-backup.timer"
INSTALLER = "install-owner-recurring-backup.sh"
READER = "owner-recurring-backup.py"
LIBEXEC = Path("/usr/local/libexec/accountpulse")
SYSTEMD = Path("/etc/systemd/system")
AGE_HASH = "eb7dd1b518f0a307c99cd97782623c5321da049154b04acd2d98d21aa7bc9b2c"
REVIEWED = (SERVICE, TIMER, READER)
INSTALL_FILES = (*REVIEWED, INSTALLER, "age", "age-recipient", "reader.pub")


def call(args, *, capture=False, timeout=30, env=None):
    return subprocess.run(
        args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        timeout=timeout, env=env,
    )


def systemctl(*args, capture=False, timeout=30):
    return call(["/usr/bin/systemctl", *args], capture=capture, timeout=timeout)


def expect(condition):
    if not condition:
        raise ValueError("The commissioning precondition did not hold.")


def assert_timer_off(*, installed):
    enablement = systemctl("is-enabled", TIMER, capture=True)
    state = systemctl("is-active", TIMER, capture=True)
    allowed = {b"disabled"} if installed else {b"", b"disabled", b"not-found"}
    expect(enablement.returncode in (1, 4) and enablement.stdout.strip() in allowed)
    expect(state.returncode in (3, 4) and state.stdout.strip() in (b"inactive", b"unknown"))


def root_file(path):
    props = path.lstat()
    expect(stat.S_ISREG(props.st_mode) and props.st_uid == 0 and not props.st_mode & 0o022)
    return props


def check_published(*, earliest):
    manifest = root_file(EXPORT / "latest")
    expect(earliest <= manifest.st_mtime_ns <= time.time_ns())
    env = {**os.environ, "SSH_ORIGINAL_COMMAND": "metadata"}
    response = call([str(LIBEXEC / "owner-recurring-backup"), "serve"], capture=True, env=env)
    expect(response.returncode == 0 and 1 <= len(response.stdout) <= 257)


def validate_payload(operation, packed):
    names = INSTALL_FILES if operation == "install" else REVIEWED
    expect(set(packed) == set(names))
    files = {name: base64.b64decode(packed[name], validate=True) for name in names}
    for name, content in files.items():
        limit = 12 * 1024 * 1024 if name == "age" else 64 * 1024
        expect(1 <= len(content) <= limit)
    if operation == "install":
        expect(hashlib.sha256(files["age"]).hexdigest() == AGE_HASH)
    return files


def install_once(files):
    assert_timer_off(installed=False)
    expect(systemctl("is-active", "--quiet", "docker.service").returncode == 0)
    with tempfile.TemporaryDirectory(prefix="accountpulse-backup-", dir="/run") as scratch:
        directory = Path(scratch)
        for name, payload in files.items():
            path = directory / name
            with path.open("xb") as target:
                target.write(payload)
        installed = call(
            ["/bin/bash", str(directory / INSTALLER), str(DEPLOY_ROOT), str(directory / "age"),
             str(directory / "age-recipient"), str(directory / "reader.pub")],
            timeout=120,
        )
        expect(installed.returncode == 0)


def check_installed(files):
    reviewed = {
        SYSTEMD / SERVICE: files[SERVICE],
        SYSTEMD / TIMER: files[TIMER],
        LIBEXEC / "owner-recurring-backup": files[READER],
    }
    for path, expected in reviewed.items():
        expect(root_file(path).st_size == len(expected) and path.read_bytes() == expected)
    for unit in (SERVICE, TIMER):
        fragment = systemctl("show", "--property=FragmentPath", "--value", unit, capture=True)
        overrides = systemctl("show", "--property=DropInPaths", "--value", unit, capture=True)
        expect(fragment.returncode == 0 and fragment.stdout.strip() == os.fsencode(SYSTEMD / unit))
        expect(overrides.returncode == 0 and not overrides.stdout.strip())
    age = LIBEXEC / "age"
    expect(root_file(age).st_size <= 12 * 1024 * 1024)
    expect(hashlib.sha256(age.read_bytes()).hexdigest() == AGE_HASH)
    configuration = Path("/etc/accountpulse/daily-backup.env")
    expected = f"ACCOUNT_PULSE_BACKUP_DEPLOY_ROOT={DEPLOY_ROOT}\n".encode("ascii")
    expect(root_file(configuration).st_size == len(expected) and configuration.read_bytes() == expected)


def commission(operation, payload, root_arg):
    stage = "validate"
    try:
        os.umask(0o077)
        expect(os.geteuid() == 0)
        expect(operation in ("install", "enable") and root_arg == str(DEPLOY_ROOT))
        expect(DEPLOY_ROOT.resolve(strict=True) == DEPLOY_ROOT)
        expect(stat.S_ISREG((DEPLOY_ROOT / "docker-compose.yml").lstat().st_mode))
        files = validate_payload(operation, payload)

        if operation == "install":
            stage = "install"
            install_once(files)
            stage = "check_timer"
            check_installed(files)
            assert_timer_off(installed=True)
            expect(systemctl("is-active", SERVICE).returncode in (3, 4))
            stage = "start"
            started = time.time_ns()
            expect(systemctl("start", SERVICE, timeout=18 * 60).returncode == 0)
            stage = "verify_backup"
            check_published(earliest=started)
            assert_timer_off(installed=True)
            print("backup_commissioned_timer_disabled")
        else:
            stage = "check_ready"
            check_installed(files)
            check_published(earliest=time.time_ns() - 24 * 60 * 60 * 10**9)
            stage = "enable"
            expect(systemctl("enable", "--now", TIMER).returncode == 0)
            stage = "verify_timer"
            enablement = systemctl("is-enabled", TIMER, capture=True)
            state = systemctl("is-active", TIMER, capture=True)
            expect(enablement.returncode == 0 and enablement.stdout.strip() == b"enabled")
            expect(state.returncode == 0 and state.stdout.strip() == b"active")
            print("backup_timer_enabled_active")
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        print(f"backup_commissioning_failed={stage}")
        return 1


if __name__ == "__main__":
    raise SystemExit(commission(COMMISSION_OPERATION, COMMISSION_PAYLOAD, COMMISSION_DEPLOY_ROOT))
