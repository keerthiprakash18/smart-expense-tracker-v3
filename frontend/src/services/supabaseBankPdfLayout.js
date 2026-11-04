import { financeError } from './supabaseFinance.js';
import { parseBankCsv } from './supabaseBankStatement.js';

// PDF.js commonly yields multiple text fragments per heading (e.g.
// "Withdrawal" + "Amt."), while some PDF generators yield an entire heading
// as one text item. Recognize both without depending on the customer's bank.
const aliases = {
  date: ['date','transactiondate','txndate','trandate','postingdate','transactiondt','txndt'],
  description: ['narration','description','particulars','remarks','details','transactiondetails',
    'transactiondescription','transactionparticulars','narrationdetails'],
  reference: ['reference','referenceno','referenceid','refno','refnumber','chequeno','chequenumber',
    'chqrefno','chqno','chqrefnumber','utr','utrno','transactionid','instrumentno'],
  valueDate: ['valuedt','valuedate','valuedtdate'],
  debit: ['debit','debitamt','debitamount','dr','dramt','dramount',
    'withdrawal','withdrawalamt','withdrawalamount','withdrawals','paidout'],
  credit: ['credit','creditamt','creditamount','cr','cramt','cramount',
    'deposit','depositamt','depositamount','deposits','paidin'],
  balance: ['balance','closingbalance','runningbalance','availablebalance','balanceamount'],
  amount: ['amount','transactionamount','transactionamt','txnamount','txnvalue'],
  direction: ['drcr','crdr','transactiontype','txntype','debitcredit','type'],
};

