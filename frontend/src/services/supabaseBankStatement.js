// Read-only bank statement preview plus explicitly approved Supabase import.
// Supports bank-exported UTF-8 CSV and text-based PDF. Raw statements never leave this browser.
import { parseCsv } from './trackerCsv.js';
import { checked, financeError, readAll } from './supabaseFinance.js';

const MAX_SIZE = 5 * 1024 * 1024;
const MAX_ROWS = 1000;
const aliases = {
  date: ['date', 'transactiondate', 'valuedate', 'txndate', 'postingdate', 'trandate'],
  description: ['description', 'narration', 'particulars', 'remarks', 'details', 'transactiondetails', 'transactiondescription'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'withdrawalamount', 'debitamount', 'dramount', 'paidout'],
  credit: ['credit', 'deposit', 'depositamt', 'depositamount', 'creditamount', 'cramount', 'paidin'],
  amount: ['amount', 'transactionamount', 'txnamount', 'transactionamt'],
  direction: ['drcr', 'crdr', 'transactiontype', 'debitcredit', 'type'],
  reference: ['reference', 'referenceno', 'referenceid', 'transactionid', 'utr', 'utrno', 'refno', 'chequeno', 'chequenumber', 'chqrefno'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'availablebalance'],
};
const categoryKeywords = [
  ['Food & Dining', ['swiggy', 'zomato', 'restaurant', 'cafe', 'coffee', 'food']],
  ['Transport', ['petrol', 'fuel', 'uber', 'ola', 'metro', 'irctc']],
  ['Shopping', ['amazon', 'flipkart', 'myntra', 'retail']],
  ['Bills & Utilities', ['electricity', 'broadband', 'recharge', 'water bill']],
  ['Health', ['hospital', 'pharmacy', 'medical']],
  ['Entertainment', ['netflix', 'spotify', 'cinema', 'movie']],
];
const transferWords = ['self transfer', 'own account', 'own a/c', 'credit card payment', 'credit card bill', 'cc payment', 'card settlement'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const padded = (value) => String(value).padStart(2, '0');

function isoDate(input) {
  const raw = String(input ?? '').trim().split(/\s+/)[0];
  let year, month, day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) [year, month, day] = raw.split('-').map(Number);
  else if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$/.test(raw)) {
    [day, month, year] = raw.split(/[\/.-]/).map(Number); // Indian bank statements: DD/MM/YYYY
  } else throw financeError('Unrecognized date: expected DD/MM/YYYY or YYYY-MM-DD.');
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year < 1990 || year > 2100 || dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw financeError('Bank statement contains an invalid calendar date.');
  }
  return String(year).padStart(4, '0') + '-' + padded(month) + '-' + padded(day);
}

function amount(raw) {
  const text = String(raw ?? '').trim();
  if (!text || ['-', '--', 'null', 'nan'].includes(text.toLowerCase())) return '0.00';
  const clean = text.replace(/[,₹\s]/g, '');
  if (!/^\+?-?\d+(\.\d{1,2})?$/.test(clean)) throw financeError('Invalid money amount in the statement.');
  const negative = clean.startsWith('-');
  const value = clean.replace(/^[+-]/, '');
  const [whole, frac = ''] = value.split('.');
  if (whole.length > 10 || (whole.length === 10 && BigInt(whole) > 9999999999n)) throw financeError('Bank transaction exceeds the supported amount limit.');
  return (negative ? '-' : '') + String(BigInt(whole)) + '.' + frac.padEnd(2, '0');
}

function colMap(row) {
  const normalized = row.map(norm);
  const result = {};
  for (const [field, names] of Object.entries(aliases)) {
    const idx = normalized.findIndex((item) => names.includes(item));
    if (idx >= 0) result[field] = idx;
  }
  if (result.date === undefined || result.description === undefined ||
    (result.debit === undefined && result.credit === undefined && result.amount === undefined)) return null;
  return result;
}

