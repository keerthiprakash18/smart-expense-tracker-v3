import { financeError } from './supabaseFinance.js';
import { parseBankCsv } from './supabaseBankStatement.js';

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

