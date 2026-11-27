"""Verify receipt of the one internal welcome without fetching message content."""

import base64
import imaplib
import os
import ssl
import time
from datetime import UTC, datetime

proof = {"__name__": "lifecycle_proof_source"}
exec(compile(base64.b64decode(PROOF_SOURCE, validate=True), "reviewed-proof", "exec"), proof)


def check_inbox(mail, attempted_at):
    date = datetime.fromtimestamp(attempted_at, UTC).strftime("%d-%b-%Y")
    mailbox = '"ap@motts.com.au"'
    status, matches = mail.uid(
        "SEARCH", None, "UNDELETED", "SINCE", date,
        "FROM", mailbox, "TO", mailbox, "SUBJECT", '"Welcome to AccountPulse"',
        "BODY", '"the internal SMTP delivery test"'
    )
    if status != "OK" or not matches or not isinstance(matches[0], bytes):
        return False
    for uid in matches[0].split()[-5:]:
        if not uid.isdigit():
            continue
        status, response = mail.uid("FETCH", uid, "(INTERNALDATE)")
        if status != "OK" or not response:
            continue
        for row in response:
            if isinstance(row, bytes):
                sent = imaplib.Internaldate2tuple(row)
                if sent and attempted_at - 10 <= time.mktime(sent) <= time.time() + 30:
                    return True
    return False


def verify_receipt():
    if os.geteuid() != 0:
        return False
    attempted_at = os.stat(proof["PROOF_RECEIPT"], follow_symlinks=False).st_mtime
    if not 0 <= time.time() - attempted_at < 180:
        return False
    password = proof["read_protected_password"]().decode("utf-8")
    context = ssl.create_default_context()
    with imaplib.IMAP4_SSL("ventraip.email", 993, ssl_context=context, timeout=8) as mail:
        mail.login("ap@motts.com.au", password)
        if mail.select("INBOX", readonly=True)[0] != "OK":
            return False
        for attempt in range(4):
            if check_inbox(mail, attempted_at):
                return True
            if attempt < 3:
                time.sleep(3)
    return False


try:
    delivered = verify_receipt()
except (ValueError, OSError, imaplib.IMAP4.error):
    delivered = False
print("LIFECYCLE_EMAIL_INBOX_VERIFIED" if delivered else "LIFECYCLE_EMAIL_INBOX_UNVERIFIED")
