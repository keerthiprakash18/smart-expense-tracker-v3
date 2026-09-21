import re
from datetime import datetime
from PIL import Image, ImageEnhance, ImageFilter


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------

def _clean_ocr_text(text):
    """Clean common OCR encoding/noise problems."""
    if not text:
        return ""

    replacements = {
        "â‚¹": "₹",
        "â€¹": "₹",
        "Rs.": "Rs",
        "R5": "Rs",
        "INR.": "INR",
        "—": "-",
        "–": "-",
    }

    for old, new in replacements.items():
        text = text.replace(old, new)

    return text


def _normalize_number(value):
    """Convert OCR number text into float safely."""
    if not value:
        return None

    value = value.strip()
    value = value.replace("₹", "")
    value = value.replace("$", "")
    value = value.replace("€", "")
    value = value.replace("£", "")
    value = re.sub(r"(?i)\b(?:rs|inr)\b\.?", "", value)
    value = value.replace(" ", "")

    # Handle Indian/international number formatting.
    if "," in value and "." in value:
        # 1,234.56
        value = value.replace(",", "")
    elif "," in value:
        # 123,45 -> 123.45
        if re.search(r",\d{1,2}$", value):
            value = value.replace(",", ".")
        else:
            value = value.replace(",", "")

    value = re.sub(r"[^0-9.]", "", value)

    try:
        number = float(value)
        if number < 0 or number > 100000000:
            return None
        return number
    except (ValueError, TypeError):
        return None


def _extract_amount_from_line(line):
    """
    Extract monetary-looking values from a single OCR line.
    """
    if not line:
        return []

    # ₹123.45 / Rs 123.45 / INR 123.45 / $123.45
    currency_pattern = r"(?:₹|rs\.?|inr|usd|\$|€|£)\s*([0-9][0-9,]*\.?[0-9]{0,2})"

    matches = re.findall(currency_pattern, line, flags=re.IGNORECASE)

    amounts = []

    for match in matches:
        value = _normalize_number(match)
        if value is not None:
            amounts.append(value)

    # If currency symbol isn't detected, accept decimal money values.
    if not amounts:
        decimal_matches = re.findall(
            r"\b\d{1,7}[.,]\d{2}\b",
            line
        )

        for match in decimal_matches:
            value = _normalize_number(match)
            if value is not None:
                amounts.append(value)

    return amounts


def _extract_labeled_amount(lines):
    """
    Strongest amount extraction:
    TOTAL / GRAND TOTAL / AMOUNT PAYABLE / NET TOTAL etc.
    """

    strong_labels = [
        "grand total",
        "total amount",
        "amount payable",
        "amount due",
        "balance due",
        "net total",
        "invoice total",
        "bill total",
        "total payable",
        "payable amount",
        "total",
    ]

    excluded_labels = [
        "subtotal",
        "sub total",
        "tax",
        "gst",
        "cgst",
        "sgst",
        "igst",
        "discount",
        "saving",
        "change",
        "cash",
        "tender",
        "paid",
    ]

    candidates = []

    for index, original_line in enumerate(lines):
        line = original_line.strip()
        lower = line.lower()

        if not line:
            continue

        # Don't treat subtotal/tax/etc. as the final amount.
        if any(label in lower for label in excluded_labels):
            # Allow "TOTAL" if it also contains subtotal accidentally.
            if "total" not in lower or "subtotal" in lower:
                continue

        matched_label = None

        for label in strong_labels:
            if label in lower:
                matched_label = label
                break

        if matched_label:
            amounts = _extract_amount_from_line(line)

            # Sometimes OCR puts amount on next line.
            if not amounts and index + 1 < len(lines):
                amounts = _extract_amount_from_line(lines[index + 1])

            for amount in amounts:
                score = 100

                if matched_label == "grand total":
                    score += 30
                elif matched_label in [
                    "total amount",
                    "amount payable",
                    "balance due",
                    "net total",
                    "total payable",
                ]:
                    score += 20

                # Prefer realistic receipt amounts.
                if amount > 0:
                    score += 5

                candidates.append((score, amount))

    if candidates:
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]

    return None


