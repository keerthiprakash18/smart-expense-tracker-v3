import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankCsv, previewBankStatement, commitBankStatement } from '../src/services/supabaseBankStatement.js';

const CSV = [
  'Bank Name,Sample Bank',
  'Date,Narration,Withdrawal Amt,Deposit Amt,Closing Balance,Reference No',
  '04/11/2026,SWIGGY UPI,350.00,,650.00,TXN-101',
  '05/11/2026,NEFT SALARY,,25000.00,25650.00,TXN-102',
  '06/11/2026,SELF TRANSFER,500.00,,25150.00,TXN-103',
].join('\n');

test('reads Indian DD/MM/YYYY CSV bank debits and credits without importing', () => {
  const rows = parseBankCsv(CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => [r.date, r.transaction_type, r.amount]),
    [['2026-11-04','EXPENSE','350.00'],['2026-11-05','INCOME','25000.00'],['2026-11-06','EXPENSE','500.00']]);
});

test('rejects unsigned amount without DR/CR and malformed dates instead of guessing', () => {
  assert.throws(() => parseBankCsv('Date,Narration,Amount\n2026-11-04,Food,120.00'), /Unsigned amount/);
  assert.throws(() => parseBankCsv('Date,Narration,Debit\n31\/02\/2026,Food,120.00'), /invalid calendar/);
});

function mockClient({ imported = [], existing = [] } = {}) {
  const calls = [];
  function table(name) {
    const query = {
      select() { return this; },
      eq() { return this; },
      in() { return this; },
      order() { return this; },
      limit() { return this; },
      gt() { return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: name === 'tracker_bank_imports' ? imported.map(fingerprint => ({fingerprint})) : existing, error: null }).then(resolve, reject);
      },
    };
    return query;
  }
  return {
    calls,
    client: {
      from: table,
      rpc: async (name, payload) => { calls.push({ name, payload }); return { data: {created:payload.p_rows.length,already_imported:0},error:null }; },
    },
  };
}

function payload(indices = [], approve = false) {
  const form = new FormData();
  form.append('file', new File([CSV], 'synthetic-bank.csv', { type:'text/csv' }));
  form.append('account_id','12');
  form.append('selected_indices',JSON.stringify(indices));
  form.append('category_overrides','{}');
  form.append('allow_possible_matches',String(approve));
  return form;
}
const accounts = [{id:12,name:'Sample Bank',account_type:'BANK'}];

test('preview flags transfer and produces stable SHA-256 fingerprints', async () => {
  const {client} = mockClient();
  const form = payload();
  const first = await previewBankStatement(client,'user-1',form,accounts);
  const second = await previewBankStatement(client,'user-1',form,accounts);
  assert.equal(first.rows[0].category,'Food & Dining');
  assert.equal(first.rows[2].status,'review_transfer');
  assert.match(first.rows[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(first.rows[0].fingerprint,second.rows[0].fingerprint);
});

test('commit sends only selected safe entries to atomic RPC', async () => {
  const {client,calls} = mockClient();
  const result = await commitBankStatement(client,'user-1',payload([0,1]),accounts);
  assert.equal(result.created,2);
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'tracker_import_bank_statement');
  assert.equal(calls[0].payload.p_rows[0].category,'Food & Dining');
  assert.equal(calls[0].payload.p_rows[0].confirmed_existing,false);
  assert.equal(calls[0].payload.p_rows[1].transaction_type,'INCOME');
});

test('does not submit transfers or duplicates', async () => {
  const {client,calls} = mockClient();
  await assert.rejects(commitBankStatement(client,'user-1',payload([2]),accounts), /Transfers/);
  assert.equal(calls.length,0);
  const preview = await previewBankStatement(client,'user-1',payload(),accounts);
  const second = mockClient({imported:[preview.rows[0].fingerprint]});
  const response = await commitBankStatement(second.client,'user-1',payload([0]),accounts);
  assert.equal(response.created,0);
  assert.equal(second.calls.length,0);
});

test('checks existing manual matches before import and requires user confirmation', async () => {
  const existing = [{id:1,account:12,date:'2026-11-04',amount:'350.00',transaction_type:'EXPENSE'}];
  const {client,calls} = mockClient({existing});
  const preview = await previewBankStatement(client,'user-1',payload(),accounts);
  assert.equal(preview.rows[0].status,'possible_match');
  await assert.rejects(commitBankStatement(client,'user-1',payload([0]),accounts),/Confirm possible/);
  assert.equal(calls.length,0);
  const result = await commitBankStatement(client,'user-1',payload([0],true),accounts);
  assert.equal(result.created,1);
  assert.equal(calls[0].payload.p_rows[0].confirmed_existing,true);
});
