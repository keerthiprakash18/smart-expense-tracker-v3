import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFinanceHandler, filterLedger, paginate, readAll, writePayload } from '../src/services/supabaseFinance.js';
import { exportCsv, importCsv, parseCsv } from '../src/services/trackerCsv.js';
import { prediction, train, learningResponse } from '../src/services/trackerLearning.js';

test('write fields are allowlisted and identity/counter overrides fail', () => {
  assert.deepEqual(writePayload('expenses', { title: 'Lunch', amount: '12.50', is_recurring: 'false', account: '', arbitrary: true }), { title: 'Lunch', amount: '12.50', is_recurring: false, account: null });
  for (const key of ['user_id', 'id', 'status', 'created_at']) assert.throws(() => writePayload('expenses', { [key]: 1 }));
  assert.throws(() => writePayload('accounts', { balance: 100 }, true));
  assert.throws(() => writePayload('bills', { is_paid: 'not-a-boolean' }));
});
test('ledger search covers account names, stable IDs and filters without injecting PostgREST syntax', () => {
  const rows = [{ id: 1, title: 'Lunch', category: 'Food', account: 7, amount: 10, date: '2026-10-25', transaction_type: 'EXPENSE' }, { id: 2, title: 'Salary', account: 7, amount: 100, date: '2026-10-25', transaction_type: 'INCOME' }];
  assert.deepEqual(filterLedger(rows, new URLSearchParams('search=Primary&transaction_type=expense'), [{ id: 7, name: 'Primary Bank' }]).map((r) => r.id), [1]);
  assert.equal(filterLedger(rows, new URLSearchParams('search=%22%2Cor%28true%29')).length, 0);
  assert.deepEqual(filterLedger(rows, new URLSearchParams()).map((r) => r.id), [2, 1]);
  assert.equal(paginate(rows, new URLSearchParams('page_size=1&page=2')).results[0].id, 2);
});
test('readAll uses explicit owner and keyset pagination beyond first 1000 rows', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: i + 1 }));
  const scopes = [];
  const client = { from(name) { assert.equal(name, 'tracker_expenses'); let after = 0; return {
    select() { return this; }, eq(k, v) { scopes.push([k, v]); return this; }, order() { return this; }, limit() { return this; }, gt(k, v) { assert.equal(k, 'id'); after = v; return this; },
    // oxlint-disable-next-line unicorn/no-thenable -- Models the PostgREST builder's real awaitable API.
    then(resolve) { return Promise.resolve({ data: rows.filter((r) => r.id > after).slice(0, 500) }).then(resolve); },
  }; } };
  assert.equal((await readAll(client, 'expenses', 'owner')).length, 1001);
  assert.deepEqual(scopes, Array(3).fill(['user_id', 'owner']));
});
test('finance summary uses SQL aggregates and cannot call an arbitrary endpoint', async () => {
  const calls = [];
  const client = { auth: { getUser: async () => ({ data: { user: { id: 'owner' } } }) }, rpc: async (name) => { calls.push(name); return { data: { dashboard: { count: 1234 } } }; } };
  const handler = createFinanceHandler(client);
  assert.equal((await handler('GET', '/api/dashboard/')).data.count, 1234);
  assert.deepEqual(calls, ['tracker_summary']);
  await assert.rejects(handler('POST', '/api/unknown/', {}), /not available/);
});
test('CSV roundtrip handles quotes, linebreaks, BOM, account identity and rejects invalid batches before RPC', () => {
  const accounts = [{ id: 4, name: 'Cash' }];
  const csv = exportCsv([{ date: '2026-10-25', title: 'Coffee, "large"', transaction_type: 'EXPENSE', category: 'Food', account: 4, payment_method: 'Cash', amount: '12.50', notes: 'one\ntwo' }], accounts);
  const [row] = importCsv('\uFEFF' + csv, accounts);
  assert.equal(row.title, 'Coffee, "large"'); assert.equal(row.account, 4); assert.equal(row.notes, 'one\ntwo');
  assert.throws(() => parseCsv('a,"unclosed'), /Unclosed/);
  assert.throws(() => importCsv('Date,Amount,Account\n2026-10-25,10,Foreign', accounts), /Unknown account/);
  assert.throws(() => importCsv('Date,Amount\n2026-10-25,-10', accounts), /Invalid positive/);
  assert.match(exportCsv([{ title: '=1+1', notes: ' @cmd' }], []), /'=1\+1/);
});
test('per-user learning never invents categories without history and learns saved merchant labels', () => {
  assert.equal(prediction(train([]), { title: 'Coffee' }).category, null);
  const rows = [{ title: 'Coffee Shop', category: 'Food', amount: '20', date: '2026-10-01', transaction_type: 'EXPENSE' }];
  assert.equal(prediction(train(rows), { title: 'Coffee Shop' }).category, 'Food');
  assert.equal(prediction(train(rows), { title: 'Unknown' }).category, null);
  assert.equal(learningResponse('v3/ai/status', 'GET', {}, rows, []).training_samples, 1);
});
