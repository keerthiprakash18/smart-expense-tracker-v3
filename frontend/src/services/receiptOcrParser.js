import { RECEIPT_LIMITS, ReceiptOcrError } from './receiptOcrLimits.js';

const categories = {
  'Food & Dining': ['swiggy', 'zomato', 'starbucks', 'mcdonald', 'kfc', 'domino', 'pizza', 'burger king', 'cafe', 'restaurant', 'bhavan', 'biryani', 'chai'],
  Groceries: ['blinkit', 'zepto', 'instamart', 'bigbasket', 'dmart', 'supermarket', 'kirana', 'groceries'],
  'Travel & Fuel': ['uber', 'ola', 'rapido', 'irctc', 'indigo', 'air india', 'fuel', 'petrol', 'hpcl', 'iocl', 'bpcl', 'toll', 'metro'],
  Shopping: ['amazon', 'flipkart', 'myntra', 'zara', 'croma', 'reliance digital', 'uniqlo', 'westside', 'decathlon'],
  'Bills & Utilities': ['bescom', 'tneb', 'airtel', 'jio', 'electricity', 'water supply', 'indane', 'bharat gas'],
  Health: ['apollo', 'medplus', 'pharmeasy', 'pharmacy', 'hospital', 'clinic', 'diagnostic'],
  Entertainment: ['bookmyshow', 'pvr', 'inox', 'netflix', 'spotify', 'hotstar', 'prime video'],
};
const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const round = (value) => Math.round(value * 100) / 100;
const currencyMarker = /(?:₹|\$|€|£|\b(?:INR|USD|EUR|GBP|RS)\.?\s)/i;

export function sanitizeReceiptText(raw) {
  const value = String(raw || '');
  if (value.length > RECEIPT_LIMITS.textCharacters) throw new ReceiptOcrError('This document contains too much text for receipt scanning. Split it into smaller receipts.', 'receipt_text_limit', 413);
  // Matching controls is intentional: never put invisible/bidi controls into review fields.
  // eslint-disable-next-line no-control-regex
  const clean = value.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/<[^>]{0,1000}>/g, '').split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim().slice(0, 1000)).filter(Boolean).join('\n');
  if (clean.length > RECEIPT_LIMITS.textCharacters) throw new ReceiptOcrError('Normalized receipt text exceeds the scanner limit.', 'receipt_text_limit', 413);
  return clean;
}

export function parseMoney(value) {
  let clean = String(value).trim().replace(/[₹$€£]/g, '').replace(/\b(?:INR|USD|EUR|GBP|RS)\.?/gi, '').trim();
  if (!/^\d[\d., \u00a0]*$/.test(clean)) return null;
  clean = clean.replace(/[ \u00a0]/g, '');
  const comma = clean.lastIndexOf(',');
  const dot = clean.lastIndexOf('.');
  const last = Math.max(comma, dot);
  const fractional = last >= 0 && clean.length - last - 1 <= 2;
  const integer = fractional ? clean.slice(0, last) : clean;
  if (!/^\d+$/.test(integer) && !/^\d{1,3}(?:,\d{3})+$/.test(integer) && !/^\d{1,3}(?:\.\d{3})+$/.test(integer) && !/^\d{1,2}(?:,\d{2})*,\d{3}$/.test(integer)) return null;
  const number = Number(integer.replace(/[,.]/g, '') + (fractional ? `.${clean.slice(last + 1)}` : ''));
  return Number.isFinite(number) && number > 0 && number <= 100000000 ? round(number) : null;
}

function amounts(line) {
  return [...line.matchAll(/(?<![\w/.-])(?:[₹$€£]|(?:INR|USD|EUR|GBP|RS)\.?\s*)?\s*(-?\d[\d.,]*)(?![\w/])/gi)]
    .filter((match) => line[match.index + match[0].length] !== '%')
    .map((match) => parseMoney(match[1])).filter((value) => value !== null);
}

