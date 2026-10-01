import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
import time
from urllib.parse import quote

from django.contrib.auth.hashers import check_password


def normalize_merchant(value):
    """Canonical merchant key shared by OCR learning, signals and scan views."""
    value = re.sub(r"[^a-z0-9 ]+", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", value).strip()[:160]


def consume_recovery_code(security, code):
    """Burn one stored recovery-code hash. Single source of truth for 2FA + reset."""
    candidate = str(code or "").strip().upper()
    if not candidate:
        return False
    try:
        hashes = json.loads(security.recovery_codes or "[]")
    except (TypeError, ValueError):
        hashes = []
    for index, stored_hash in enumerate(hashes):
        if check_password(candidate, stored_hash):
            hashes.pop(index)
            security.recovery_codes = json.dumps(hashes)
            security.save(update_fields=["recovery_codes", "updated_at"])
            return True
    return False


def generate_totp_secret(length=20):
    return base64.b32encode(secrets.token_bytes(length)).decode("ascii").rstrip("=")


def _normalize_secret(secret):
    secret = (secret or "").strip().replace(" ", "").upper()
    padding = "=" * ((8 - len(secret) % 8) % 8)
    return base64.b32decode(secret + padding, casefold=True)


def totp_code(secret, for_time=None, step=30, digits=6):
    key = _normalize_secret(secret)
    counter = int((for_time if for_time is not None else time.time()) // step)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(value).zfill(digits)


def verify_totp(secret, code, window=1, step=30):
    code = str(code or "").strip()
    if not code.isdigit() or len(code) != 6:
        return False
    now = time.time()
    return any(hmac.compare_digest(totp_code(secret, now + offset * step, step=step), code) for offset in range(-window, window + 1))


def provisioning_uri(secret, email, issuer="Smart Expense Tracker"):
    label = quote(f"{issuer}:{email or 'account'}")
    return f"otpauth://totp/{label}?secret={quote(secret)}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"


def generate_recovery_codes(count=8):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    codes = []
    for _ in range(count):
        raw = "".join(secrets.choice(alphabet) for _ in range(10))
        codes.append(f"{raw[:5]}-{raw[5:]}")
    return codes
