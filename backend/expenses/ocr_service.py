import re
from datetime import datetime


class IndiaReceiptExtractor:
    """Conservative receipt parser for OCR text.

    It never invents a date. Dates are taken from a labelled date line first,
    then from other valid date-shaped text. Ambiguous/unreliable text is left
    blank so the user can correct it instead of silently saving today's date.
    """

    MERCHANT_PATTERNS = {
        "Food & Dining": ["swiggy", "zomato", "starbucks", "mcdonald", "kfc", "domino", "pizza", "burger king", "cafe", "restaurant", "bhavan", "anandha", "biryani", "chai"],
        "Groceries": ["blinkit", "zepto", "instamart", "bigbasket", "dmart", "reliance fresh", "supermarket", "spencer", "kirana", "provision"],
        "Travel & Fuel": ["uber", "ola", "rapido", "irctc", "indigo", "air india", "fuel", "petrol", "hpcl", "iocl", "bpcl", "shell", "toll", "metro"],
        "Shopping": ["amazon", "flipkart", "myntra", "zara", "h&m", "trends", "croma", "reliance digital", "apple", "uniqlo", "westside", "decathlon"],
        "Bills & Utilities": ["bescom", "tneb", "airtel", "jio", "vi", "act fibernet", "electricity", "water supply", "gas", "indane", "bharat gas", "tatasky"],
        "Health": ["apollo", "medplus", "pharmeasy", "1mg", "pharmacy", "hospital", "clinic", "diagnostic", "dr."],
        "Entertainment": ["bookmyshow", "pvr", "inox", "netflix", "spotify", "hotstar", "prime video"],
    }

    @staticmethod
    def _normalize_amount(value):
        try:
            value = str(value).strip().replace(",", "")
            value = re.sub(r"^[₹$€£]|^(?:rs\.?|inr)\s*", "", value, flags=re.I).strip()
            amount = float(value)
            if amount <= 0 or amount > 100000000:
                return None
            return amount
        except (ValueError, TypeError):
            return None

    @classmethod
    def _extract_amount(cls, text):
        lines = [x.strip() for x in text.splitlines() if x.strip()]
        total_label = re.compile(r"\b(?:grand\s+total|total\s+amount|total\s+payable|amount\s+payable|net\s+amount|bill\s+amount|balance\s+due|amount\s+due|total)\b", re.I)
        number = re.compile(r"(?:₹|rs\.?|inr|\$|€|£)?\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)", re.I)

        for line in reversed(lines):
            if total_label.search(line):
                vals = [cls._normalize_amount(m) for m in number.findall(line)]
                vals = [v for v in vals if v is not None]
                if vals:
                    return vals[-1]

        currency = re.compile(r"(?:₹|rs\.?|inr|\$|€|£)\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)", re.I)
        vals = [cls._normalize_amount(m) for m in currency.findall(text)]
        vals = [v for v in vals if v is not None]
        if vals:
            return vals[-1]

        decimal = re.findall(r"\b([0-9]+\.\d{2})\b", text)
        vals = [cls._normalize_amount(m) for m in decimal]
        vals = [v for v in vals if v is not None]
        return vals[-1] if vals else None

    @staticmethod
    def _clean_date_candidate(value):
        # OCR commonly turns O/I/l into digits inside dates. Only normalize
        # characters after a date-shaped candidate has already been found.
        value = value.strip().replace("O", "0").replace("o", "0").replace("I", "1").replace("l", "1")
        value = re.sub(r"\s+", "", value)
        return value

    @classmethod
    def _parse_date_candidate(cls, candidate):
        candidate = cls._clean_date_candidate(candidate)
        candidate = candidate.replace("-", "/").replace(".", "/")
        parts = candidate.split("/")
        if len(parts) != 3:
            return None
        try:
            a, b, c = parts
            if len(a) == 4:
                year, month, day = int(a), int(b), int(c)
            else:
                day_or_month, month_or_day, year = int(a), int(b), int(c)
                if year < 100:
                    year += 2000
                # For receipts, DD/MM/YYYY is the default. If the first part
                # is > 12 it must be DD/MM; otherwise preserve DD/MM.
                day, month = day_or_month, month_or_day
                if day > 31 or month > 12:
                    return None
            obj = datetime(year, month, day)
            return obj.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            return None

    @classmethod
    def _extract_date(cls, text):
        # 1) Prefer text immediately after an explicit date label.
        labelled = re.compile(
            r"\b(?:date|invoice\s*date|bill\s*date|transaction\s*date|issued\s*on|date\s*of\s*issue)\b\s*[:#-]?\s*([0-9OoIl]{1,4}\s*[/.-]\s*[0-9OoIl]{1,2}\s*[/.-]\s*[0-9OoIl]{2,4})",
            re.I,
        )
        for match in labelled.finditer(text):
            parsed = cls._parse_date_candidate(match.group(1))
            if parsed:
                return parsed

        # 2) Then accept a normal full numeric date anywhere in OCR text.
        generic_patterns = [
            r"\b(20\d{2})\s*[-/.]\s*(0?[1-9]|1[0-2])\s*[-/.]\s*(0?[1-9]|[12]\d|3[01])\b",
            r"\b(0?[1-9]|[12]\d|3[01])\s*[-/.]\s*(0?[1-9]|1[0-2])\s*[-/.]\s*(20\d{2}|\d{2})\b",
        ]
        for pattern in generic_patterns:
            for match in re.finditer(pattern, text, re.I):
                parsed = cls._parse_date_candidate(match.group(0))
                if parsed:
                    return parsed
        return None

    @staticmethod
    def _extract_tax(text):
        pattern = re.compile(r"\b(?:GST|CGST|SGST|TAX)\b\s*[:=]?\s*(?:₹|rs\.?|inr)?\s*([0-9]+(?:\.\d{1,2})?)", re.I)
        match = pattern.search(text)
        return float(match.group(1)) if match else 0.0

    @staticmethod
    def _extract_gstin(text):
        pattern = r"\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b"
        match = re.search(pattern, text.upper())
        return match.group(0) if match else None

    @staticmethod
    def _extract_payment(text):
        low = text.lower()
        if any(k in low for k in ["upi", "gpay", "phonepe", "paytm"]):
            match = re.search(r"(?:upi\s*ref|rrn|txn\s*id)\s*[:=]?\s*([0-9]{9,16})", text, re.I)
            return "UPI", match.group(1) if match else None
        if any(k in low for k in ["card", "visa", "mastercard", "pos", "debit", "credit"]):
            return "Card", None
        if any(k in low for k in ["net banking", "neft", "imps"]):
            return "NetBanking", None
        return "Cash", None

    @classmethod
    def _extract_merchant_and_category(cls, text):
        low = text.lower()
        for category, keywords in cls.MERCHANT_PATTERNS.items():
            for keyword in keywords:
                if keyword in low:
                    return keyword.title(), category, 0.95
        lines = [x.strip() for x in text.splitlines() if len(x.strip()) > 3]
        ignored = {"receipt", "tax invoice", "invoice", "bill", "total", "subtotal"}
        for line in lines[:8]:
            cleaned = re.sub(r"[^a-zA-Z0-9\s&.\-]", "", line).strip()
            if cleaned.lower() in ignored:
                continue
            if len(cleaned) >= 3:
                return cleaned[:35], "General", 0.70
        return "Retail Merchant", "General", 0.60

    @classmethod
    def parse_document(cls, raw_text: str, filename: str = ""):
        text = (raw_text or "").replace("\r", "\n")
        text = re.sub(r"\n+", "\n", text).strip()
        amount = cls._extract_amount(text)
        date = cls._extract_date(text)
        tax_amount = cls._extract_tax(text)
        gstin = cls._extract_gstin(text)
        payment_method, upi_ref = cls._extract_payment(text)
        merchant, category, category_confidence = cls._extract_merchant_and_category(text)
        amount_confidence = 0.95 if amount is not None else 0.20
        date_confidence = 0.90 if date is not None else 0.20
        overall = round((amount_confidence + date_confidence + category_confidence) / 3, 2)
        return {
            "merchant": merchant,
            "amount": amount if amount is not None else 0.0,
            "tax_amount": tax_amount,
            "gstin": gstin,
            "category": category,
            "payment_method": payment_method,
            "upi_ref": upi_ref,
            "date": date,
            "confidence": {
                "amount": amount_confidence,
                "date": date_confidence,
                "merchant": category_confidence,
                "category": category_confidence,
                "overall": overall,
            },
            "raw_text_preview": text[:500],
        }
