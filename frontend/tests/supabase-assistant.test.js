import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSupabaseAssistant, serializeAssistantCommand } from '../src/services/supabaseAssistant.js';

const REQUEST = '10000000-0000-0000-0000-000000000001';
const PROFILE = { assistant_name: 'Nova', language: 'AUTO', voice_responses: true, personality: 'FRIENDLY', confirmation_mode: 'SMART', quick_add: false, background_wake_enabled: false };
function clientFixture({ tables = {}, rpc = [], user = { id: 'user-1' } } = {}) {
  const calls = [];
  class Query {
    constructor(table) { this.table = table; calls.push(['from', table]); }
    select(...args) { calls.push(['select', ...args]); return this; }
    insert(...args) { calls.push(['insert', ...args]); return this; }
    update(...args) { calls.push(['update', ...args]); return this; }
    delete(...args) { calls.push(['delete', ...args]); return this; }
    eq(...args) { calls.push(['eq', ...args]); return this; }
    in(...args) { calls.push(['in', ...args]); return this; }
    gte(...args) { calls.push(['gte', ...args]); return this; }
    order(...args) { calls.push(['order', ...args]); return this; }
    limit(...args) { calls.push(['limit', ...args]); return this; }
    range(...args) { calls.push(['range', ...args]); return this; }
    resolve() {
      const result = tables[this.table]?.shift();
      assert.notEqual(result, undefined, `Unexpected query for ${this.table}`);
      return Promise.resolve(result.error ? result : { data: result, error: null });
    }
    single() { return this.resolve(); }
    maybeSingle() { return this.resolve(); }
    // Supabase's query builder is intentionally awaitable; match that interface.
    // oxlint-disable-next-line unicorn/no-thenable
    then(fulfilled, rejected) { return this.resolve().then(fulfilled, rejected); }
  }
  return {
    calls,
    auth: { getUser: async () => { calls.push(['getUser']); return { data: { user }, error: null }; } },
    from: (table) => new Query(table),
    rpc: async (name, args) => {
      calls.push(['rpc', name, args]);
      const result = rpc.shift();
      assert.notEqual(result, undefined, `Unexpected RPC ${name}`);
      return result.error ? result : { data: result, error: null };
    },
  };
}
const rejection = (status, code) => (error) => error.response?.status === status && (!code || error.response.data.code === code);

