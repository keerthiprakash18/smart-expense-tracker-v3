import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeleteAccountHandler } from '../functions/delete-account/handler.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 25);
const user = { id: USER_ID, email: 'person@example.com', factors: [] };
const config = { url: 'https://offline.example', publicKey: 'sb_publishable_offline_test', serviceRoleKey: 'server-only-test-key', allowedOrigins: ['https://frontend.example'] };
const ok = (data) => ({ data, error: null });
const failed = (message = 'SDK failure containing server-only-test-key') => ({ data: null, error: new Error(message) });
function jwt(claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ sub: USER_ID, role: 'authenticated', aal: 'aal1', exp: NOW / 1000 + 3600, ...claims })}.test-signature`;
}
function request({ token = jwt(), origin = 'https://frontend.example', body = { password: 'CurrentPassword1', confirmation: 'DELETE' }, method = 'POST', headers = {} } = {}) {
  return new Request('https://offline.example/functions/v1/delete-account', { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

function fixture(options = {}) {
  const calls = [];
  const files = new Set(options.files || [`${USER_ID}/receipt.pdf`, `${USER_ID}/2026/photo.png`, `${OTHER_ID}/private.pdf`]);
  let authCalls = 0;
  let removed = false;
  const record = (name, fn) => async (...args) => { calls.push([name, ...structuredClone(args)]); return fn(...args); };
  const caller = { auth: { getUser: record('getUser', () => {
    authCalls++;
    if (options.invalidJwt || (options.revokeOnRecheck && authCalls > 1)) return failed();
    return ok({ user: options.user || (options.enrollOnRecheck && authCalls > 1 ? { ...user, factors: [{ status: 'verified' }] } : user) });
  }) } };
  const verifier = { auth: {
    signInWithPassword: record('verifyPassword', () => options.wrongPassword ? failed() : ok({ user: options.passwordUser || user, session: { access_token: 'isolated-session' } })),
    signOut: record('verifierSignOut', () => options.verifierSignOutFails ? failed() : { error: null }),
  } };
  const storage = {
    list: record('list', (prefix, { limit, offset }) => {
      if (options.listFails) return failed();
      if (options.injectEntries) return ok(offset ? [] : options.injectEntries);
      const children = new Map();
      for (const path of files) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const suffix = path.slice(prefix.length + 1);
        const name = suffix.split('/')[0];
        children.set(name, suffix.includes('/') ? { name, id: null, metadata: null } : { name, id: `id-${path}`, metadata: {} });
      }
      return ok([...children.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit));
    }),
    remove: record('remove', (paths) => {
      if (options.removeFails) return failed();
      for (const path of paths) files.delete(path);
      removed = true;
      if (options.concurrentUpload) files.add(`${USER_ID}/concurrent.pdf`);
      return ok([]);
    }),
  };
  const admin = {
    auth: { admin: { deleteUser: record('deleteUser', (id) => options.deleteFails ? failed() : ok({ user: { id } })) } },
    storage: {
      getBucket: record('getBucket', () => options.bucketFails ? failed() : ok({ id: 'tracker-receipts', public: options.publicBucket || false, ...(options.versioning ? { versioning_status: options.versioning } : {}) })),
      from: (name) => { calls.push(['from', name]); return storage; },
    },
  };
  let publicClients = 0;
  const createClient = (url, key, clientOptions) => {
    calls.push(['createClient', url, key, structuredClone(clientOptions)]);
    if (key === config.serviceRoleKey) return admin;
    return ++publicClients === 1 ? caller : verifier;
  };
  const handler = createDeleteAccountHandler({ config: { ...config, ...options.config }, createClient, now: options.now || (() => NOW) });
  return { handler, calls, files, removed: () => removed };
}

test('successful deletion verifies JWT/password with isolated clients, deletes only caller folder, then caller Auth user', async () => {
  const { handler, calls, files } = fixture();
  const result = await handler(request());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { deleted: true, message: 'Account and app records deleted.', receipts_removed: 2 });
  assert.deepEqual([...files], [`${OTHER_ID}/private.pdf`]);
  assert.deepEqual(calls.filter(([name]) => name === 'deleteUser'), [['deleteUser', USER_ID, false]]);
  assert.deepEqual(calls.find(([name]) => name === 'verifyPassword'), ['verifyPassword', { email: user.email, password: 'CurrentPassword1' }]);
  const clients = calls.filter(([name]) => name === 'createClient');
  assert.deepEqual(clients.map(([, , key]) => key), [config.publicKey, config.publicKey, config.serviceRoleKey]);
  for (const [, , , clientOptions] of clients) assert.deepEqual(clientOptions, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  assert.ok(calls.indexOf(calls.find(([name]) => name === 'verifierSignOut')) < calls.indexOf(calls.find(([name]) => name === 'getBucket')));
  for (const [, prefix] of calls.filter(([name]) => name === 'list')) assert.ok(prefix === USER_ID || prefix.startsWith(`${USER_ID}/`));
  for (const [, paths] of calls.filter(([name]) => name === 'remove')) assert.ok(paths.every((path) => path.startsWith(`${USER_ID}/`)));
});

test('missing or rejected JWT never creates an admin client or performs deletion', async () => {
  const missing = fixture();
  assert.equal((await missing.handler(request({ token: null }))).status, 401);
  assert.equal(missing.calls.length, 0);
  const invalid = fixture({ invalidJwt: true });
  assert.equal((await invalid.handler(request())).status, 401);
  assert.equal(invalid.calls.some(([name]) => ['verifyPassword', 'getBucket', 'deleteUser'].includes(name)), false);
});

test('forged sub, expired JWT, service-role and malformed claims fail even if the mocked getUser returns a user', async () => {
  for (const token of [jwt({ sub: OTHER_ID }), jwt({ exp: NOW / 1000 - 1 }), jwt({ role: 'service_role' }), jwt({ aal: null }), 'malformed.token']) {
    const { handler, calls } = fixture();
    assert.equal((await handler(request({ token }))).status, 401);
    assert.equal(calls.some(([name]) => name === 'verifyPassword'), false);
  }
});

test('request cannot choose another user, bucket or prefix', async () => {
  for (const extra of [{ user_id: OTHER_ID }, { bucket: 'other-bucket' }, { prefix: OTHER_ID }]) {
    const { handler, calls } = fixture();
    const result = await handler(request({ body: { password: 'CurrentPassword1', confirmation: 'DELETE', ...extra } }));
    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  }
});

test('verified MFA requires AAL2 before password verification; unverified setup does not', async () => {
  const enabled = fixture({ user: { ...user, factors: [{ status: 'verified', factor_type: 'totp' }] } });
  const result = await enabled.handler(request());
  assert.equal(result.status, 403);
  assert.equal((await result.json()).code, 'mfa_required');
  assert.equal(enabled.calls.some(([name]) => name === 'verifyPassword'), false);
  const verified = fixture({ user: { ...user, factors: [{ status: 'verified', factor_type: 'phone' }] } });
  assert.equal((await verified.handler(request({ token: jwt({ aal: 'aal2' }) }))).status, 200);
  const pending = fixture({ user: { ...user, factors: [{ status: 'unverified' }] } });
  assert.equal((await pending.handler(request())).status, 200);
});

test('incorrect password, account identity mismatch and verifier session cleanup failure prevent all privileged work', async () => {
  for (const option of [{ wrongPassword: true }, { passwordUser: { ...user, id: OTHER_ID } }, { verifierSignOutFails: true }]) {
    const { handler, calls } = fixture(option);
    assert.ok([403, 503].includes((await handler(request())).status));
    assert.equal(calls.some(([name]) => ['getBucket', 'remove', 'deleteUser'].includes(name)), false);
    assert.equal(calls.some(([name, , key]) => name === 'createClient' && key === config.serviceRoleKey), false);
  }
});

test('session revocation or MFA enrollment during password verification is checked before admin client creation', async () => {
  for (const option of [{ revokeOnRecheck: true }, { enrollOnRecheck: true }]) {
    const { handler, calls } = fixture(option);
    assert.ok([401, 403].includes((await handler(request())).status));
    assert.equal(calls.some(([name]) => name === 'getBucket'), false);
  }
});

test('only the private unversioned tracker-receipts bucket is eligible', async () => {
  for (const option of [{ bucketFails: true }, { publicBucket: true }, { versioning: 'ENABLED' }, { versioning: 'SUSPENDED' }]) {
    const { handler, calls } = fixture(option);
    assert.ok([409, 503].includes((await handler(request())).status));
    assert.equal(calls.some(([name]) => ['list', 'remove', 'deleteUser'].includes(name)), false);
  }
});

test('receipt listing or deletion failure stops Auth deletion and does not leak SDK errors or keys', async () => {
  for (const option of [{ listFails: true }, { removeFails: true }, { deleteFails: true }]) {
    const { handler, calls } = fixture(option);
    const result = await handler(request());
    assert.equal(result.status, 503);
    const text = await result.text();
    assert.equal(text.includes(config.serviceRoleKey), false);
    assert.equal(text.includes('CurrentPassword1'), false);
    if (!option.deleteFails) assert.equal(calls.some(([name]) => name === 'deleteUser'), false);
    if (option.removeFails) assert.equal(JSON.parse(text).receipts_may_have_been_removed, true);
  }
});

test('unsafe folder/file names cannot escape caller scope and fail before any removal', async () => {
  for (const name of ['../other.pdf', '..', '.', '/root.pdf', 'nested\\file.pdf', '%2e%2e', '%252fother', `file\u0000.pdf`]) {
    const { handler, calls } = fixture({ injectEntries: [{ id: 'file', name, metadata: {} }] });
    assert.equal((await handler(request())).status, 409);
    assert.equal(calls.some(([operation]) => ['remove', 'deleteUser'].includes(operation)), false);
  }
});

test('cleanup preflight refuses more than 1000 files without partial deletion', async () => {
  const { handler, calls } = fixture({ files: Array.from({ length: 1001 }, (_, index) => `${USER_ID}/${String(index).padStart(4, '0')}.pdf`) });
  const result = await handler(request());
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'receipt_cleanup_limit');
  assert.equal(calls.some(([name]) => ['remove', 'deleteUser'].includes(name)), false);
});

test('cleanup bounds nested folders and total elapsed time', async () => {
  const nested = fixture({ files: [`${USER_ID}/a/b/c/d/e/receipt.pdf`] });
  assert.equal((await nested.handler(request())).status, 409);
  assert.equal(nested.calls.some(([name]) => name === 'remove'), false);
  let ticks = NOW;
  const timeout = fixture({ now: () => { ticks += 10000; return ticks; } });
  assert.equal((await timeout.handler(request())).status, 503);
  assert.equal(timeout.calls.some(([name]) => name === 'remove'), false);
});

test('concurrent uploads after cleanup are detected; account is not silently deleted', async () => {
  const { handler, calls } = fixture({ concurrentUpload: true });
  const result = await handler(request());
  assert.equal(result.status, 409);
  const body = await result.json();
  assert.equal(body.code, 'receipts_changed');
  assert.equal(body.receipts_may_have_been_removed, true);
  assert.equal(calls.some(([name]) => name === 'deleteUser'), false);
});

test('pagination inventories before deletion and removes in bounded batches', async () => {
  const { handler, calls } = fixture({ files: Array.from({ length: 205 }, (_, index) => `${USER_ID}/${String(index).padStart(4, '0')}.pdf`) });
  assert.equal((await handler(request())).status, 200);
  assert.deepEqual(calls.filter(([name]) => name === 'remove').map(([, paths]) => paths.length), [100, 100, 5]);
  assert.deepEqual(calls.filter(([name]) => name === 'list').map(([, , options]) => options.offset), [0, 100, 200, 0]);
});

test('CORS is exact-origin, OPTIONS has no side effects, and unsupported methods are rejected', async () => {
  const { handler, calls } = fixture();
  const allowed = await handler(request({ method: 'OPTIONS', token: null }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), config.allowedOrigins[0]);
  const denied = await handler(request({ origin: 'https://evil.example' }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await handler(request({ method: 'GET' }))).status, 405);
  assert.equal(calls.length, 0);
});

test('invalid, oversized or unconfirmed requests fail before external authentication', async () => {
  for (const body of ['not-json', [], { password: 'CurrentPassword1', confirmation: 'delete' }, { password: '', confirmation: 'DELETE' }, 'x'.repeat(8193)]) {
    const { handler, calls } = fixture();
    assert.ok([400, 413].includes((await handler(request({ body }))).status));
    assert.equal(calls.length, 0);
  }
  const { handler, calls } = fixture();
  assert.equal((await handler(request({ headers: { 'Content-Type': 'text/plain' } }))).status, 415);
  assert.equal(calls.length, 0);
});

test('missing server configuration fails without exposing any configured value', async () => {
  const { handler, calls } = fixture({ config: { publicKey: '' } });
  const result = await handler(request());
  assert.equal(result.status, 503);
  assert.equal((await result.text()).includes(config.serviceRoleKey), false);
  assert.equal(calls.length, 0);
});

test('a misconfigured privileged key cannot be used for password verification', async () => {
  for (const publicKey of ['sb_secret_privileged', jwt({ role: 'service_role' })]) {
    const { handler, calls } = fixture({ config: { publicKey } });
    assert.equal((await handler(request())).status, 503);
    assert.equal(calls.length, 0);
  }
});
