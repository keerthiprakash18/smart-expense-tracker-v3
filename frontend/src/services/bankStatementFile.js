// File selection validation is intentionally independent of the platform picker.
// Android document providers may expose bank PDFs as application/octet-stream,
// so we do not use a restrictive accept attribute on the file input.
export const MAX_BANK_STATEMENT_BYTES = 5 * 1024 * 1024;

export function selectBankStatementFile(file) {
  if (!file || typeof file.name !== 'string' || typeof file.size !== 'number') {
    throw new Error('No statement was selected. Choose a PDF or CSV from your device.');
  }
  if (file.size === 0) throw new Error('The selected statement is empty. Download it again.');
  if (file.size > MAX_BANK_STATEMENT_BYTES) {
    throw new Error('This file is larger than 5 MB. Choose a statement no bigger than 5 MB.');
  }
  const name = file.name.trim();
  const mime = String(file.type || '').toLowerCase();
  const format = /\.pdf$/i.test(name) || mime === 'application/pdf'
    ? 'pdf'
    : /\.csv$/i.test(name) || mime === 'text/csv'
      ? 'csv'
      : null;
  if (!format) throw new Error('Unsupported file. Choose a bank statement in PDF (.pdf) or CSV (.csv) format.');
  return { file, format, name, sizeLabel: file.size < 1024 ? file.size + ' B' : (file.size / 1024 / 1024).toFixed(2) + ' MB' };
}
