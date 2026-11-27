#!/usr/bin/python3
"""Send one internal lifecycle email from the reviewed OVH worker."""

import fcntl
import os
import re
import stat
import subprocess
import sys
import time

CURL_CONFIG = "/etc/accountpulse/server-health-mail.curl"
RELEASE_LOCK = "/opt/bc5000/.release.lock"
PROOF_RECEIPT = "/run/accountpulse-lifecycle-email-proof.last"
DOCKER = ("/usr/bin/docker", "--host", "unix:///var/run/docker.sock")
MAILBOX = b"ap@motts.com.au"
ACCEPTED = "LIFECYCLE_EMAIL_PROOF_ACCEPTED"
NOT_CONFIRMED = "LIFECYCLE_EMAIL_PROOF_NOT_CONFIRMED"
REFUSED = "LIFECYCLE_EMAIL_PROOF_REFUSED"


def password_from_config(config):
    lines = config.splitlines()
    if (len(lines) != 5 or lines[0] != b'url = "smtps://ventraip.email:465"'
            or lines[1] != b'login-options = "AUTH=LOGIN"'
            or lines[3] != b'mail-from = "' + MAILBOX + b'"'
            or lines[4] != b'mail-rcpt = "' + MAILBOX + b'"'):
        raise ValueError
    prefix = b'user = "' + MAILBOX + b":"
    if not lines[2].startswith(prefix) or not lines[2].endswith(b'"'):
        raise ValueError
    quoted = lines[2][len(prefix):-1]
    if not re.fullmatch(rb'(?:[^"\\\x00-\x1f\x7f]|\\["\\])+', quoted):
        raise ValueError
    password = re.sub(rb'\\(["\\])', rb'\1', quoted)
    if len(password) > 4096 or not password.decode("utf-8").strip():
        raise ValueError
    return password


def read_protected_password():
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    with os.fdopen(os.open(CURL_CONFIG, flags), "rb") as config:
        info = os.fstat(config.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_nlink != 1 or info.st_size > 9000):
            raise ValueError
        contents = config.read(9001)
    if len(contents) > 9000:
        raise ValueError
    return password_from_config(contents)


def run_proof(release_sha):
    if os.geteuid() != 0 or not re.fullmatch(r"[a-f0-9]{40}", release_sha):
        return REFUSED
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        with os.fdopen(os.open(RELEASE_LOCK, flags), "rb") as lock:
            if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
                return REFUSED
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            worker = subprocess.run(
                (*DOCKER, "inspect", "--type", "container", "--format",
                 "{{.Id}} {{.Config.Image}} {{.State.Health.Status}}", "bc5000-worker"),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=10, check=False
            )
            fields = worker.stdout.split()
            if (worker.returncode != 0 or len(fields) != 3
                    or not re.fullmatch(rb"[a-f0-9]{64}", fields[0])
                    or fields[1] != b"accountpulse-worker:" + release_sha.encode("ascii")
                    or fields[2] != b"healthy"):
                return REFUSED
            password = read_protected_password()
            if not record_attempt():
                return REFUSED
            return submit_proof(fields[0].decode("ascii"), password)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return REFUSED


def record_attempt():
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    try:
        fd = os.open(PROOF_RECEIPT, flags | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        with os.fdopen(os.open(PROOF_RECEIPT, flags), "rb") as receipt:
            info = os.fstat(receipt.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                    or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600
                    or time.time() - info.st_mtime < 600):
                return False
            os.utime(receipt.fileno())
        return True
    os.close(fd)
    return True


def submit_proof(container_id, password):
    try:
        result = subprocess.run(
            (*DOCKER, "exec", "-i", container_id, "node", "/app/worker.mjs",
             "test-lifecycle-email"),
            input=password, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=90, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return NOT_CONFIRMED
    if result.returncode == 0 and result.stdout == b"LIFECYCLE_EMAIL_PROOF_ACCEPTED\n":
        return ACCEPTED
    if result.stdout == b"LIFECYCLE_EMAIL_PROOF_REFUSED\n":
        return REFUSED
    return NOT_CONFIRMED


if __name__ == "__main__":
    outcome = run_proof(sys.argv[1]) if len(sys.argv) == 2 else REFUSED
    print(outcome)
    sys.exit(0 if outcome == ACCEPTED else 1)