function extractAmount(lines, warnings) {
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/\b(?:subtotal|sub total|tax|gst|savings?|discount|items?|quantity|qty|change|tendered|balance forward)\b/i.test(line)) continue;
    const label = /\b(grand\s+total|total\s+(?:amount|payable|paid)|amount\s+(?:payable|due|paid)|net\s+(?:amount|total)|bill\s+amount|balance\s+due|total)\b/i.exec(line);
    if (!label) continue;
    const tail = line.slice(label.index + label[0].length);
    let values = amounts(tail);
    if (!values.length && /^[\s:=₹$€£-]*$/.test(tail) && index + 1 < lines.length && /^[\d\s.,₹$€£]+$/.test(lines[index + 1])) values = amounts(lines[index + 1]);
    if (values.length) candidates.push({ value: values.at(-1), priority: /^total$/i.test(label[0]) ? 1 : 2 });
  }
  if (candidates.length) {
    const priority = Math.max(...candidates.map((entry) => entry.priority));
    const values = [...new Set(candidates.filter((entry) => entry.priority === priority).map((entry) => entry.value))];
    if (values.length === 1) return { value: values[0], confidence: 0.9 };
    warnings.push('Conflicting total amounts were found. Enter the correct payable total manually.');
    return { value: 0, confidence: 0 };
  }
  const fallback = lines.filter((line) => currencyMarker.test(line) && !/\b(?:date|tax|gst|change|tendered|discount|savings?|ref|rrn|id|phone|tel)\b/i.test(line)).flatMap(amounts);
  const unique = [...new Set(fallback)];
  if (unique.length === 1) { warnings.push('No labelled total was found; the single currency amount is only a suggestion.'); return { value: unique[0], confidence: 0.4 }; }
  warnings.push('No unambiguous total amount was found. Enter the payable amount manually.');
  return { value: 0, confidence: 0 };
}

function validDate(year, month, day) {
  if (year < 1900 || year > 2100) return '';
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() + 1 === month && value.getUTCDate() === day ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
}

