import { test, expect } from '@playwright/test';

async function localPage(page, context) {
  const external = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:4176' || route.request().method() !== 'GET') { external.push(`${route.request().method()} ${route.request().url()}`); return route.abort(); }
    return route.continue();
  });
  await page.goto('/tests/receipt-ocr.html');
  await page.waitForFunction(() => window.ocrReady);
  return external;
}

function textPdf(pageCount = 1) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let index = 0; index < pageCount; index++) {
    const content = 'BT /F1 20 Tf 40 740 Td (PDF TEST CAFE) Tj 0 -35 Td (Date: 2026-10-25) Tj 0 -35 Td (Grand Total USD 24.00) Tj 0 -35 Td (Payment Cash) Tj ET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(output.length); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return output;
}

test('actual Tesseract OCR reads a synthetic receipt using only same-origin bundled assets', async ({ page, context }) => {
  const external = await localPage(page, context);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 650;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 650); ctx.fillStyle = '#000'; ctx.font = '36px Arial';
    ['LOCAL TEST CAFE', 'Date: 2026-10-25', 'Coffee        5.00', 'Cake         10.00', 'Grand Total USD 15.00', 'Payment Cash'].forEach((line, index) => ctx.fillText(line, 60, 80 + index * 75));
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new FormData(); data.append('receipt', blob, 'synthetic.png');
    const events = [];
    let result;
    try { result = await window.scanReceipt(data, { onProgress: (event) => events.push(event.status) }); }
    catch (error) { throw new Error(`${error.message}; stages: ${events.join(', ')}`); }
    return { result, events };
  });
  expect(result.result.parsed_data.amount).toBe(15);
  expect(result.result.parsed_data.merchant).toContain('LOCAL TEST CAFE');
  expect(result.result.parsed_data.date).toBe('2026-10-25');
  expect(result.result.review_required).toBe(true);
  expect(result.result.processing).toBe('local-browser');
  expect(result.result.is_duplicate).toBeNull();
  expect(result.events).toContain('recognizing text');
  expect(external).toEqual([]);
});

test('actual PDF.js extracts a text receipt locally without starting Tesseract', async ({ page, context }) => {
  const external = await localPage(page, context);
  const result = await page.evaluate(async (pdf) => {
    const data = new FormData(); data.append('receipt', new Blob([pdf], { type: 'application/pdf' }), 'receipt.pdf');
    return window.scanReceipt(data);
  }, textPdf());
  expect(result.parsed_data.amount).toBe(24);
  expect(result.parsed_data.date).toBe('2026-10-25');
  expect(result.parsed_data.source).toBe('pdf-text');
  expect(result.parsed_data.confidence.ocr).toBeNull();
  expect(external).toEqual([]);
});

test('actual PDF.js rejects a four-page document and malformed input explicitly', async ({ page, context }) => {
  await localPage(page, context);
  for (const [pdf, code] of [[textPdf(4), 'pdf_page_limit'], ['%PDF-1.7\nnot a pdf\n%%EOF', 'invalid_pdf']]) {
    const result = await page.evaluate(async (pdf) => {
      const data = new FormData(); data.append('receipt', new Blob([pdf], { type: 'application/pdf' }), 'receipt.pdf');
      try { await window.scanReceipt(data); return 'unexpected-success'; } catch (error) { return error.code; }
    }, pdf);
    expect(result).toBe(code);
  }
});

test('cancellation during actual worker initialization stops the scan without a fabricated result', async ({ page, context }) => {
  await localPage(page, context);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 200);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new FormData(); data.append('receipt', blob, 'blank.png');
    const controller = new AbortController();
    try { await window.scanReceipt(data, { signal: controller.signal, onProgress: (event) => { if (event.status === 'loading tesseract core') controller.abort(); } }); return 'unexpected-success'; }
    catch (error) { return error.code; }
  });
  expect(result).toBe('receipt_cancelled');
});

test('actual image-only PDF is rasterized and OCRed locally', async ({ page, context }) => {
  const external = await localPage(page, context);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 650;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 650); ctx.fillStyle = '#000'; ctx.font = '36px Arial';
    ['RASTER TEST CAFE', 'Date: 2026-10-25', 'Coffee        5.00', 'Cake         10.00', 'Grand Total USD 15.00', 'Payment Cash'].forEach((line, index) => ctx.fillText(line, 60, 80 + index * 75));
    const image = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    const jpeg = new Uint8Array(await image.arrayBuffer());
    const chunks = []; const offsets = [0]; let length = 0;
    const push = (value) => { const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value; chunks.push(bytes); length += bytes.length; };
    const object = (id, contents) => { offsets[id] = length; push(`${id} 0 obj\n`); for (const value of contents) push(value); push('\nendobj\n'); };
    push('%PDF-1.4\n');
    object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    object(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
    object(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 325] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>']);
    object(4, [`<< /Type /XObject /Subtype /Image /Width 1000 /Height 650 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream']);
    const drawing = 'q 500 0 0 325 0 0 cm /Im0 Do Q';
    object(5, [`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`]);
    const xref = length;
    push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    const data = new FormData(); data.append('receipt', new Blob(chunks, { type: 'application/pdf' }), 'raster.pdf');
    return window.scanReceipt(data);
  });
  expect(result.parsed_data.source).toBe('pdf-raster-ocr');
  expect(result.parsed_data.amount).toBe(15);
  expect(result.parsed_data.date).toBe('2026-10-25');
  expect(external).toEqual([]);
});

test('a browser blocking the local worker gets an explicit error instead of a false result', async ({ page, context }) => {
  await localPage(page, context);
  await context.route('**/assets/receiptOcrWorker-*.js', (route) => route.abort());
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const data = new FormData(); data.append('receipt', blob, 'worker-test.png');
    return Promise.race([
      window.scanReceipt(data).then(() => 'unexpected-success', (error) => error.code),
      new Promise((resolve) => setTimeout(() => resolve('worker-error-not-reported'), 10000)),
    ]);
  });
  expect(result).toBe('ocr_worker_unavailable');
});