def _extract_best_amount(lines):
    """
    Fallback amount extraction.

    Important:
    We NEVER simply choose the largest number in the receipt.
    """

    candidates = []

    ignored_words = [
        "gstin",
        "gst no",
        "invoice no",
        "bill no",
        "phone",
        "mobile",
        "contact",
        "qty",
        "quantity",
        "item",
        "tax",
        "cgst",
        "sgst",
        "igst",
        "subtotal",
        "discount",
        "change",
        "cash",
        "card",
    ]

    for index, line in enumerate(lines):
        lower = line.lower()

        if any(word in lower for word in ignored_words):
            continue

        amounts = _extract_amount_from_line(line)

        for amount in amounts:
            score = 10

            # Lines near the bottom are more likely to contain totals.
            if index >= max(0, len(lines) - 8):
                score += 10

            # Lines containing payment-related words get priority.
            if any(word in lower for word in [
                "pay",
                "paid",
                "total",
                "amount",
                "due",
            ]):
                score += 20

            # Very tiny values are often item quantities/prices.
            if amount >= 10:
                score += 3

            candidates.append((score, amount))

    if not candidates:
        return 0.0

    candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)

    return candidates[0][1]


def _extract_date(lines):
    """
    Extract receipt date.

    Priority:
    DATE / BILL DATE / INVOICE DATE
    then general date patterns.
    """

    date_patterns = [
        r"\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b",
        r"\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b",
        r"\b(\d{1,2}[.]\d{1,2}[.]\d{2,4})\b",
    ]

    label_words = [
        "date",
        "bill date",
        "invoice date",
        "transaction date",
        "purchase date",
    ]

    # First pass: labelled date.
    for line in lines:
        lower = line.lower()

        if any(word in lower for word in label_words):
            for pattern in date_patterns:
                match = re.search(pattern, line)

                if match:
                    parsed = _parse_date(match.group(1))
                    if parsed:
                        return parsed

    # Second pass: any valid date.
    for line in lines:
        for pattern in date_patterns:
            match = re.search(pattern, line)

            if match:
                parsed = _parse_date(match.group(1))
                if parsed:
                    return parsed

    return datetime.now().strftime("%Y-%m-%d")


def _parse_date(value):
    """Parse common receipt date formats."""
    formats = [
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%d/%m/%y",
        "%d-%m-%y",
        "%d.%m.%y",
        "%Y/%m/%d",
        "%Y-%m-%d",
        "%Y.%m.%d",
    ]

    for fmt in formats:
        try:
            parsed = datetime.strptime(value, fmt)

            # Reject impossible/future dates far beyond today.
            if parsed.year < 2000:
                continue

            if parsed > datetime.now():
                continue

            return parsed.strftime("%Y-%m-%d")

        except ValueError:
            continue

    return None


def _detect_category(text):
    """Basic receipt category detection."""
    text_lower = text.lower()

    if any(word in text_lower for word in [
        "restaurant",
        "cafe",
        "coffee",
        "bakery",
        "pizza",
        "burger",
        "food",
        "kitchen",
        "hotel",
    ]):
        return "Food"

    if any(word in text_lower for word in [
        "fuel",
        "petrol",
        "diesel",
        "uber",
        "ola",
        "taxi",
        "parking",
        "metro",
        "transport",
    ]):
        return "Transport"

    if any(word in text_lower for word in [
        "electricity",
        "electric",
        "power",
        "water bill",
        "internet",
        "broadband",
        "telecom",
        "mobile bill",
    ]):
        return "Bills"

    if any(word in text_lower for word in [
        "pharmacy",
        "medical",
        "medicine",
        "hospital",
        "clinic",
    ]):
        return "Health"

    if any(word in text_lower for word in [
        "amazon",
        "flipkart",
        "shopping",
        "mart",
        "supermarket",
        "store",
        "retail",
    ]):
        return "Shopping"

    return "Shopping"


