// Strict local-only extraction of structured bank statement tables from PDFs.
// PDF bytes and user-entered password never leave the browser.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerAsset from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { financeError } from './supabaseFinance.js';
import { parsePdfBankItems } from './supabaseBankPdfLayout.js';
import { diagnoseBankPdfPages } from './bankPdfSafeDiagnostics.js';

const MAX_PAGES = 25;
const MAX_ITEMS = 25000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 800000;
const MAX_DURATION_MS = 45000;
// Use the same own-origin PDF font assets as receipt OCR. No untrusted external URLs.
const resources = import.meta.glob('../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*',
  { eager: true, query: '?url&no-inline', import: 'default' });
const resourceMap = new Map(Object.entries(resources).map(([path,url]) =>
  [path.split('/').slice(-2).join('/'), url]));

class LocalBinaryDataFactory {
  async fetch({ kind, filename }) {
    const folder = {cMapUrl:'cmaps', standardFontDataUrl:'standard_fonts', wasmUrl:'wasm'}[kind];
    const entry = folder && typeof filename === 'string' && !/[\\/]/.test(filename)
      ? resourceMap.get(folder + '/' + filename) : null;
    if (!entry) throw new Error('Bundled PDF font or decoder unavailable.');
    const asset = new URL(entry, window.location.href);
    if (asset.origin !== window.location.origin) throw new Error('Cross-origin PDF assets are not allowed.');
    const response = await fetch(asset, {mode:'same-origin', credentials:'omit', redirect:'error'});
    if (!response.ok) throw new Error('Bundled PDF asset could not load.');
    return new Uint8Array(await response.arrayBuffer());
  }
}

export async function parseBankPdf(file, password = '') {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_PDF_BYTES)
    throw financeError('PDF statement must be between 1 byte and 5 MB.');
  if (typeof window === 'undefined' || typeof Worker === 'undefined')
    throw financeError('PDF statements need a modern browser with local PDF worker support.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0,5)) !== '%PDF-')
    throw financeError('This is not a valid PDF statement.');
  const workerUrl = new URL(workerAsset, window.location.href);
  if (workerUrl.origin !== window.location.origin)
    throw financeError('PDF worker must be hosted by this application.');
  const nativeWorker = new Worker(workerUrl, { type:'module' });
  const worker = new pdfjs.PDFWorker({port:nativeWorker});
  let loading;
  let timeout;
  let timedOut = false;
  try {
    const work = async () => {
      loading = pdfjs.getDocument({
        data:bytes, password:password || undefined, worker, verbosity:0, stopAtErrors:true,
        enableXfa:false, isEvalSupported:false, useWorkerFetch:false,
        BinaryDataFactory:LocalBinaryDataFactory,
        cMapPacked:true, useSystemFonts:true, disableFontFace:true,
        disableAutoFetch:true, disableStream:true, disableRange:true,
      });
      const doc = await loading.promise;
      if (!Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > MAX_PAGES)
        throw financeError('PDF must contain between 1 and 25 pages. Export a smaller statement.');
      const pages = [];
      let count = 0, chars = 0;
      for (let pageNo=1; pageNo <= doc.numPages; pageNo++) {
        const page = await doc.getPage(pageNo);
        const viewport = page.getViewport({scale:1});
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
            Math.max(viewport.width,viewport.height)>4096)
          throw financeError('Unusually large PDF page. Export a normal bank statement.');
        const data = await page.getTextContent({disableNormalization:false});
        count += data.items.length;
        chars += data.items.reduce((size,item) => size + String(item.str || '').length,0);
        if (count > MAX_ITEMS || chars > MAX_TEXT)
          throw financeError('PDF text exceeds safe processing limits. Export a shorter statement.');
        pages.push(data.items);
        page.cleanup();
      }
      try {
        return parsePdfBankItems(pages);
      } catch (error) {
        // Only safe aggregate geometry is exposed on failure. The uploaded
        // document, PDF text, amounts and password remain in this browser.
        if (error?.response?.data) {
          error.response.data.safePdfDiagnostic = diagnoseBankPdfPages(pages);
        }
        throw error;
      }
    };
    return await Promise.race([
      work(),
      new Promise((_,reject) => { timeout = setTimeout(() => {
        timedOut = true;
        reject(financeError('PDF parsing timed out. Export a smaller statement as CSV.'));
      }, MAX_DURATION_MS); }),
    ]);
  } catch (error) {
    if (timedOut) throw error;
    if (error?.response) throw error;
    if (error?.name === 'PasswordException' || /password/i.test(String(error?.message || '')))
      throw financeError(password ? 'Incorrect or unsupported PDF password. Try the statement password again.'
        : 'PDF password required. Enter the password shown in your bank statement instructions.');
    throw financeError('This PDF could not be read reliably. Try a text-based bank PDF or export CSV.');
  } finally {
    clearTimeout(timeout);
    if (loading) await loading.destroy().catch(() => {});
    nativeWorker.terminate();
    worker.destroy();
  }
}
