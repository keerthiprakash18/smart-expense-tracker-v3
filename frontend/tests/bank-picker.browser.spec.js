import { test, expect } from '@playwright/test';

const pdf = {name:'Bank Statement NOV 2026.PDF',mimeType:'application/octet-stream',
  buffer:Buffer.from('%PDF-1.4\nSynthetic test bytes, not real bank data\n%%EOF')};
const csv = {name:'bank-export.csv',mimeType:'text/csv',
  buffer:Buffer.from('Date,Narration,Debit,Credit\n04/11/2026,Test expense,55.00,\n')};

test('mobile: native file chooser persists a downloaded PDF and unlocks Preview', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/tests/bank-picker.html');
  const input = page.locator('#bank-statement-file');
  await expect(input).toBeVisible();
  await expect(input).not.toHaveAttribute('accept');
  await expect(page.locator('#bank-file-status')).toContainText('No file selected');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeDisabled();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    input.click(),
  ]);
  await chooser.setFiles(pdf);
  expect(await input.evaluate(el=>el.files?.[0]?.name)).toBe('Bank Statement NOV 2026.PDF');
  await expect(page.locator('#bank-file-status')).toContainText('File selected: Bank Statement NOV 2026.PDF');
  await expect(page.locator('#bank-file-status')).toContainText('ready for preview');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeEnabled();
  await expect(page.locator('select').first()).toHaveValue('12');
  await page.locator('input[type="password"]').fill('SyntheticPassword123');
  await page.getByRole('button',{name:/Preview transactions/i}).click();
  await expect(page.getByText('Fake bank statement expense')).toBeVisible();
  const requests = await page.evaluate(()=>window.__bankPickerRequests);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual(expect.objectContaining({
    filename:'Bank Statement NOV 2026.PDF',account:'12',password:'SyntheticPassword123',
  }));
});

test('desktop: CSV and PDF are both selectable and format follows actual file', async ({page}) => {
  await page.setViewportSize({width:1280,height:800});
  await page.goto('/tests/bank-picker.html');
  const input=page.locator('#bank-statement-file');
  await input.setInputFiles(csv);
  await expect(page.locator('#bank-file-status')).toContainText('bank-export.csv');
  await expect(page.getByLabel('Statement format')).toHaveValue('csv');
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeEnabled();
  await input.setInputFiles(pdf);
  await expect(page.locator('#bank-file-status')).toContainText('Bank Statement NOV 2026.PDF');
  await expect(page.getByLabel('Statement format')).toHaveValue('pdf');
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
});

test('5MB limit and invalid file type show an actionable error instead of silently failing',async ({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/tests/bank-picker.html');
  const input=page.locator('#bank-statement-file');
  await input.setInputFiles({name:'too-large.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(5*1024*1024+1)});
  await expect(page.getByRole('alert')).toContainText('larger than 5 MB');
  await expect(page.locator('#bank-file-status')).toContainText('No file selected');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeDisabled();
  await input.setInputFiles({name:'photo.jpg',mimeType:'image/jpeg',buffer:Buffer.from('not-a-statement')});
  await expect(page.getByRole('alert')).toContainText('Unsupported file');
  await input.setInputFiles(pdf);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeEnabled();
  await page.getByRole('button',{name:'Remove'}).click();
  await expect(page.locator('#bank-file-status')).toContainText('No file selected');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeDisabled();
});

test('changing PDF/CSV selection resets the previous file and allows reselecting it',async ({page})=>{
  await page.goto('/tests/bank-picker.html');
  const input=page.locator('#bank-statement-file');
  await input.setInputFiles(pdf);
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeEnabled();
  await page.getByLabel('Statement format').selectOption('csv');
  await expect(page.locator('#bank-file-status')).toContainText('No file selected');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeDisabled();
  await input.setInputFiles(pdf);
  await expect(page.locator('#bank-file-status')).toContainText('Bank Statement NOV 2026.PDF');
  await expect(page.getByLabel('Statement format')).toHaveValue('pdf');
  await expect(page.getByRole('button',{name:/Preview transactions/i})).toBeEnabled();
});
