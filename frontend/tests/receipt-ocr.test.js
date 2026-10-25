import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReceiptText, parseMoney, sanitizeReceiptText } from '../src/services/receiptOcrParser.js';
import { RECEIPT_LIMITS, inspectReceiptBytes, readReceiptFile, assertPdfPages, renderDimensions } from '../src/services/receiptOcrLimits.js';
import { scanReceipt } from '../src/services/receiptOcr.js';

test('Indian receipt parses labelled total, real date, GST amounts and UPI reference', () => {
  const result = parseReceiptText(`SARAVANA CAFE\nTax Invoice\nDate: 25/10/2026\nDosa 180.00\nSubtotal 180.00\nCGST 2.5% 4.50\nSGST 2.5% 4.50\nGrand Total Rs. 189.00\nUPI Ref: 123456789012\nGSTIN 29ABCDE1234F1Z5`, { ocrConfidence: 92, source: 'image-ocr' });
  assert.equal(result.merchant, 'SARAVANA CAFE');
  assert.equal(result.amount, 189);
  assert.equal(result.tax_amount, 9);
  assert.equal(result.date, '2026-10-25');
  assert.equal(result.currency_code, 'INR');
  assert.equal(result.payment_method, 'UPI');
  assert.equal(result.upi_ref, '123456789012');
  assert.equal(result.gstin, '29ABCDE1234F1Z5');
  assert.equal(result.category, 'Food & Dining');
  assert.equal(result.review_required, true);
  assert.equal(result.confidence.ocr, 0.92);
  assert.equal(result.confidence_kind, 'heuristic');
});

test('USD receipt picks total instead of cash tendered, change, tax or subtotal', () => {
  const result = parseReceiptText('MARKET CAFE\nDate 2026-10-25\nSubtotal $18.00\nTax $1.80\nTOTAL $19.80\nCash tendered $20.00\nChange $0.20');
  assert.equal(result.amount, 19.8);
  assert.equal(result.currency, '$');
  assert.equal(result.date, '2026-10-25');
  assert.equal(result.payment_method, 'Cash');
});

test('locale money formats are bounded and malformed, negative or unsafe values are rejected', () => {
  for (const [text, value] of [['1,23,456.78', 123456.78], ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['1234,56', 1234.56], ['1234.5', 1234.5], ['12', 12]]) assert.equal(parseMoney(text), value);
  for (const text of ['-12.50', 'NaN', 'Infinity', '1e9', '0', '100000000.01', '12,34,56', 'abc12.50', '1.2.3']) assert.equal(parseMoney(text), null);
});

test('conflicting receipt totals are left for review, not silently selected', () => {
  const result = parseReceiptText('Example Cafe\nDate 2026-10-25\nTotal USD 24.00\nTotal USD 42.00');
  assert.equal(result.amount, 0);
  assert.ok(result.warnings.some((value) => /Conflicting total/.test(value)));
});

test('merchant IDs, dates and quantity labels do not become fabricated amounts', () => {
  const result = parseReceiptText('Example Shop\nInvoice ID 1234567890\nDate 2026-10-25\nTotal items 12\nPhone 1234567890');
  assert.equal(result.amount, 0);
  assert.equal(result.currency, '');
  assert.equal(result.payment_method, 'Cash');
  assert.ok(result.warnings.some((value) => /placeholder/.test(value)));
});

test('missing or impossible dates never become today; due date is not a receipt date', () => {
  for (const date of ['Date 31/02/2026', 'Due Date 25/10/2026', 'no date']) assert.equal(parseReceiptText(`Example Shop\n${date}\nTotal INR 100.00`).date, null);
  assert.equal(parseReceiptText('Example Shop\nDate 29/02/2024\nTotal INR 100.00').date, '2024-02-29');
});

test('ambiguous DD/MM, unambiguous US numeric and named dates are reviewed explicitly', () => {
  const ambiguous = parseReceiptText('Example Shop\nDate 04/05/2026\nTotal INR 100.00');
  assert.equal(ambiguous.date, '2026-05-04');
  assert.ok(ambiguous.warnings.some((value) => /ambiguous day\/month/.test(value)));
  assert.equal(parseReceiptText('Example Shop\nDate 10/25/2026\nTotal USD 100.00').date, '2026-10-25');
  assert.equal(parseReceiptText('Example Shop\nDate 25 October 2026\nTotal GBP 10.00').date, '2026-10-25');
});

