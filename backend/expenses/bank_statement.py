"""Safe, review-first parsing of user-uploaded bank statement data.

Phase 1 is file import only. No bank credentials or live account integration.
Never store uploaded raw documents; only confirmed transaction details are saved.
"""
import csv
import hashlib
import io
import re
import zipfile
from collections import Counter
from datetime import datetime
from decimal import Decimal, InvalidOperation

from .models import BankStatementEntry, Expense, MerchantRule

MAX_UPLOAD = 5 * 1024 * 1024
MAX_ROWS = 1000
MONEY = Decimal("0.01")


class StatementError(ValueError):
    pass


def norm(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


ALIASES = {
    "date": ("date", "transactiondate", "valuedate", "txndate", "trandate", "postingdate"),
    "description": ("description", "narration", "particulars", "transactiondetails", "remarks", "details", "transactiondescription"),
    "debit": ("debit", "withdrawal", "withdrawalamt", "withdrawalamount", "debitamount", "dramount", "paidout"),
    "credit": ("credit", "deposit", "depositamt", "depositamount", "creditamount", "cramount", "paidin"),
    "amount": ("amount", "transactionamount", "txnamount", "transactionamt"),
    "direction": ("drcr", "type", "transactiontype", "debitcredit", "crdr"),
    "reference": ("reference", "referenceno", "referenceid", "transactionid", "utr", "utrno", "refno", "chequeno", "chequenumber"),
    "balance": ("balance", "closingbalance", "runningbalance", "availablebalance"),
}
CATEGORY_KEYWORDS = (
    ("Food & Dining", ("swiggy", "zomato", "restaurant", "cafe", "coffee", "food")),
    ("Transport", ("petrol", "fuel", "uber", "ola", "metro", "irctc")),
    ("Shopping", ("amazon", "flipkart", "myntra", "retail")),
    ("Bills & Utilities", ("electricity", "broadband", "recharge", "electric", "waterbill")),
    ("Health", ("hospital", "pharmacy", "medical")),
    ("Entertainment", ("netflix", "spotify", "cinema", "movie")),
)
TRANSFER_WORDS = (
    "self transfer", "own account", "own a/c", "credit card payment",
    "credit card bill", "cc payment", "card settlement",
)


def parse_money(raw):
    value = str(raw or "").strip()
    if not value or value.lower() in {"nan", "-", "--", "null", "none"}:
        return Decimal("0")
    negative = value.startswith("-") or (value.startswith("(") and value.endswith(")"))
    clean = re.sub(r"[^0-9.]", "", value.replace(",", ""))
    if not clean or clean.count(".") > 1:
        raise StatementError("A monetary column contains an invalid amount.")
    try:
        amount = Decimal(clean).quantize(MONEY)
    except (InvalidOperation, ValueError):
        raise StatementError("A monetary column contains an invalid amount.")
    if amount > Decimal("9999999999"):
        raise StatementError("An amount exceeds the supported limit.")
    return -amount if negative else amount


def parse_date(raw):
    raw = str(raw or "").strip().split(" ")[0]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y",
                "%d.%m.%Y", "%Y/%m/%d", "%m/%d/%Y"):
        try:
            dt = datetime.strptime(raw, fmt).date()
            if not 1990 <= dt.year <= 2100:
                break
            return dt.isoformat()
        except ValueError:
            pass
    raise StatementError("Unrecognized transaction date; use YYYY-MM-DD or DD/MM/YYYY.")


def normalize_headers(headers):
    matched = {}
    for field, names in ALIASES.items():
        for index, header in enumerate(headers):
            if norm(header) in names:
                matched[field] = index
                break
    if "date" not in matched or "description" not in matched:
        raise StatementError("Statement must contain date and description/narration columns.")
    if not ("debit" in matched or "credit" in matched or "amount" in matched):
        raise StatementError("Statement needs debit/credit columns or an amount column.")
    return matched


def row_value(row, matched, field):
    index = matched.get(field)
    return str(row[index] or "").strip() if index is not None and index < len(row) else ""


def parse_tabular(rows):
    rows = list(rows)
    header_index = None
    matched = None
    for pos, row in enumerate(rows[:30]):
        try:
            matched = normalize_headers(row)
            header_index = pos
            break
        except StatementError:
            continue
    if header_index is None:
        raise StatementError("Could not recognize bank statement headers. Export a CSV with Date, Description, Debit, Credit and Balance columns.")
    records = []
    for row in rows[header_index + 1:]:
        if not any(str(v or "").strip() for v in row):
            continue
        date_raw = row_value(row, matched, "date")
        if not date_raw:
            continue
        description = row_value(row, matched, "description")[:200]
        if not description or norm(description) in {"total", "openingbalance", "closingbalance"}:
            continue
        try:
            tx_date = parse_date(date_raw)
            debit = parse_money(row_value(row, matched, "debit")) if "debit" in matched else Decimal("0")
            credit = parse_money(row_value(row, matched, "credit")) if "credit" in matched else Decimal("0")
            if debit < 0 or credit < 0:
                raise StatementError("Debit and credit values must not be negative.")
            if debit > 0 and credit > 0:
                raise StatementError("Both debit and credit are populated.")
            if not debit and not credit and "amount" in matched:
                signed = parse_money(row_value(row, matched, "amount"))
                direction = row_value(row, matched, "direction").upper()
                if direction in ("CR", "CREDIT", "C"):
                    credit = abs(signed)
                elif direction in ("DR", "DEBIT", "D"):
                    debit = abs(signed)
                elif signed < 0:
                    debit = abs(signed)
                elif signed > 0:
                    # Positive unsigned amount is ambiguous without DR/CR.
                    raise StatementError("Positive amount without a Debit/Credit indicator.")
            if not debit and not credit:
                continue
            records.append({
                "date": tx_date, "description": description,
                "amount": debit or credit,
                "transaction_type": "EXPENSE" if debit else "INCOME",
                "reference": row_value(row, matched, "reference")[:120],
                "balance": row_value(row, matched, "balance")[:40],
            })
        except StatementError as exc:
            raise StatementError(f"Invalid transaction row {header_index + len(records) + 2}: {exc}")
        if len(records) > MAX_ROWS:
            raise StatementError(f"Only {MAX_ROWS} transactions are supported per upload.")
    if not records:
        raise StatementError("No usable transactions found in this statement.")
    return records