const norm = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dateToken = /(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;
const fullDate = new RegExp('^\\s*(' + dateToken.source + ')(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)?\\s*$');
const numericMoney = /^([+-]?(?:₹|Rs\.?|INR)?\s*[\d,]+(?:\.\d{1,2})?)\s*(DR|CR)?$/i;

function toIsoDate(value) {
  const match = fullDate.exec(String(value ?? ''));
  if (!match) return null;
  const token = match[1];
  let year, month, day;
  if (/^\d{4}-/.test(token)) [year, month, day] = token.split('-').map(Number);
  else {
    [day, month, year] = token.split(/[./-]/).map(Number);
    if (year < 100) year += year < 80 ? 2000 : 1900;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year < 1990 || year > 2100 || dt.getUTCFullYear() !== year ||
      dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw financeError('PDF contains an invalid transaction date.');
  }
  return [String(year).padStart(4,'0'),String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
}

function rowsByBaseline(items) {
  const buckets = new Map(), lines = [];
  for (const item of items) {
    if (!item || typeof item.str !== 'string' || !item.str.trim() ||
        !Number.isFinite(item.transform?.[4]) || !Number.isFinite(item.transform?.[5])) continue;
    const x = item.transform[4], y = item.transform[5];
    const bucket = Math.round(y / 2);
    let line;
    for (let offset = -1; offset <= 1; offset++) {
      line = (buckets.get(bucket + offset) || []).find((candidate) => Math.abs(candidate.y - y) <= 2);
      if (line) break;
    }
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(line);
    }
    line.items.push({x, text:item.str.trim(), width:Number(item.width) || 0});
  }
  return lines.sort((a,b)=>b.y-a.y).map(line=>line.items.sort((a,b)=>a.x-b.x));
}

function headingTokens(items) {
  const tokens = [];
  for (const item of items) {
    const text = item.text;
    const width = item.width > 0 ? item.width : text.length * 5;
    for (const match of text.matchAll(/\S+/g)) {
      tokens.push({text:match[0], x:item.x + width * match.index / Math.max(1,text.length)});
    }
  }
  return tokens;
}

function identifyHeader(items) {
  const tokens = headingTokens(items), fields = [];
  for (let i = 0; i < tokens.length; i++) {
    let candidate = null;
    // Match a full field label before its parts: "Withdrawal Amt.", "Chq./Ref.No."
    for (let size = Math.min(4, tokens.length - i); size >= 1; size--) {
      const joined = norm(tokens.slice(i,i+size).map(x=>x.text).join(''));
      const field = Object.keys(aliases).find(key=>aliases[key].includes(joined));
      if (field) { candidate = { field, size, x:tokens[i].x }; break; }
    }
    if (!candidate) continue;
    // "Value Date" is not the transaction date: keep it as its own column.
    if (!fields.some(f=>f.field===candidate.field)) fields.push({field:candidate.field,x:candidate.x});
    i += candidate.size - 1;
  }
  const present = new Set(fields.map(f=>f.field));
  if (!present.has('date') || !present.has('description')) return null;
  if (!(present.has('debit') && present.has('credit')) &&
      !(present.has('amount') && present.has('direction'))) return null;
  fields.sort((a,b)=>a.x-b.x);
  if (fields.length < 4 || fields.some((field,i)=>i && field.x <= fields[i-1].x)) return null;
  return fields;
}

function mapCells(items,header) {
  const values = Object.fromEntries(header.map(h=>[h.field,'']));
  const boundaries = header.slice(1).map((h,i)=>(h.x + header[i].x)/2);
  for (const item of items) {
    const col = boundaries.findIndex(limit=>item.x < limit);
    const field = header[col < 0 ? header.length - 1 : col].field;
    values[field] = (values[field] ? values[field] + ' ' : '') + item.text;
  }
  return values;
}

function isSummaryRow(value) {
  return /^(?:opening|closing|available|total|statement summary|page\s+\d+|generated|end of statement|balance brought forward)\b/i.test(String(value||'').trim());
}

function parseTransactionValues(values) {
  const iso = toIsoDate(values.date);
  if (!iso) return null;
  const description = String(values.description||'').replace(/\s+/g,' ').trim();
  if (isSummaryRow(description)) return null;
  if (!description) throw financeError('PDF has a transaction date but no narration; export a CSV for this layout.');

  const debit = String(values.debit||'').trim();
  const credit = String(values.credit||'').trim();
  const amount = String(values.amount||'').trim();
  if (!debit && !credit && !amount)
    throw financeError('PDF has a dated row without an amount. Use a bank-exported CSV for this layout.');

  const result = {...values, date:iso, description};
  // Amount + explicit DR/CR column, or direction suffixed directly to amount.
  if (amount) {
    const amountMatch = numericMoney.exec(amount);
    if (!amountMatch) throw financeError('PDF contains a transaction amount that cannot be read safely.');
    const suffix = amountMatch[2]?.toUpperCase();
    const columnDirection = String(values.direction||'').trim().toUpperCase();
    if (suffix && columnDirection && suffix !== columnDirection)
      throw financeError('PDF has conflicting debit/credit indicators.');
    result.amount = amountMatch[1].replace(/^(?:Rs\.?|INR)\s*/i,'').replace(/^₹\s*/,'');
    result.direction = suffix || columnDirection;
  }
  return result;
}

function csvCell(value) {
  return '"' + String(value ?? '').replaceAll('"','""') + '"';
}
function convertToCsv(records) {
  if (!records.length)
    throw financeError('No structured bank transactions found in this PDF. Its table layout may be different; use a bank-exported CSV or share a redacted sample layout.');
  if (records.length > 1000) throw financeError('Only 1,000 transactions are supported per statement.');
  const csv = [
    ['Date','Narration','Debit','Credit','Amount','DrCr','Closing Balance','Reference'],
    ...records.map(r=>[r.date,r.description,r.debit,r.credit,r.amount,r.direction,r.balance,r.reference]),
  ].map(row=>row.map(csvCell).join(',')).join('\n');
  return parseBankCsv(csv);
}

// For statement PDFs that use individual labelled transaction blocks instead
// of a grid. Require an explicit Transaction Date and an explicit Debit/Credit
// marker before accepting anything. Account metadata must never become expenses.
function parseLabelledBlocks(linesByPage) {
  const records = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (current.date && current.description && (current.debit || current.credit ||
        (current.amount && current.direction))) records.push(parseTransactionValues(current));
    current = null;
  };
  for (const lines of linesByPage) {
    for (const line of lines) {
      const text = line.map(x=>x.text).join(' ').replace(/\s+/g,' ').trim();
      const date = /^(?:transaction|txn|tran)\s+(?:date|dt)\s*[:\-]\s*(.+)$/i.exec(text);
      if (date) {
        flush();
        current = {date:date[1],description:'',debit:'',credit:''};
        continue;
      }
      if (!current) continue;
      const match = /^(narration|description|particulars|details|debit(?:\s+amount)?|credit(?:\s+amount)?|withdrawal(?:\s+amt)?|deposit(?:\s+amt)?|amount|dr\/cr|transaction type|balance)\s*[:\-]\s*(.+)$/i.exec(text);
      if (!match) continue;
      const key = norm(match[1]), value=match[2].trim();
      if (['narration','description','particulars','details'].includes(key)) current.description=value;
      else if (['debit','debitamount','withdrawal','withdrawalamt'].includes(key)) current.debit=value;
      else if (['credit','creditamount','deposit','depositamt'].includes(key)) current.credit=value;
      else if (key==='amount') current.amount=value;
      else if (key==='drcr'||key==='transactiontype') current.direction=value;
      else if (key==='balance') current.balance=value;
    }
  }
  flush();
  return records;
}

// The only committed financial data is the user's reviewed, confirmed rows.
// No loose OCR guessing or balance-based inference here.
export function parsePdfBankItems(pages) {
  const linesByPage = pages.map(rowsByBaseline);
  let header = null, pending = null;
  const records = [];
  const flush = () => {
    if (!pending) return;
    const processed = parseTransactionValues(pending);
    if (processed) records.push(processed);
    pending = null;
  };
  for (const lines of linesByPage) {
    for (const line of lines) {
      const foundHeader = identifyHeader(line);
      if (foundHeader) {
        flush();
        header = foundHeader;
        continue;
      }
      if (!header) continue;
      const values = mapCells(line,header);
      if (isSummaryRow(values.description)) {
        flush();
        header = null;
        continue;
      }
      const date = toIsoDate(values.date);
      if (date) {
        flush();
        pending = {...values,date};
      } else if (pending && !String(values.date||'').trim() &&
          String(values.description||'').trim() &&
          !String(values.debit||'').trim() && !String(values.credit||'').trim() &&
          !String(values.amount||'').trim()) {
        // Wrapped descriptions are part of the same transaction, not a new debit.
        pending.description = (String(pending.description||'')+' '+values.description).trim().slice(0,200);
      }
    }
  }
  flush();
  if (!records.length) return convertToCsv(parseLabelledBlocks(linesByPage));
  return convertToCsv(records);
}
