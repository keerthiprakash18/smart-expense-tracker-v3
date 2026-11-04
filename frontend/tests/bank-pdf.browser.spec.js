import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clear = readFileSync(fileURLToPath(new URL('./fixtures/synthetic-bank.pdf', import.meta.url))).toString('base64');
const encrypted = readFileSync(fileURLToPath(new URL('./fixtures/synthetic-bank-encrypted.pdf', import.meta.url))).toString('base64');

async function load(page, context) {
  const external = [];
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== 'http://127.0.0.1:4178') {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/tests/bank-pdf.html');
  await page.waitForFunction(() => window.bankPdfReady === true);
  return external;
}

async function read(page, source, password) {
  return page.evaluate(async ({source, password}) => {
    const bytes = Uint8Array.from(atob(source), (character) => character.charCodeAt(0));
    const file = new File([bytes], 'synthetic-bank.pdf', {type:'application/pdf'});
    try { return { rows: await window.parseBankPdf(file, password) }; }
    catch (error) { return { error: error?.response?.data?.error || error?.message || String(error) }; }
  }, {source,password});
}

test('unencrypted bank PDF is parsed locally without network requests', async ({page,context}) => {
  const external = await load(page,context);
  const result = await read(page,clear,'');
  expect(result.error).toBeUndefined();
  expect(result.rows.map(row => [row.date,row.amount,row.transaction_type])).toEqual([
    ['2026-11-04','350.00','EXPENSE'],
    ['2026-11-05','25000.00','INCOME'],
    ['2026-11-06','500.00','EXPENSE'],
  ]);
  expect(external).toEqual([]);
});

test('AES password-protected bank PDF opens only with matching password', async ({page,context}) => {
  const external = await load(page,context);
  const missing = await read(page,encrypted,'');
  expect(missing.error).toMatch(/password/i);
  const incorrect = await read(page,encrypted,'WrongPassword');
  expect(incorrect.error).toMatch(/password/i);
  const unlocked = await read(page,encrypted,'OnlyForTests123');
  expect(unlocked.error).toBeUndefined();
  expect(unlocked.rows).toHaveLength(3);
  expect(unlocked.rows[0].description).toContain('SWIGGY');
  expect(external).toEqual([]);
});

test('5 MB PDF limit rejects oversized files before parsing', async ({page,context}) => {
  await load(page,context);
  const result = await page.evaluate(async () => {
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'oversize.pdf', {type:'application/pdf'});
    try { await window.parseBankPdf(file); return 'unexpected-success'; }
    catch (error) { return error?.response?.data?.error || String(error); }
  });
  expect(result).toMatch(/5 MB/i);
});