function dateCandidate(text) {
  const numeric = /\b([0-9OoIl]{1,4})\s*[/.-]\s*([0-9OoIl]{1,2})\s*[/.-]\s*([0-9OoIl]{2,4})\b/.exec(text);
  if (numeric) {
    const parts = numeric.slice(1).map((part) => Number(part.replace(/[Oo]/g, '0').replace(/[Il]/g, '1')));
    let year, month, day;
    if (numeric[1].length === 4) [year, month, day] = parts;
    else { [day, month, year] = parts; if (year < 100) year += 2000; if (month > 12 && day <= 12) [day, month] = [month, day]; }
    const value = validDate(year, month, day);
    return { value, ambiguous: numeric[1].length !== 4 && parts[0] <= 12 && parts[1] <= 12 && parts[0] !== parts[1] };
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /\b(\d{1,2})\s+([a-z]{3,9})\s*,?\s*(20\d{2})\b/i.exec(text) || /\b([a-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(text);
  if (named) {
    const firstNumeric = /^\d/.test(named[1]);
    const month = months.indexOf((firstNumeric ? named[2] : named[1]).slice(0, 3).toLowerCase()) + 1;
    return { value: validDate(Number(named[3]), month, Number(firstNumeric ? named[1] : named[2])), ambiguous: false };
  }
  return { value: '', ambiguous: false };
}

function extractDate(lines, warnings) {
  const eligible = lines.filter((line) => !/\b(?:due|expiry|expires|valid until)\b/i.test(line));
  const labelled = eligible.filter((line) => /\b(?:date|issued on)\b/i.test(line));
  for (const group of [labelled, eligible]) {
    const found = group.map(dateCandidate).filter((entry) => entry.value);
    if (!found.length) continue;
    if (new Set(found.map((entry) => entry.value)).size > 1) { warnings.push('Multiple receipt dates were found. Enter the transaction date manually.'); return { value: '', confidence: 0 }; }
    if (found[0].ambiguous) warnings.push('The numeric date has ambiguous day/month order and was interpreted as DD/MM. Check it before saving.');
    return { value: found[0].value, confidence: found[0].ambiguous ? 0.45 : 0.85 };
  }
  warnings.push('No reliable transaction date was found. Enter it manually; today’s date has not been substituted.');
  return { value: '', confidence: 0 };
}

export function parseReceiptText(raw, { ocrConfidence = null, source = 'text' } = {}) {
  const text = sanitizeReceiptText(raw);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new ReceiptOcrError('No readable text was found. Use a clearer, upright image or a text-based PDF.', 'no_receipt_text');
  const warnings = ['Review every field before saving. Values and categories are suggestions, not verified financial data.'];
  const lines = text.split('\n');
  const amount = extractAmount(lines, warnings);
  const date = extractDate(lines, warnings);
  const merchantLine = lines.slice(0, 8).find((line) => /\p{L}{3}/u.test(line) && !currencyMarker.test(line) && !/^(?:tax invoice|invoice|receipt|bill|date|total|subtotal|gstin|gst|phone|tel|customer|address)\b/i.test(line) && !/^\d/.test(line) && !/(?:https?:|www\.|@|\bdate\b|\btotal\b)/i.test(line));
  const merchant = (merchantLine || '').replace(/[^\p{L}\p{M}\p{N}\s&.'’-]/gu, '').trim().slice(0, 100);
  if (!merchant) warnings.push('No reliable merchant name was found. Enter it manually.');
  let category = 'General';
  for (const [name, words] of Object.entries(categories)) if (words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text))) { category = name; break; }
  let payment = 'Cash';
  let paymentFound = true;
  if (/\b(?:upi|gpay|phonepe|paytm)\b/i.test(text)) payment = 'UPI';
  else if (/\b(?:card|visa|mastercard|debit|credit|pos)\b/i.test(text)) payment = 'Card';
  else if (/\b(?:net\s*banking|neft|imps)\b/i.test(text)) payment = 'NetBanking';
  else if (!/\bcash\b/i.test(text)) paymentFound = false;
  if (!paymentFound) warnings.push('Payment method was not detected. Cash is a placeholder; choose the correct method.');
  const currencies = [['INR', '₹', /₹|\b(?:INR|RS)\.?\s/i], ['USD', '$', /\$|\bUSD\b/i], ['EUR', '€', /€|\bEUR\b/i], ['GBP', '£', /£|\bGBP\b/i]].filter(([, , pattern]) => pattern.test(text));
  const currency = currencies.length === 1 ? currencies[0] : null;
  if (!currency) warnings.push(currencies.length ? 'Multiple currencies were found. Check the amount and account currency; no conversion was performed.' : 'Currency was not detected. Check your account currency; no conversion was performed.');
  const taxes = lines.filter((line) => /\b(?:cgst|sgst|igst|tax|gst)\b/i.test(line) && !/gstin/i.test(line)).map((line) => ({ total: /\btotal\s+(?:tax|gst)\b/i.test(line), value: amounts(line).at(-1) || 0 }));
  const tax = taxes.find((entry) => entry.total)?.value ?? taxes.reduce((sum, entry) => sum + entry.value, 0);
  const engineConfidence = ocrConfidence === null ? null : clamp(ocrConfidence / 100);
  if (engineConfidence !== null && engineConfidence < 0.6) warnings.push('Text recognition quality is low. Correct the fields or rescan a sharper image before saving.');
  warnings.push('Local OCR does not check existing transactions for duplicates. Review your ledger before saving.');
  const categoryConfidence = category === 'General' ? 0 : 0.55;
  const merchantConfidence = merchant ? 0.65 : 0;
  const overall = round(((amount.confidence + date.confidence + merchantConfidence + categoryConfidence) / 4) * (engineConfidence ?? 0.9));
  return {
    merchant, title: merchant, amount: amount.value, total: amount.value,
    date: date.value || null, currency: currency?.[1] || '', currency_code: currency?.[0] || '',
    category, category_source: 'receipt_keywords', merchant_memory: false,
    payment_method: payment, tax_amount: round(tax),
    gstin: text.toUpperCase().match(/\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/)?.[0] || null,
    upi_ref: payment === 'UPI' ? text.match(/\b(?:upi\s*ref|rrn|txn\s*id)\s*[:=]?\s*(\d{9,16})\b/i)?.[1] || null : null,
    confidence: { amount: amount.confidence, date: date.confidence, merchant: merchantConfidence, category: categoryConfidence, payment: paymentFound ? 0.7 : 0, ocr: engineConfidence, overall },
    confidence_kind: 'heuristic', source, review_required: true, warnings,
    raw_text_preview: text.slice(0, 500),
  };
}
