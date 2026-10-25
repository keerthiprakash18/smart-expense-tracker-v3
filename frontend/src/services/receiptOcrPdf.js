import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerAsset from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { RECEIPT_LIMITS, ReceiptOcrError, assertPdfPages, renderDimensions } from './receiptOcrLimits.js';

// These exact installed dependency assets are emitted by Vite. A PDF-provided
// URL/name can never cause arbitrary fetching: only an own-property map hit is used.
const resources = import.meta.glob('../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*', { eager: true, query: '?url&no-inline', import: 'default' });
const resourceMap = new Map(Object.entries(resources).map(([path, url]) => [path.split('/').slice(-2).join('/'), url]));

export async function extractPdfReceipt(bytes, { signal, recognize, progress, checkpoint }) {
  const url = new URL(workerAsset, window.location.href);
  if (url.origin !== window.location.origin) throw new ReceiptOcrError('PDF worker assets must be served by this app.', 'pdf_worker_origin');
  const nativeWorker = new Worker(url, { type: 'module' });
  const worker = new pdfjs.PDFWorker({ port: nativeWorker });
  let task;
  let renderTask;
  const stop = () => { renderTask?.cancel(); nativeWorker.terminate(); };
  signal.addEventListener('abort', stop, { once: true });
  class LocalBinaryDataFactory {
    async fetch({ kind, filename }) {
      const folder = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }[kind];
      const path = typeof filename === 'string' && !/[\\/]/.test(filename) ? resourceMap.get(`${folder}/${filename}`) : null;
      if (!path) throw new ReceiptOcrError('This PDF needs an unsupported font or decoder. Export it as a PNG or JPEG receipt.', 'pdf_resource_unavailable');
      const asset = new URL(path, window.location.href);
      if (asset.origin !== window.location.origin) throw new ReceiptOcrError('Cross-origin PDF resources are not allowed.');
      const response = await fetch(asset, { signal, mode: 'same-origin', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new ReceiptOcrError('A bundled PDF resource could not be loaded. Check your connection and try again.');
      return new Uint8Array(await response.arrayBuffer());
    }
  }
  try {
    task = pdfjs.getDocument({
      data: bytes, worker, verbosity: 0, stopAtErrors: true, enableXfa: false,
      isEvalSupported: false, useWorkerFetch: false, BinaryDataFactory: LocalBinaryDataFactory,
      cMapPacked: true, useSystemFonts: true, disableFontFace: false,
      maxImageSize: RECEIPT_LIMITS.imagePixels, canvasMaxAreaInBytes: RECEIPT_LIMITS.renderPixels * 4,
      disableAutoFetch: true, disableStream: true, disableRange: true,
    });
    const document = await task.promise;
    checkpoint();
    assertPdfPages(document.numPages);
    const pages = [];
    let totalCharacters = 0;
    for (let number = 1; number <= document.numPages; number++) {
      checkpoint();
      progress({ status: 'reading PDF page', page: number, pages: document.numPages });
      const page = await document.getPage(number);
      const base = page.getViewport({ scale: 1 });
      if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0 || Math.max(base.width, base.height) > RECEIPT_LIMITS.pdfPointDimension) throw new ReceiptOcrError('The PDF page is too large. Export a normal receipt-sized page or image.', 'pdf_dimension_limit', 413);
      const reader = page.streamTextContent({ disableNormalization: false }).getReader();
      let text = '';
      let itemCount = 0;
      let lastY;
      try {
        while (true) {
          checkpoint();
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (++itemCount > RECEIPT_LIMITS.textItems) throw new ReceiptOcrError('The PDF contains too many text objects for receipt scanning.', 'pdf_text_limit', 413);
            if (typeof item.str !== 'string') continue;
            const y = item.transform?.[5];
            text += (lastY !== undefined && Math.abs(y - lastY) > 2 ? '\n' : ' ') + item.str + (item.hasEOL ? '\n' : '');
            lastY = y;
            if (totalCharacters + text.length > RECEIPT_LIMITS.textCharacters) throw new ReceiptOcrError('The PDF contains too much text. Split it into smaller receipts.', 'pdf_text_limit', 413);
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (text.trim().length >= 40 && /[\p{L}\p{N}]/u.test(text)) {
        pages.push({ text, confidence: null, source: 'pdf-text' });
      } else {
        checkpoint();
        const size = renderDimensions(base.width, base.height, 2);
        const canvas = window.document.createElement('canvas');
        canvas.width = size.width; canvas.height = size.height;
        try {
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new ReceiptOcrError('Canvas rendering is unavailable in this browser.');
          renderTask = page.render({ canvasContext: context, canvas, viewport: page.getViewport({ scale: size.scale }), annotationMode: pdfjs.AnnotationMode.DISABLE, background: 'rgb(255,255,255)' });
          renderTask.onContinue = (resume) => { if (signal.aborted) renderTask.cancel(); else resume(); };
          await renderTask.promise;
          renderTask = null;
          const recognized = await recognize(canvas);
          text = recognized.text;
          pages.push({ ...recognized, source: 'pdf-raster-ocr' });
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      totalCharacters += text.length;
      if (totalCharacters > RECEIPT_LIMITS.textCharacters) throw new ReceiptOcrError('The PDF contains too much text for receipt scanning.', 'pdf_text_limit', 413);
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (signal.aborted || error instanceof ReceiptOcrError) throw error;
    if (error?.name === 'PasswordException') throw new ReceiptOcrError('Password-protected PDFs cannot be scanned here. Export an unlocked receipt locally first.', 'encrypted_pdf');
    throw new ReceiptOcrError('This PDF could not be read safely. It may be malformed or use an unsupported feature. Export a PNG/JPEG receipt instead.', 'invalid_pdf');
  } finally {
    signal.removeEventListener('abort', stop);
    // Terminate even if the parser is stuck; never leave a document worker alive
    // after cancellation. Cleanup rejections are not document-processing results.
    if (task && !signal.aborted) await task.destroy().catch(() => {});
    nativeWorker.terminate();
    worker.destroy();
  }
}