test('low recognition quality, mixed currencies and unknown merchant remain visible review concerns', () => {
  const result = parseReceiptText('RECEIPT\nDate 2026-10-25\nTotal $10.00\nEUR 9.00', { ocrConfidence: 30 });
  assert.equal(result.merchant, '');
  assert.equal(result.currency, '');
  assert.ok(result.warnings.some((value) => /quality is low/.test(value)));
  assert.ok(result.warnings.some((value) => /Multiple currencies/.test(value)));
  assert.ok(result.confidence.overall < 0.3);
});

test('control characters and markup are sanitized; empty and huge extraction results are rejected', () => {
  assert.equal(sanitizeReceiptText('<b>CAFE</b>\u202e\u0000\nTOTAL $4.00'), 'CAFE\nTOTAL $4.00');
  assert.throws(() => parseReceiptText('  \n '), /No readable text/);
  assert.throws(() => parseReceiptText('A'.repeat(RECEIPT_LIMITS.textCharacters + 1)), /too much text/);
});

function png(width = 100, height = 100) {
  const bytes = new Uint8Array(33); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

test('content sniffing rejects SVG, URLs, fake PDFs and mismatched declarations', () => {
  for (const text of ['<svg><image href="https://evil.example"/></svg>', 'https://evil.example/receipt.png', '%PDF-1.7 not an actual document']) assert.throws(() => inspectReceiptBytes(new TextEncoder().encode(text)));
  assert.throws(() => inspectReceiptBytes(png(), 'application/pdf'), /do not match/);
  assert.equal(inspectReceiptBytes(png(), 'image/png').width, 100);
});

test('pixel bombs are rejected from the header before image decoding', () => {
  assert.throws(() => inspectReceiptBytes(png(8000, 8000), 'image/png'), /16 megapixels/);
  assert.throws(() => inspectReceiptBytes(png(9000, 1), 'image/png'), /8,000/);
  assert.throws(() => inspectReceiptBytes(png(0, 1), 'image/png'), /dimensions are invalid/);
});

test('truncated JPEG and animated WebP inputs fail explicit validation', () => {
  assert.throws(() => inspectReceiptBytes(new Uint8Array([255, 216, 255, 192, 0, 20, 8, 0, 10, 0, 10, 3])));
  const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFF')); new DataView(webp.buffer).setUint32(4, 22, true); webp.set(new TextEncoder().encode('WEBPVP8X'), 8); webp[20] = 2;
  assert.throws(() => inspectReceiptBytes(webp, 'image/webp'), /Animated WebP/);
});

test('page and rendering limits are strict and never silently truncate documents', () => {
  assert.throws(() => assertPdfPages(4), /no pages were silently skipped/);
  assert.throws(() => assertPdfPages(0), /no readable pages/);
  assert.doesNotThrow(() => assertPdfPages(3));
  const size = renderDimensions(4000, 4000, 2);
  assert.ok(size.width * size.height <= RECEIPT_LIMITS.renderPixels);
  assert.ok(Math.max(size.width, size.height) <= RECEIPT_LIMITS.renderDimension);
});

test('only one local Blob is accepted and the size limit runs before reading bytes', async () => {
  const url = new FormData(); url.append('receipt', 'https://evil.example/private.pdf');
  await assert.rejects(readReceiptFile(url), /URLs and text are not accepted/);
  const empty = new FormData(); empty.append('receipt', new Blob());
  await assert.rejects(readReceiptFile(empty), /empty/);
  const large = new FormData(); large.append('receipt', new Blob([new Uint8Array(RECEIPT_LIMITS.fileBytes + 1)]));
  await assert.rejects(readReceiptFile(large), (error) => error.status === 413);
  const duplicates = new FormData(); duplicates.append('receipt', new Blob([png()])); duplicates.append('receipt', new Blob([png()]));
  await assert.rejects(readReceiptFile(duplicates), /one local receipt/);
});

test('public scan API rejects an already-aborted request without starting workers or fetching', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanReceipt(new FormData(), { signal: controller.signal }), (error) => error.code === 'receipt_cancelled');
  await assert.rejects(scanReceipt(new FormData()), (error) => error.code === 'receipt_file_required');
});