export function parseBankCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_SIZE * 2) throw financeError('CSV is too large.');
  const grid = parseCsv(text);
  let headers, start = -1;
  for (let i = 0; i < Math.min(30, grid.length); i++) {
    headers = colMap(grid[i]);
    if (headers) { start = i; break; }
  }
  if (start === -1) throw financeError('Could not identify Date, Narration and Debit/Credit columns. Export CSV from your bank.');
  const get = (row, key) => headers[key] === undefined ? '' : String(row[headers[key]] ?? '').trim();
  const results = [];
  for (let i = start + 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row.some((cell) => String(cell ?? '').trim())) continue;
    if (!get(row, 'date')) continue;
    if (row.length > 50) throw financeError('Too many columns in statement.');
    const description = get(row, 'description').replace(/\s+/g, ' ').slice(0, 200);
    if (!description || ['total', 'openingbalance', 'closingbalance'].includes(norm(description))) continue;
    let debit = amount(get(row, 'debit'));
    let credit = amount(get(row, 'credit'));
    if (debit.startsWith('-') || credit.startsWith('-') || (debit !== '0.00' && credit !== '0.00')) {
      throw financeError('Invalid debit/credit columns on row ' + (i + 1) + '.');
    }
    if (debit === '0.00' && credit === '0.00' && headers.amount !== undefined) {
      const signed = amount(get(row, 'amount'));
      const direction = get(row, 'direction').toUpperCase();
      if (['CR', 'CREDIT', 'C'].includes(direction)) credit = signed.replace(/^-/, '');
      else if (['DR', 'DEBIT', 'D'].includes(direction)) debit = signed.replace(/^-/, '');
      else if (signed.startsWith('-')) debit = signed.slice(1);
      else if (signed !== '0.00') throw financeError('Unsigned amount without DR/CR on row ' + (i + 1) + '.');
    }
    if (debit === '0.00' && credit === '0.00') continue;
    results.push({
      date: isoDate(get(row, 'date')),
      description, amount: debit !== '0.00' ? debit : credit,
      transaction_type: debit !== '0.00' ? 'EXPENSE' : 'INCOME',
      reference: get(row, 'reference').slice(0, 100),
      balance: get(row, 'balance').slice(0, 40),
    });
    if (results.length > MAX_ROWS) throw financeError('Only 1,000 transactions are supported per upload.');
  }
  if (!results.length) throw financeError('No valid transactions found.');
  return results;
}

function category(description, type) {
  if (type === 'INCOME') return 'Income';
  const lower = description.toLowerCase();
  for (const [value, words] of categoryKeywords) if (words.some((word) => lower.includes(word))) return value;
  return 'Uncategorized';
}

