import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote


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