def _extract_title(lines):
    """
    Pick a reasonable merchant/store name.
    Avoid obvious receipt metadata lines.
    """

    ignored = [
        "receipt",
        "tax invoice",
        "invoice",
        "bill",
        "date",
        "gstin",
        "gst no",
        "invoice no",
        "bill no",
        "phone",
        "mobile",
        "total",
    ]

    for line in lines[:8]:
        clean = line.strip()

        if len(clean) < 3:
            continue

        lower = clean.lower()

        if any(word in lower for word in ignored):
            continue

        # Avoid lines that are almost entirely numbers.
        if re.fullmatch(r"[\d\s./:-]+", clean):
            continue

        return clean[:50]

    return "Receipt"


# ---------------------------------------------------------
# Main OCR function
# ---------------------------------------------------------

def extract_receipt_data(image_file):
    """
    Receipt OCR parser.

    Uses Tesseract when available.
    Applies image preprocessing.
    Extracts amount/date using receipt-aware rules.

    IMPORTANT:
    No fake fallback receipt data is generated.
    """

    extracted_data = {
        "title": "Receipt",
        "amount": 0.0,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "category": "Shopping",
        "raw_text": "",
    }

    try:
        import pytesseract

        # -------------------------------------------------
        # Open image
        # -------------------------------------------------

        img = Image.open(image_file).convert("RGB")

        # Keep processing memory reasonable.
        max_size = 1800

        if max(img.size) > max_size:
            ratio = max_size / max(img.size)
            new_size = (
                int(img.width * ratio),
                int(img.height * ratio),
            )
            img = img.resize(new_size, Image.Resampling.LANCZOS)

        # -------------------------------------------------
        # Preprocessing
        # -------------------------------------------------

        gray = img.convert("L")

        # Improve contrast.
        gray = ImageEnhance.Contrast(gray).enhance(1.8)

        # Sharpen text.
        gray = gray.filter(ImageFilter.SHARPEN)

        # OCR
        raw_text = pytesseract.image_to_string(
            gray,
            config="--oem 3 --psm 6"
        )

        # If first OCR result is weak, try another layout mode.
        if len(raw_text.strip()) < 15:
            raw_text_alt = pytesseract.image_to_string(
                gray,
                config="--oem 3 --psm 11"
            )

            if len(raw_text_alt.strip()) > len(raw_text.strip()):
                raw_text = raw_text_alt

        raw_text = _clean_ocr_text(raw_text)

        # -------------------------------------------------
        # NO FAKE DATA
        # -------------------------------------------------

        extracted_data["raw_text"] = raw_text.strip()

        if not raw_text.strip():
            return extracted_data

        # -------------------------------------------------
        # Prepare lines
        # -------------------------------------------------

        lines = [
            line.strip()
            for line in raw_text.splitlines()
            if line.strip()
        ]

        # -------------------------------------------------
        # Amount
        # -------------------------------------------------

        amount = _extract_labeled_amount(lines)

        if amount is None:
            amount = _extract_best_amount(lines)

        extracted_data["amount"] = round(float(amount), 2)

        # -------------------------------------------------
        # Date
        # -------------------------------------------------

        extracted_data["date"] = _extract_date(lines)

        # -------------------------------------------------
        # Merchant / Title
        # -------------------------------------------------

        extracted_data["title"] = _extract_title(lines)

        # -------------------------------------------------
        # Category
        # -------------------------------------------------

        extracted_data["category"] = _detect_category(raw_text)

    except Exception as exc:
        # Do not invent receipt data when OCR fails.
        extracted_data["raw_text"] = (
            f"OCR_ERROR: {str(exc)}"
        )

    return extracted_data