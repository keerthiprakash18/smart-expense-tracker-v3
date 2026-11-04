// Strict local-only extraction of structured bank statement tables from PDFs.
// PDF bytes and user-entered password never leave the browser.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerAsset from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { financeError } from './supabaseFinance.js';
import { parseBankCsv } from './supabaseBankStatement.js';

const MAX_PAGES = 25;
const MAX_ITEMS = 25000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 800000;
const MAX_DURATION_MS = 45000;
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const labels = {
  date: ['date', 'transactiondate', 'valuedate', 'txndate', 'postingdate', 'trandate'],
  description: ['narration', 'description', 'particulars', 'remarks', 'details', 'transactiondetails', 'transactiondescription'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'withdrawalamount', 'debitamount', 'dramount', 'paidout'],
  credit: ['credit', 'deposit', 'depositamt', 'depositamount', 'creditamount', 'cramount', 'paidin'],
  amount: ['amount', 'transactionamount', 'txnamount', 'transactionamt'],
  direction: ['drcr', 'crdr', 'transactiontype', 'debitcredit', 'type'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'availablebalance'],
  reference: ['reference', 'referenceno', 'referenceid', 'transactionid', 'utr', 'utrno', 'refno', 'chequeno', 'chequenumber'],
};

function identifyHeader(items) {
  const fields = [];
  for (const item of items) {
    const value = normalize(item.text);
    const label = Object.entries(labels).find(([, variants]) => variants.includes(value))?.[0];
    if (label && !fields.some((f) => f.field === label)) fields.push({ field: label, x: item.x });
  }
  fields.sort((a,b) => a.x - b.x);
  const present = new Set(fields.map((c) => c.field));
  if (!present.has('date') || !present.has('description')) return null;
  if (!(present.has('debit') && present.has('credit')) &&
      !(present.has('amount') && present.has('direction'))) return null;
  if (fields.length < 4) return null;
  return fields;
}

function rowsByBaseline(items) {
  const lines = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str.trim() ||
        !Number.isFinite(item.transform?.[4]) || !Number.isFinite(item.transform?.[5])) continue;
    const x = item.transform[4], y = item.transform[5];
    const row = lines.find((line) => Math.abs(line.y - y) <= 2);
    if (row) row.items.push({ x, text: item.str.trim() });
    else lines.push({ y, items: [{ x, text: item.str.trim() }] });
  }
  return lines.sort((a,b) => b.y - a.y).map((line) =>
    line.items.sort((a,b) => a.x - b.x)
  );
}

function mapCells(items, header) {
  const values = Object.fromEntries(header.map((h) => [h.field, '']));
  const boundaries = header.slice(1).map((h,i) => (h.x + header[i].x) / 2);
  for (const item of items) {
    const column = boundaries.findIndex((limit) => item.x < limit);
    const field = header[column < 0 ? header.length - 1 : column].field;
    values[field] = (values[field] ? values[field] + ' ' : '') + item.text;
  }
  return values;
}

const datePattern = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4})$/;
function csvCell(value) {
  return '"' + String(value ?? '').replaceAll('"', '""') + '"';
}

// Exported pure parser lets us test PDF layout handling without authentic bank data.
export function parsePdfBankItems(pages) {
  let header = null;
  let pending = null;
  const records = [];
  const flush = () => {
    if (!pending) return;
    const debit = String(pending.debit || '').trim();
    const credit = String(pending.credit || '').trim();
    const sum = String(pending.amount || '').trim();
    if (!debit && !credit && !sum) {
      if (!/^(?:opening|closing)\s+balance/i.test(pending.description || ''))
        throw financeError('PDF has a dated row without an amount. Use a bank-exported CSV for this layout.');
    } else records.push(pending);
    pending = null;
  };
  for (const page of pages) {
    for (const line of rowsByBaseline(page)) {
      const detected = identifyHeader(line);
      if (detected) {
        flush();
        header = detected;
        continue;
      }
      if (!header) continue;
      const values = mapCells(line, header);
      const date = String(values.date || '').trim();
      if (datePattern.test(date)) {
        flush();
        pending = values;
      } else if (pending && !date && values.description && !values.debit && !values.credit &&
                 !values.amount && !/^(?:total|page\s*\d|statement\s+end|generated\s+on|closing\s+balance)/i.test(values.description)) {
        pending.description = ((pending.description || '') + ' ' + values.description).slice(0, 200);
      } else if (/^(?:total|closing\s+balance|end\s+of\s+statement)/i.test(values.description || '')) {
        flush();
        header = null;
      }
    }
  }
  flush();
  if (!records.length) throw financeError('No structured bank transactions found in this PDF. Try a bank-exported CSV.');
  if (records.length > 1000) throw financeError('Only 1,000 transactions are supported per statement.');
  const csv = [
    ['Date','Narration','Debit','Credit','Amount','DrCr','Closing Balance','Reference'],
    ...records.map((r) => [r.date, r.description, r.debit, r.credit, r.amount, r.direction, r.balance, r.reference]),
  ].map((row) => row.map(csvCell).join(',')).join('\n');
  return parseBankCsv(csv);
}

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
      return parsePdfBankItems(pages);
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