async function digest(text) {
  if (!globalThis.crypto?.subtle) throw financeError('Secure HTTPS is required to import bank statements.');
  const data = new TextEncoder().encode(text);
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function accountAvailable(accounts, accountId) {
  const chosen = accounts.find((account) => String(account.id) === String(accountId));
  if (!chosen) throw financeError('Choose an account you own.');
  return chosen;
}

async function fingerprintRows(accountId, records) {
  const seen = new Map();
  const rows = [];
  for (const [index, r] of records.entries()) {
    const ref = norm(r.reference);
    const identifier = [accountId, r.date, r.transaction_type, r.amount, ref || norm(r.description),
      ref ? '' : norm(r.balance)].join('|');
    const occurrence = ref ? 0 : (seen.get(identifier) || 0);
    if (!ref) seen.set(identifier, occurrence + 1);
    rows.push({
      index, date:r.date, description:r.description, amount:r.amount,
      transaction_type:r.transaction_type, reference:r.reference,
      category:category(r.description,r.transaction_type),
      fingerprint:await digest(identifier+'|'+occurrence),
      status: transferWords.some((word) => r.description.toLowerCase().includes(word)) ? 'review_transfer' : 'ready',
    });
  }
  return rows;
}

export async function previewBankStatement(client, userId, body, accounts) {
  const file = body instanceof FormData ? body.get('file') : null;
  const accountId = body instanceof FormData ? body.get('account_id') : '';
  const account = accountAvailable(accounts, accountId);
  const filename = String(file?.name || '').toLowerCase();
  const mime = String(file?.type || '').toLowerCase();
  const isPdf = filename.endsWith('.pdf') || mime === 'application/pdf';
  const isCsv = filename.endsWith('.csv') || mime === 'text/csv';
  if (!(file instanceof Blob) || !file.size || file.size > MAX_SIZE ||
      (!isPdf && !isCsv)) {
    throw financeError('Choose a CSV or PDF bank statement up to 5 MB.');
  }
  const records = isPdf
    ? await (await import('./supabaseBankPdf.js')).parseBankPdf(file, String(body.get('pdf_password') || ''))
    : parseBankCsv(await file.text());
  const rows = await fingerprintRows(String(account.id), records);
  const found = new Set();
  const hashes = rows.map((row) => row.fingerprint);
  for (let i = 0; i < hashes.length; i += 50) {
    const matches = checked(await client.from('tracker_bank_imports').select('fingerprint')
      .eq('user_id', userId).eq('account',account.id).in('fingerprint',hashes.slice(i,i+50)));
    for (const match of matches) found.add(match.fingerprint);
  }
  const existing = await readAll(client,'expenses',userId);
  const similar = new Set(existing.filter((r) => String(r.account) === String(account.id))
    .map((r) => [r.date, r.transaction_type, String(r.amount), ''].join('|')));
  for (const row of rows) {
    if (found.has(row.fingerprint)) row.status = 'duplicate';
    else if (row.status === 'ready' && similar.has([row.date,row.transaction_type,row.amount,''].join('|'))) row.status = 'possible_match';
  }
  return {account:{id:account.id,name:account.name},rows,
    counts:Object.fromEntries(['ready','duplicate','possible_match','review_transfer'].map((s)=>[s,rows.filter((r)=>r.status===s).length])),
    warning:'Your statement is processed locally in your browser; this is not a live bank connection. Transfers and card bill payments require manual reconciliation.'};
}

export async function commitBankStatement(client,userId,body,accounts) {
  const preview = await previewBankStatement(client,userId,body,accounts);
  let selected, categories;
  try {selected=JSON.parse(body.get('selected_indices')||'[]');categories=JSON.parse(body.get('category_overrides')||'{}');}
  catch {throw financeError('Invalid import selection.');}
  if (!Array.isArray(selected)||!selected.length||selected.length>MAX_ROWS||
    selected.some((x)=>!Number.isSafeInteger(x)||x<0||x>=preview.rows.length)||
    new Set(selected).size!==selected.length || !categories || Array.isArray(categories)||typeof categories!=='object') {
    throw financeError('Choose valid statement rows to import.');
  }
  const allow = body.get('allow_possible_matches')==='true';
  const chosen = [];
  for (const index of selected) {
    const row = preview.rows[index];
    if (row.status === 'review_transfer') throw financeError('Transfers and card payments require manual reconciliation.');
    if (row.status === 'possible_match' && !allow) throw financeError('Confirm possible existing transactions before importing.');
    if (row.status === 'duplicate') continue;
    const categoryOverride = categories[index] ?? row.category;
    if (typeof categoryOverride !== 'string'||!categoryOverride.trim()||categoryOverride.length>100) throw financeError('Invalid category.');
    chosen.push({
      fingerprint:row.fingerprint,title:row.description,amount:row.amount,
      transaction_type:row.transaction_type,date:row.date,category:categoryOverride.trim(),
      payment_method:/upi/i.test(row.description)?'UPI':/card|pos|visa/i.test(row.description)?'CARD':'BANK_TRANSFER',
      confirmed_existing: row.status==='possible_match' && allow,
    });
  }
  if (!chosen.length) return {created:0,already_imported:selected.length};
  const result = checked(await client.rpc('tracker_import_bank_statement', {p_account:preview.account.id,p_rows:chosen}));
  return {created:result.created,already_imported:(result.already_imported||0)+(selected.length-chosen.length),
    message:'Transactions saved using Supabase ledger triggers. Review your account balances against the official bank statement.'};
}
