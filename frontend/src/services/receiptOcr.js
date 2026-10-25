import { RECEIPT_LIMITS, ReceiptOcrError, readReceiptFile, assertImageDimensions, renderDimensions } from './receiptOcrLimits.js';
import { parseReceiptText } from './receiptOcrParser.js';

let active = false;

function createRecognitionEngine(signal, progress, checkpoint) {
  // A parent worker owns Tesseract's child worker. Terminating it also stops a
  // child still initializing, so cancellation does not wait for model startup.
  const worker = new Worker(new URL('./receiptOcrWorker.js', import.meta.url), { type: 'module', name: 'private-receipt-ocr' });
  let pending;
  let workerFailure;
  const stop = () => {
    worker.terminate();
    pending?.reject(new ReceiptOcrError('Receipt scanning was cancelled.', 'receipt_cancelled', 499));
    pending = null;
  };
  signal.addEventListener('abort', stop, { once: true });
  worker.onmessage = ({ data }) => {
    if (data?.type === 'progress') progress({ status: data.status, progress: data.progress });
    else if (data?.type === 'result' && pending) { pending.resolve({ text: String(data.text || ''), confidence: Number.isFinite(data.confidence) ? data.confidence : 0 }); pending = null; }
    else if (data?.type === 'error' && pending) { pending.reject(new ReceiptOcrError(data.message, 'local_ocr_failed')); pending = null; }
  };
  worker.onerror = () => { workerFailure = new ReceiptOcrError('Local OCR workers are unavailable. Try a current browser or enter the receipt manually.', 'ocr_worker_unavailable'); pending?.reject(workerFailure); pending = null; worker.terminate(); };
  return {
    async recognize(canvas) {
      checkpoint();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new ReceiptOcrError('The receipt image could not be prepared for OCR.');
      const bytes = await blob.arrayBuffer();
      checkpoint();
      if (workerFailure) throw workerFailure;
      return new Promise((resolve, reject) => { pending = { resolve, reject }; worker.postMessage({ type: 'recognize', bytes }, [bytes]); });
    },
    dispose() { signal.removeEventListener('abort', stop); stop(); },
  };
}

async function recognizeImage(file, recognize, checkpoint) {
  if (typeof createImageBitmap !== 'function') throw new ReceiptOcrError('This browser cannot decode receipt images locally. Try a current browser.', 'image_decoder_unavailable');
  const bitmap = await createImageBitmap(new Blob([file.bytes], { type: file.type }), { imageOrientation: 'from-image' });
  let canvas;
  try {
    checkpoint();
    assertImageDimensions(bitmap.width, bitmap.height);
    const size = renderDimensions(bitmap.width, bitmap.height, Math.min(2, Math.max(1, 1400 / Math.max(bitmap.width, bitmap.height))));
    canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new ReceiptOcrError('Canvas rendering is unavailable in this browser.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await recognize(canvas);
  } finally { bitmap.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

/** Local-only extraction. Never saves an expense or uploads receipt bytes.
 * options: { signal?: AbortSignal, onProgress?: (event) => void, progress?: fn }
 * returns the Django-compatible { parsed_data, ... } payload, not an HTTP wrapper.
 */
export async function scanReceipt(formData, options = {}) {
  if (options.signal?.aborted) throw new ReceiptOcrError('Receipt scanning was cancelled.', 'receipt_cancelled', 499);
  if (active) throw new ReceiptOcrError('Another local receipt scan is running. Cancel it before starting another.', 'receipt_scan_busy', 409);
  active = true;
  const controller = new AbortController();
  let engine;
  let timeout = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timeout = true; abort(); }, RECEIPT_LIMITS.timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  const checkpoint = () => { if (controller.signal.aborted) throw new ReceiptOcrError(timeout ? 'Local scanning reached its 90-second limit. Try a smaller, sharper receipt or enter it manually.' : 'Receipt scanning was cancelled.', timeout ? 'receipt_timeout' : 'receipt_cancelled', timeout ? 408 : 499); };
  const progress = (event) => { if (!controller.signal.aborted) { try { (options.onProgress || options.progress)?.(event); } catch { /* UI progress callbacks do not control the scan. */ } } };
  const recognize = async (canvas) => {
    checkpoint();
    engine ||= createRecognitionEngine(controller.signal, progress, checkpoint);
    return engine.recognize(canvas);
  };
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  controller.signal.addEventListener('abort', () => { try { checkpoint(); } catch (error) { rejectCancelled(error); } }, { once: true });
  try {
    const work = async () => {
      progress({ status: 'validating local receipt' });
      const file = await readReceiptFile(formData);
      checkpoint();
      if (typeof window === 'undefined' || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new ReceiptOcrError('Local receipt scanning requires a modern browser with Web Workers and WebAssembly.', 'ocr_unavailable', 503);
      let pages;
      if (file.type === 'application/pdf') {
        const { extractPdfReceipt } = await import('./receiptOcrPdf.js');
        checkpoint();
        pages = await extractPdfReceipt(file.bytes, { signal: controller.signal, recognize, progress, checkpoint });
      } else pages = [{ ...await recognizeImage(file, recognize, checkpoint), source: 'image-ocr' }];
      checkpoint();
      const confidences = pages.map((page) => page.confidence).filter((value) => value !== null);
      const parsed = parseReceiptText(pages.map((page) => page.text).join('\n'), { ocrConfidence: confidences.length ? Math.min(...confidences) : null, source: [...new Set(pages.map((page) => page.source))].join('+') });
      parsed.warnings.push('Image recognition uses the bundled English model. Non-English text and handwriting may need manual entry.');
      if (pages.some((page) => page.source === 'pdf-text')) parsed.warnings.push('PDF text extraction can omit image-only details. Compare the suggestions with the original receipt.');
      progress({ status: 'ready for review', progress: 1 });
      return { parsed_data: parsed, review_required: true, warnings: parsed.warnings, is_duplicate: null, duplicate_match: null, duplicate_check_performed: false, processing: 'local-browser', pages_processed: pages.length };
    };
    return await Promise.race([work(), cancelled]);
  } catch (error) {
    if (controller.signal.aborted) checkpoint();
    if (error instanceof ReceiptOcrError) throw error;
    throw new ReceiptOcrError('The receipt could not be read locally. Try a valid, clearer JPEG/PNG image or a simpler PDF.', 'local_scan_failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    engine?.dispose();
    active = false;
  }
}