def parse_statement(upload, password=""):
    if upload.size > MAX_UPLOAD:
        raise StatementError("Maximum file size is 5 MB.")
    filename = (upload.name or "").lower().rsplit("/", 1)[-1]
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in {"csv", "xlsx", "pdf"}:
        raise StatementError("Use a CSV, XLSX or text-based PDF statement.")
    content = upload.read(MAX_UPLOAD + 1)
    if len(content) > MAX_UPLOAD:
        raise StatementError("Maximum file size is 5 MB.")
    if ext == "csv":
        if b"\x00" in content:
            raise StatementError("Invalid CSV data.")
        try:
            decoded = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise StatementError("Save CSV in UTF-8 encoding and retry.")
        try:
            dialect = csv.Sniffer().sniff(decoded[:4096], delimiters=",;\t|")
        except csv.Error:
            dialect = csv.excel
        return parse_tabular(csv.reader(io.StringIO(decoded), dialect))
    if ext == "xlsx":
        if not content.startswith(b"PK"):
            raise StatementError("Not a valid XLSX file.")
        try:
            # Bound decompressed XLSX content; ZIP containers can be tiny but expand enormously.
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                members = archive.infolist()
                if len(members) > 1000 or sum(part.file_size for part in members) > 30 * 1024 * 1024:
                    raise StatementError("XLSX expanded content exceeds safety limits.")
            from openpyxl import load_workbook
            book = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
            try:
                sheet = book.active
                rows = []
                for row in sheet.iter_rows(max_row=MAX_ROWS + 40, max_col=50, values_only=True):
                    values = [v.isoformat()[:10] if isinstance(v, datetime) else v for v in row]
                    rows.append(values)
                return parse_tabular(rows)
            finally:
                book.close()
        except StatementError:
            raise
        except Exception:
            raise StatementError("Unable to parse this XLSX file.")
    if not content.startswith(b"%PDF-"):
        raise StatementError("Not a valid PDF file.")
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(content), strict=True)
        if reader.is_encrypted and not reader.decrypt(password or ""):
            raise StatementError("PDF password required or incorrect.")
        if len(reader.pages) > 30:
            raise StatementError("PDF exceeds the 30-page limit.")
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        if not text.strip():
            raise StatementError("Scanned/image-only PDF is not supported yet. Please export a CSV or XLSX.")
        # Conservative, review-only support for fixed-layout text statements.
        # Some PDFs encode tables as unstructured text; fail instead of guessing.
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        rows = [re.split(r"\s{2,}|\t+", line) for line in lines]
        return parse_tabular(rows)
    except StatementError:
        raise
    except Exception:
        raise StatementError("PDF format could not be parsed reliably. Please export CSV or XLSX.")


def category_for(user, description, tx_type):
    if tx_type == "INCOME":
        return "Income"
    merchant = norm(description)
    rules = MerchantRule.objects.filter(user=user).only("merchant_key", "category")[:200]
    for rule in rules:
        key = norm(rule.merchant_key)
        if len(key) >= 4 and key in merchant:
            return rule.category
    lower = description.lower()
    for category, words in CATEGORY_KEYWORDS:
        if any(word in lower for word in words):
            return category
    return "Uncategorized"


def prepare_rows(user, account, records):
    seen = Counter()
    rows = []
    for index, record in enumerate(records):
        desc = re.sub(r"\s+", " ", record["description"]).strip()
        ref = norm(record["reference"])
        stable = "|".join((
            str(account.pk), record["date"], record["transaction_type"],
            str(record["amount"]), ref or norm(desc),
            norm(record["balance"]) if not ref else "",
        ))
        # Allow legitimate repeated identical entries in the same statement.
        # When no reference ID exists, repeated occurrences are distinguished.
        occurrence = 0
        if not ref:
            occurrence = seen[stable]
            seen[stable] += 1
        fingerprint = hashlib.sha256(f"{stable}|{occurrence}".encode("utf-8")).hexdigest()
        status = "ready"
        if BankStatementEntry.objects.filter(user=user, account=account, fingerprint=fingerprint).exists():
            status = "duplicate"
        elif any(word in desc.lower() for word in TRANSFER_WORDS):
            status = "review_transfer"
        elif Expense.objects.filter(user=user, account=account,
                                    date=record["date"], amount=record["amount"],
                                    transaction_type=record["transaction_type"]).exists():
            status = "possible_match"
        rows.append({
            "index": index, "date": record["date"], "description": desc,
            "amount": str(record["amount"]), "transaction_type": record["transaction_type"],
            "reference": record["reference"], "category": category_for(user, desc, record["transaction_type"]),
            "fingerprint": fingerprint, "status": status,
        })
    return rows
