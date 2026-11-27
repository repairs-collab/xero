#!/usr/bin/python3
"""One-time OVH operations-alert relay setup from an interactive root console."""

import fcntl
import getpass
import os
import signal
import stat
import subprocess
import tempfile
import warnings
from contextlib import contextmanager
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate
from pathlib import Path


HELPER = Path("/run/ap-mail-setup")
CONFIG = Path("/etc/accountpulse/server-health-mail.curl")
MAILBOX = "ap@motts.com.au"
RELAY = "smtps://ventraip.email:465"


class SetupRefused(Exception):
    pass


def require_terminal():
    if not os.isatty(0):
        raise SetupRefused("MAIL_SETUP_TTY_REQUIRED")
    try:
        tty = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
    except OSError:
        raise SetupRefused("MAIL_SETUP_TTY_REQUIRED") from None
    try:
        if not os.isatty(tty):
            raise SetupRefused("MAIL_SETUP_TTY_REQUIRED")
    finally:
        os.close(tty)


@contextmanager
def locked_helper():
    try:
        descriptor = os.open(HELPER, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        raise SetupRefused("MAIL_SETUP_HELPER_UNAVAILABLE") from None
    with os.fdopen(descriptor, "rb") as staged:
        try:
            fcntl.flock(staged, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SetupRefused("MAIL_SETUP_HELPER_ALREADY_IN_USE") from None
        metadata = os.fstat(staged.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or stat.S_IMODE(metadata.st_mode) != 0o700):
            raise SetupRefused("MAIL_SETUP_HELPER_INSECURE")
        current = HELPER.lstat()
        if (current.st_dev, current.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise SetupRefused("MAIL_SETUP_HELPER_UNAVAILABLE")
        yield
        HELPER.unlink()


def create_config():
    with warnings.catch_warnings():
        # getpass emits this warning before its echoing fallback reads anything.
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            password = getpass.getpass(f"VentraIP SMTP password for {MAILBOX} (hidden): ")
        except getpass.GetPassWarning:
            raise SetupRefused("MAIL_SETUP_HIDDEN_INPUT_UNAVAILABLE") from None
    if not password or any(ord(character) < 32 or ord(character) == 127 for character in password):
        raise SetupRefused("MAIL_SETUP_PASSWORD_INPUT_INVALID")
    quoted_password = password.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'url = "{RELAY}"\n'
        f'user = "{MAILBOX}:{quoted_password}"\n'
        f'mail-from = "{MAILBOX}"\n'
        f'mail-rcpt = "{MAILBOX}"\n'
    ).encode("utf-8")


def test_message():
    message = EmailMessage(policy=SMTP)
    message["From"] = f"AccountPulse Operations <{MAILBOX}>"
    message["To"] = MAILBOX
    message["Date"] = formatdate(usegmt=True)
    message["Subject"] = "[AccountPulse] Operations alert setup test"
    message.set_content("This is a one-time test of the AccountPulse operations alert mail relay.")
    return message.as_bytes()


def setup():
    if os.geteuid() != 0:
        raise SetupRefused("MAIL_SETUP_ROOT_REQUIRED")
    require_terminal()
    with locked_helper():
        install_config()


def install_config():
    directory = CONFIG.parent.lstat()
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 0
            or directory.st_mode & 0o022):
        raise SetupRefused("MAIL_SETUP_CONFIG_DIRECTORY_INSECURE")
    if os.path.lexists(CONFIG):
        raise SetupRefused("MAIL_SETUP_CONFIG_EXISTS")

    config_bytes = create_config()
    with tempfile.NamedTemporaryFile(prefix=".server-health-mail-", dir=CONFIG.parent) as temporary:
        os.fchown(temporary.fileno(), 0, 0)
        os.fchmod(temporary.fileno(), 0o600)
        temporary.write(config_bytes)
        del config_bytes
        temporary.flush()
        os.fsync(temporary.fileno())
        try:
            result = subprocess.run(
                ["/usr/bin/curl", "--disable", "--config", temporary.name,
                 "--proto", "=smtps", "--no-insecure", "--max-time", "12",
                 "--silent", "--upload-file", "-"],
                input=test_message(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, check=False, timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise SetupRefused("MAIL_SETUP_TEST_FAILED") from None
        if result.returncode == 67:
            raise SetupRefused("MAIL_SETUP_AUTH_FAILED")
        if result.returncode != 0:
            raise SetupRefused(f"MAIL_SETUP_TEST_FAILED_CURL_{result.returncode}")
        try:
            # Same directory, one atomic link, and no replacement even on a race.
            os.link(temporary.name, CONFIG)
        except FileExistsError:
            raise SetupRefused("MAIL_SETUP_CONFIG_EXISTS_AFTER_TEST") from None
        except OSError:
            raise SetupRefused("MAIL_SETUP_CONFIG_INSTALL_FAILED_AFTER_TEST") from None


def interrupt(_signum, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        setup()
    except SetupRefused as error:
        print(str(error))
        raise SystemExit(1) from None
    except (EOFError, KeyboardInterrupt):
        print("MAIL_SETUP_CANCELLED")
        raise SystemExit(1) from None
    except Exception:
        print("MAIL_SETUP_LOCAL_ERROR")
        raise SystemExit(1) from None
    print("MAIL_SETUP_SUCCESS")