test('unrelated routes return null without network access', async () => {
  const client = clientFixture();
  assert.equal(await handleSupabaseAssistant(client, 'GET', '/api/accounts/'), null);
  assert.equal(client.calls.length, 0);
});
test('unknown assistant routes do not fall through to legacy backend', async () => {
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'GET', '/api/v3/assistant/unknown/'), rejection(404));
});
test('deleted or missing user fails before finance queries', async () => {
  const client = clientFixture({ user: null });
  await assert.rejects(handleSupabaseAssistant(client, 'GET', '/api/v3/assistant/history/'), rejection(401));
  assert.deepEqual(client.calls, [['getUser']]);
});
test('settings retain UI contract and clearly disable unsupported background wake', async () => {
  const client = clientFixture({ tables: { tracker_assistant_profiles: [{ ...PROFILE, background_wake_enabled: true }] } });
  const result = await handleSupabaseAssistant(client, 'get', '/api/v3/assistant/settings');
  assert.equal(result.data.wake_phrase, 'Hey Nova');
  assert.equal(result.data.background_wake_enabled, false);
  assert.equal(result.data.capabilities.background_wake, false);
});
test('settings preferences update through owned row only', async () => {
  const client = clientFixture({ tables: { tracker_assistant_profiles: [PROFILE, { ...PROFILE, language: 'TA', quick_add: true }] } });
  const result = await handleSupabaseAssistant(client, 'PATCH', '/api/v3/assistant/settings/', { language: 'ta', quick_add: true });
  assert.equal(result.data.language, 'TA');
  assert.ok(client.calls.some((call) => call[0] === 'eq' && call[1] === 'user_id' && call[2] === 'user-1'));
});
test('settings reject markup and non-boolean preference values', async () => {
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'PATCH', '/api/v3/assistant/settings/', { assistant_name: '<script>' }), rejection(400));
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'PATCH', '/api/v3/assistant/settings/', { quick_add: 'true' }), rejection(400));
});
for (const route of ['wake-token', 'wake/message', 'wake/commands/1/confirm']) {
  test(`background endpoint ${route} fails explicitly without using any service`, async () => {
    const client = clientFixture();
    await assert.rejects(handleSupabaseAssistant(client, 'POST', `/api/v3/assistant/${route}/`, {}), rejection(501, 'background_wake_unavailable'));
    assert.equal(client.calls.length, 0);
  });
}
test('enabling background wake is refused before writing settings', async () => {
  const client = clientFixture();
  await assert.rejects(handleSupabaseAssistant(client, 'PATCH', '/api/v3/assistant/settings/', { background_wake_enabled: true }), rejection(501));
  assert.equal(client.calls.filter((call) => call[0] === 'from').length, 0);
});
test('message routes local Tanglish parse into atomic prepare RPC', async () => {
  const command = { id: 7, intent: 'CREATE_EXPENSE', status: 'PENDING', message: 'Confirm', payload: { amount: '500.00' } };
  const client = clientFixture({ tables: { tracker_categories: [[]], tracker_assistant_commands: [[]] }, rpc: [{ command, created: true }] });
  const result = await handleSupabaseAssistant(client, 'POST', '/api/v3/assistant/message/', { message: 'Petrol ku 500 spend panniten', client_request_id: REQUEST, source: 'VOICE_APP' });
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, command);
  const args = client.calls.find((call) => call[0] === 'rpc')[2];
  assert.equal(args.p_request_id, REQUEST);
  assert.equal(args.p_intent, 'CREATE_EXPENSE');
  assert.equal(args.p_payload.category, 'Transport');
  assert.equal(args.p_payload.amount, '500.00');
  assert.equal(args.p_source, 'VOICE_APP');
  assert.equal(Object.hasOwn(args.p_payload, 'user_id'), false);
});
test('idempotent RPC result maps to HTTP 200 rather than a second creation', async () => {
  const client = clientFixture({ tables: { tracker_categories: [[]], tracker_assistant_commands: [[]] }, rpc: [{ command: { id: 7, status: 'COMPLETED' }, created: false }] });
  assert.equal((await handleSupabaseAssistant(client, 'POST', '/api/v3/assistant/message/', { message: 'Coffee 100', client_request_id: REQUEST })).status, 200);
});
test('message validation rejects UUID and source overrides before staging', async () => {
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'POST', '/api/v3/assistant/message/', { message: 'Coffee 100', client_request_id: 'bad' }), rejection(400));
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'POST', '/api/v3/assistant/message/', { message: 'Coffee 100', user_id: 'other' }), rejection(400));
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'POST', '/api/v3/assistant/message/', { message: 'Coffee 100', source: 'VOICE_WAKE' }), rejection(501));
});
test('confirm and cancel pass only the command ID to SQL', async () => {
  for (const action of ['confirm', 'cancel']) {
    const client = clientFixture({ rpc: [{ id: 7, status: action === 'confirm' ? 'COMPLETED' : 'CANCELLED' }] });
    await handleSupabaseAssistant(client, 'POST', `/api/v3/assistant/commands/7/${action}/`, {});
    assert.deepEqual(client.calls.at(-1), ['rpc', `tracker_assistant_${action}`, { p_command: '7' }]);
  }
});
test('failed SQL confirmation surfaces saved command and a useful UI error', async () => {
  const client = clientFixture({ rpc: [{ id: 7, status: 'FAILED', message: 'Selected account no longer exists.' }] });
  await assert.rejects(handleSupabaseAssistant(client, 'POST', '/api/v3/assistant/commands/7/confirm/', {}), (error) => error.response.status === 400 && error.response.data.command.status === 'FAILED');
});
test('MFA and foreign command SQL failures preserve 403 and 404 status', async () => {
  for (const [code, status] of [['42501', 403], ['P0002', 404], ['55000', 409]]) {
    const client = clientFixture({ rpc: [{ error: { code, message: 'Denied' } }] });
    await assert.rejects(handleSupabaseAssistant(client, 'POST', '/api/v3/assistant/commands/7/confirm/', {}), rejection(status));
  }
});
test('history serializes database columns into Assistant.jsx command shape', async () => {
  const row = { id: 4, intent: 'CREATE_NOTE', status: 'COMPLETED', confidence: '0.990', response_text: 'Saved', safe_payload: { note_content: 'Milk' }, result_payload: { note: 'Milk', note_id: 3 } };
  const client = clientFixture({ tables: { tracker_assistant_commands: [[row]] } });
  const result = await handleSupabaseAssistant(client, 'GET', '/api/v3/assistant/history/');
  assert.deepEqual(result.data.results[0], serializeAssistantCommand(row));
  assert.equal(result.data.results[0].message, 'Saved');
});
test('notes support create, read, update and delete with owned detail filters', async () => {
  const note = { id: 9, content: 'Milk', source: 'TEXT', is_done: false };
  const client = clientFixture({ tables: { tracker_assistant_notes: [note, note, { ...note, is_done: true }, note] } });
  assert.equal((await handleSupabaseAssistant(client, 'POST', '/api/v3/assistant/notes/', { content: ' Milk ' })).status, 201);
  assert.equal((await handleSupabaseAssistant(client, 'GET', '/api/v3/assistant/notes/9/')).data.content, 'Milk');
  assert.equal((await handleSupabaseAssistant(client, 'PATCH', '/api/v3/assistant/notes/9/', { is_done: true })).data.is_done, true);
  assert.equal((await handleSupabaseAssistant(client, 'DELETE', '/api/v3/assistant/notes/9/')).status, 204);
  assert.equal(client.calls.filter((call) => call[0] === 'eq' && call[1] === 'user_id').length, 3);
});
test('notes reject ownership and timestamp injection', async () => {
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'POST', '/api/v3/assistant/notes/', { content: 'Milk', user_id: 'other' }), rejection(400));
  await assert.rejects(handleSupabaseAssistant(clientFixture(), 'PATCH', '/api/v3/assistant/notes/1/', { created_at: '2000-01-01' }), rejection(400));
});
