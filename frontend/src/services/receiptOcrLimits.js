export const RECEIPT_LIMITS = Object.freeze({
  fileBytes: 10 * 1024 * 1024,
  imagePixels: 16000000,
  imageDimension: 8000,
  renderPixels: 4000000,
  renderDimension: 3000,
  pdfPages: 3,
  pdfPointDimension: 4096,
  textCharacters: 60000,
  textItems: 20000,
  timeoutMs: 90000,
});

export class ReceiptOcrError extends Error {
  constructor(message, code = 'receipt_unreadable', status = 422) {
    super(message);
    this.name = 'ReceiptOcrError';
    this.code = code;
    this.status = status;
    this.response = { status, data: { error: message, code } };
  }
}

export function assertImageDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new ReceiptOcrError('The image dimensions are invalid. Use a valid JPEG, PNG or WebP image.');
  if (width > RECEIPT_LIMITS.imageDimension || height > RECEIPT_LIMITS.imageDimension || width * height > RECEIPT_LIMITS.imagePixels) {
    throw new ReceiptOcrError('The image exceeds 16 megapixels or 8,000 pixels on one side. Resize it before scanning.', 'image_limit', 413);
  }
  return { width, height };
}

export function renderDimensions(width, height, preferredScale = 1) {
  const scale = Math.min(preferredScale, RECEIPT_LIMITS.renderDimension / Math.max(width, height), Math.sqrt(RECEIPT_LIMITS.renderPixels / (width * height)));
  const result = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
  if (!Number.isFinite(scale) || scale <= 0 || result.width * result.height > RECEIPT_LIMITS.renderPixels) throw new ReceiptOcrError('This document cannot be rendered within the scanner pixel limit.', 'render_limit', 413);
  return result;
}

export function assertPdfPages(count) {
  if (!Number.isInteger(count) || count < 1) throw new ReceiptOcrError('The PDF has no readable pages.');
  if (count > RECEIPT_LIMITS.pdfPages) throw new ReceiptOcrError('PDF receipts are limited to 3 pages. Split this document before scanning; no pages were silently skipped.', 'pdf_page_limit', 413);
}

export function inspectReceiptBytes(bytes, mime = '') {
  const bad = () => { throw new ReceiptOcrError('Unsupported or malformed file. Use a JPEG, PNG, static WebP or PDF receipt; SVG, HEIC, GIF, TIFF and BMP are not supported.', 'unsupported_receipt', 415); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, size) => String.fromCharCode(...bytes.subarray(start, start + size));
  let type;
  let dimensions;
  if (ascii(0, 5) === '%PDF-') {
    if (!/^%PDF-(?:1\.[0-9]|2\.0)/.test(ascii(0, 8)) || !ascii(Math.max(0, bytes.length - 2048), 2048).includes('%%EOF')) return bad();
    type = 'application/pdf';
  } else if (bytes[0] === 137 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    if (bytes.length < 33 || ascii(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) return bad();
    type = 'image/png';
    dimensions = assertImageDimensions(view.getUint32(16), view.getUint32(20));
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    type = 'image/jpeg';
    let cursor = 2;
    while (cursor + 3 < bytes.length) {
      if (bytes[cursor] !== 255) return bad();
      while (bytes[cursor] === 255) cursor++;
      const marker = bytes[cursor++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (cursor + 2 > bytes.length) return bad();
      const length = view.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length) return bad();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) return bad();
        dimensions = assertImageDimensions(view.getUint16(cursor + 5), view.getUint16(cursor + 3));
        break;
      }
      cursor += length;
    }
    if (!dimensions) return bad();
  } else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    if (bytes.length < 30 || view.getUint32(4, true) + 8 > bytes.length) return bad();
    type = 'image/webp';
    const chunk = ascii(12, 4);
    const uint24 = (offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    if (chunk === 'VP8X') {
      if (bytes[20] & 2) throw new ReceiptOcrError('Animated WebP receipts are not supported. Export a single image first.', 'animated_receipt', 415);
      dimensions = assertImageDimensions(uint24(24) + 1, uint24(27) + 1);
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      dimensions = assertImageDimensions(1 + (((bytes[22] & 63) << 8) | bytes[21]), 1 + (((bytes[24] & 15) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)));
    } else if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      dimensions = assertImageDimensions(view.getUint16(26, true) & 16383, view.getUint16(28, true) & 16383);
    } else return bad();
  } else return bad();
  const declared = mime.toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream' && declared !== type && !(declared === 'image/jpg' && type === 'image/jpeg')) {
    throw new ReceiptOcrError('The file contents do not match its declared type. Export a fresh image or PDF and try again.', 'file_type_mismatch', 415);
  }
  return { type, ...dimensions };
}

export async function readReceiptFile(formData) {
  const file = formData?.get?.('receipt');
  if (!(file instanceof Blob) || (formData.getAll && formData.getAll('receipt').length !== 1)) throw new ReceiptOcrError('Choose one local receipt file. URLs and text are not accepted.', 'receipt_file_required', 400);
  if (!file.size) throw new ReceiptOcrError('The selected receipt file is empty.', 'empty_receipt', 400);
  if (file.size > RECEIPT_LIMITS.fileBytes) throw new ReceiptOcrError('Receipt files must be 10 MiB or smaller.', 'receipt_size_limit', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, ...inspectReceiptBytes(bytes, file.type) };
}
