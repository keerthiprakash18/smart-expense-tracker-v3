// CSV parsing is local. The RPC validates and inserts the entire batch atomically.
export function parseCsv(text) {
  text = String(text).replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row);
      row = []; cell = ''; closed = false;
    } else {
      if (closed || c === '"') throw new Error('Malformed CSV quoting.');
      cell += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function importCsv(text, accounts) {
  const [header, ...rows] = parseCsv(text);
  if (!header || rows.length === 0 || rows.length > 1000) throw new Error('CSV must contain between 1 and 1000 transactions.');
  const keys = header.map((s) => s.trim().toLowerCase().replaceAll(' ', '_'));
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate CSV column names.');
  if (!keys.includes('amount') || !keys.includes('date')) throw new Error('CSV requires Date and Amount columns.');
  const names = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));
  const ids = new Set(accounts.map((a) => String(a.id)));
  return rows.map((cells, index) => {
    if (cells.length !== keys.length) throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const data = Object.fromEntries(keys.map((k, i) => [k, cells[i].trim()]));
    const account = data.account ? names.get(data.account.toLowerCase()) || (ids.has(data.account) ? data.account : null) : null;
    if (data.account && !account) throw new Error(`Unknown account on CSV row ${index + 2}.`);
    const amount = data.amount;
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error(`Invalid positive amount on CSV row ${index + 2}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`Use YYYY-MM-DD on CSV row ${index + 2}.`);
    return { title: data.title || 'Transaction', amount, account, date: data.date,
      transaction_type: (data.transaction_type || data.type || 'EXPENSE').toUpperCase(),
      category: data.category || 'General', payment_method: data.payment_method || 'UPI', notes: data.notes || '' };
  });
}

export function exportCsv(rows, accounts) {
  const names = new Map(accounts.map((a) => [String(a.id), a.name]));
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [['Date', 'Title', 'Type', 'Category', 'Account', 'Payment Method', 'Amount', 'Notes'],
    ...rows.map((r) => [r.date, r.title, r.transaction_type, r.category, names.get(String(r.account)) || '', r.payment_method, r.amount, r.notes])]
    .map((row) => row.map(cell).join(',')).join('\r\n');
}
