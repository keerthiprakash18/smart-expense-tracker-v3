import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSupabaseAuthHandler, readSupabaseAuthState, handleSupabaseAuth } from '../src/services/supabaseAuth.js';
import { isSupabaseMode, supabase, validateSupabaseConfig } from '../src/services/supabaseClient.js';

const ok = (data = {}) => ({ data, error: null });
const verifiedFactor = { id: 'factor-1', factor_type: 'totp', status: 'verified', friendly_name: 'Smart Expense' };
const user = { id: 'user-1', email: 'person@example.com', email_confirmed_at: '2026-01-01' };
const publicConfig = { VITE_BACKEND_PROVIDER: 'supabase', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' };

function fixture({ factors = [], aal = 'aal1', signedIn = true } = {}) {
  const calls = [];
  let session = signedIn ? { access_token: `token-${aal}`, user } : null;
  let currentLevel = aal;
  let allFactors = structuredClone(factors);
  const record = (name, fn) => async (...args) => { calls.push([name, ...args]); return fn(...args); };
  const client = { functions: { invoke: record('invoke', () => ok({ deleted: true })) }, auth: {
    getSession: record('getSession', () => ok({ session })),
    signUp: record('signUp', () => ok({ user, session: null })),
    signInWithPassword: record('signInWithPassword', () => { currentLevel = 'aal1'; session = { access_token: 'token-aal1', user }; return ok({ session, user }); }),
    signOut: record('signOut', () => { session = null; return ok(); }),
    refreshSession: record('refreshSession', () => { if (session) session = { ...session, access_token: 'token-refreshed' }; return ok({ session }); }),
    updateUser: record('updateUser', () => ok({ user })),
    resetPasswordForEmail: record('resetPasswordForEmail', () => ok()),
    resend: record('resend', () => ok()),
    mfa: {
      getAuthenticatorAssuranceLevel: record('assurance', () => ok({ currentLevel, nextLevel: allFactors.some((factor) => factor.status === 'verified') ? 'aal2' : currentLevel })),
      listFactors: record('listFactors', () => ok({ all: allFactors })),
      challengeAndVerify: record('challengeAndVerify', ({ factorId, code }) => {
        if (code !== '123456') return { error: { message: 'Invalid TOTP code', status: 422, code: 'mfa_verification_failed' } };
        const factor = allFactors.find((item) => item.id === factorId);
        if (factor) factor.status = 'verified';
        currentLevel = 'aal2'; session = { access_token: 'token-aal2', user }; return ok({ session });
      }),
      enroll: record('enroll', () => {
        allFactors.push({ ...verifiedFactor, status: 'unverified' });
        return ok({ id: 'factor-1', totp: { qr_code: 'data:image/svg+xml;utf-8,<svg fill="#000"/>', secret: 'TEST-ONLY-SECRET', uri: 'otpauth://test' } });
      }),
      unenroll: record('unenroll', ({ factorId }) => { allFactors = allFactors.filter((factor) => factor.id !== factorId); return ok(); }),
    },
  } };
  const handle = createSupabaseAuthHandler(client, {
    redirectUrl: (recovery) => recovery ? 'https://frontend.example/?auth=recovery#/reset-password' : 'https://frontend.example/#/login',
    verifyPassword: record('verifyPassword', () => undefined),
    recoveryUserId: () => user.id,
    finishRecovery: () => calls.push(['finishRecovery']),
  });
  return { client, handle, calls };
}

test('legacy/default mode creates no Supabase client and handles no endpoints', async () => {
  assert.equal(isSupabaseMode, false);
  assert.equal(supabase, null);
  assert.equal(await handleSupabaseAuth('POST', '/api/token/', {}), null);
  assert.equal(validateSupabaseConfig({}).error, null);
});

test('Supabase config fails closed when missing, malformed or privileged', () => {
  assert.match(validateSupabaseConfig({ VITE_BACKEND_PROVIDER: 'supabase' }).error.message, /requires/);
  assert.equal(validateSupabaseConfig(publicConfig).error, null);
  for (const key of ['sb_secret_admin', 'service_role', 'arbitrary', `e30.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`]) {
    assert.ok(validateSupabaseConfig({ ...publicConfig, VITE_SUPABASE_PUBLISHABLE_KEY: key }).error);
  }
  const anon = `e30.${btoa(JSON.stringify({ role: 'anon' }))}.signature`;
  assert.equal(validateSupabaseConfig({ ...publicConfig, VITE_SUPABASE_PUBLISHABLE_KEY: anon }).error, null);
  for (const url of ['not-a-url', 'http://example.supabase.co', 'https://user:password@example.supabase.co']) {
    assert.ok(validateSupabaseConfig({ ...publicConfig, VITE_SUPABASE_URL: url }).error);
  }
  assert.equal(validateSupabaseConfig({ ...publicConfig, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }).error, null);
});

test('unknown endpoints/methods remain unhandled; missing configuration throws an actionable error', async () => {
  const { handle } = fixture();
  assert.equal(await handle('GET', '/api/profile/'), null);
  assert.equal(await handle('GET', '/api/token/'), null);
  const missing = createSupabaseAuthHandler(null, { configurationError: new Error('Configure VITE_SUPABASE_URL') });
  await assert.rejects(missing('POST', '/api/token/'), (error) => error.response.data.detail.includes('VITE_SUPABASE_URL'));
});

test('signup sends email/password only as credentials, metadata is allowlisted, and confirmation does not auto-login', async () => {
  const { handle, calls } = fixture({ signedIn: false });
  const result = await handle('post', 'api/register', { username: 'legacy-name', email: ' Person@Example.com ', password: 'StrongPassword1', name: ' Person ', phone: '+15550000000', accepted_terms: true, accepted_privacy: true, role: 'admin' });
  assert.equal(result.status, 201);
  assert.equal(result.data.confirmation_required, true);
  assert.equal(result.data.access, undefined);
  const signup = calls.find(([name]) => name === 'signUp')[1];
  assert.deepEqual(Object.keys(signup).sort(), ['email', 'options', 'password']);
  assert.equal(signup.email, 'person@example.com');
  assert.deepEqual(signup.options.data, { name: 'Person', phone: '+15550000000', accepted_terms: true, accepted_privacy: true, terms_accepted_at: true, privacy_accepted_at: true });
  assert.equal(calls.some(([name]) => name === 'signInWithPassword'), false);
});

test('signup without policy consent makes no network request', async () => {
  const { handle, calls } = fixture();
  await assert.rejects(handle('POST', '/api/register/', { email: user.email, password: 'Password1' }), /Accept the Terms/);
  assert.equal(calls.length, 0);
});

test('unconfirmed-email failures reach the UI with their code and clear instructions', async () => {
  const { client, handle } = fixture();
  client.auth.signInWithPassword = async () => ({ error: { message: 'Email not confirmed', code: 'email_not_confirmed', status: 400 } });
  await assert.rejects(handle('POST', '/api/token/', { username: user.email, password: 'Password1' }), (error) => error.response.data.code === 'email_not_confirmed' && /Confirm your email/.test(error.message));
});

test('login with verified MFA returns a challenge, never an access token at AAL1', async () => {
  const { handle, calls } = fixture({ factors: [verifiedFactor] });
  const result = await handle('POST', '/api/token/', { username: user.email, password: 'Password1' });
  assert.equal(result.status, 202);
  assert.equal(result.data.two_factor_required, true);
  assert.equal(result.data.access, undefined);
  assert.deepEqual(result.data.factors, [{ id: 'factor-1', friendly_name: 'Smart Expense' }]);
  assert.ok(calls.some(([name, token]) => name === 'assurance' && token === 'token-aal1'));
});

test('a valid authenticator upgrades the existing session without password re-login', async () => {
  const { handle, calls } = fixture({ factors: [verifiedFactor] });
  const result = await handle('POST', '/api/token/mfa/', { otp: '123456', factor_id: 'factor-1' });
  assert.equal(result.data.access, 'token-aal2');
  assert.equal(calls.some(([name]) => name === 'signInWithPassword'), false);
});

test('invalid MFA/recovery codes and foreign factor ids cannot bypass verification', async () => {
  const { handle } = fixture({ factors: [verifiedFactor] });
  await assert.rejects(handle('POST', '/api/token/mfa/', { otp: 'ABCDE-FGHIJ' }), /Legacy recovery codes/);
  await assert.rejects(handle('POST', '/api/token/mfa/', { otp: '000000' }), (error) => error.response.data.code === 'mfa_verification_failed');
  await assert.rejects(handle('POST', '/api/token/mfa/', { otp: '123456', factor_id: 'other-account' }), /No supported authenticator/);
});

test('unsupported enrolled MFA still blocks AAL1 authentication', async () => {
  const { handle } = fixture({ factors: [{ ...verifiedFactor, factor_type: 'phone' }] });
  const result = await handle('POST', '/api/token/', { username: user.email, password: 'Password1' });
  assert.equal(result.status, 202);
  assert.deepEqual(result.data.factors, []);
  assert.match(result.data.detail, /does not support/);
});

test('server factor state blocks stale local sessions and server errors are not swallowed', async () => {
  const { client } = fixture({ factors: [verifiedFactor] });
  client.auth.mfa.getAuthenticatorAssuranceLevel = async () => ok({ currentLevel: 'aal1', nextLevel: 'aal1' });
  assert.equal((await readSupabaseAuthState(client)).authenticated, false);
  client.auth.mfa.listFactors = async () => ({ error: new Error('Auth server unavailable') });
  await assert.rejects(readSupabaseAuthState(client), /Auth server unavailable/);
});

test('a signed-out session never authenticates, while unverified enrollment does not force MFA', async () => {
  assert.equal((await readSupabaseAuthState(fixture({ signedIn: false }).client)).authenticated, false);
  assert.equal((await readSupabaseAuthState(fixture({ factors: [{ ...verifiedFactor, status: 'unverified' }] }).client)).authenticated, true);
});

test('refresh uses the SDK session and rechecks MFA; no caller-supplied legacy refresh token is used', async () => {
  const { handle, calls } = fixture();
  const result = await handle('POST', '/api/token/refresh/', { refresh: 'legacy-token' });
  assert.equal(result.data.access, 'token-refreshed');
  assert.deepEqual(calls.find(([name]) => name === 'refreshSession'), ['refreshSession']);
  await assert.rejects(fixture({ factors: [verifiedFactor] }).handle('POST', '/api/token/refresh/'), (error) => error.response.status === 403);
});

test('MFA setup/confirm maps the existing UI response without inventing recovery codes', async () => {
  const { handle } = fixture();
  const setup = await handle('POST', '/api/v3/security/2fa/setup/');
  assert.equal(setup.data.secret, 'TEST-ONLY-SECRET');
  assert.match(setup.data.qr_data_url, /%23000/);
  const confirmed = await handle('POST', '/api/v3/security/2fa/confirm/', { code: '123456' });
  assert.equal(confirmed.data.two_factor_enabled, true);
  assert.deepEqual(confirmed.data.recovery_codes, []);
  assert.equal(confirmed.data.recovery_codes_supported, false);
  const status = await handle('GET', '/api/v3/security/');
  assert.equal(status.data.two_factor_enabled, true);
});

test('MFA cannot be confirmed without setup, and setup only removes this app\'s abandoned factors', async () => {
  const { handle, calls } = fixture({ factors: [
    { ...verifiedFactor, id: 'abandoned', status: 'unverified' },
    { ...verifiedFactor, id: 'other-app', status: 'unverified', friendly_name: 'Other app' },
  ] });
  await assert.rejects(handle('POST', '/api/v3/security/2fa/confirm/', { code: '123456' }), /Start authenticator setup/);
  await handle('POST', '/api/v3/security/2fa/setup/');
  assert.deepEqual(calls.filter(([name]) => name === 'unenroll'), [['unenroll', { factorId: 'abandoned' }]]);
});

test('disabling MFA requires AAL2, current password verification and a fresh authenticator challenge', async () => {
  const { handle, calls } = fixture({ factors: [verifiedFactor], aal: 'aal2' });
  await handle('POST', '/api/v3/security/2fa/disable/', { password: 'Password1', code: '123456' });
  const operations = calls.filter(([name]) => ['verifyPassword', 'challengeAndVerify', 'unenroll', 'refreshSession'].includes(name)).map(([name]) => name);
  assert.deepEqual(operations, ['verifyPassword', 'challengeAndVerify', 'unenroll', 'refreshSession']);
  await assert.rejects(fixture({ factors: [verifiedFactor] }).handle('POST', '/api/v3/security/2fa/disable/', { password: 'Password1', code: '123456' }), /Complete authenticator/);
});

test('change-password verifies old password server-side and signs out globally after updating', async () => {
  const { handle, calls } = fixture();
  await handle('POST', '/api/change-password/', { old_password: 'Password1', new_password: 'NewPassword2' });
  assert.deepEqual(calls.find(([name]) => name === 'updateUser'), ['updateUser', { password: 'NewPassword2', current_password: 'Password1' }]);
  assert.deepEqual(calls.find(([name]) => name === 'signOut'), ['signOut', { scope: 'global' }]);
});

test('email reset uses the PKCE-compatible recovery route and returns an enumeration-safe message', async () => {
  const { handle, calls } = fixture({ signedIn: false });
  const result = await handle('POST', '/api/password-reset/', { email: ' PERSON@example.com ' });
  assert.match(result.data.message, /If an account exists/);
  assert.deepEqual(calls[0], ['resetPasswordForEmail', user.email, { redirectTo: 'https://frontend.example/?auth=recovery#/reset-password' }]);
  await assert.rejects(handle('POST', '/api/v3/password-reset/recovery/', {}), /Legacy recovery codes/);
});

test('password recovery requires a recovery session and does not bypass enrolled MFA', async () => {
  const { client } = fixture();
  const noRecovery = createSupabaseAuthHandler(client, { recoveryUserId: () => null });
  await assert.rejects(noRecovery('POST', '/api/password-reset/confirm/', { new_password: 'Password1' }), (error) => error.response.data.code === 'recovery_session_required');
  const { handle, calls } = fixture({ factors: [verifiedFactor] });
  const challenge = await handle('POST', '/api/password-reset/confirm/', { new_password: 'NewPassword1' });
  assert.equal(challenge.status, 202);
  assert.equal(calls.some(([name]) => name === 'updateUser'), false);
  const result = await handle('POST', '/api/password-reset/confirm/', { new_password: 'NewPassword1', otp: '123456' });
  assert.match(result.data.message, /Password updated/);
  assert.deepEqual(calls.find(([name]) => name === 'signOut'), ['signOut', { scope: 'global' }]);
});

test('logout failures are observable instead of falsely returning success', async () => {
  const { client, handle } = fixture();
  client.auth.signOut = async () => ({ error: { message: 'Network unavailable', status: 503 } });
  await assert.rejects(handle('POST', '/api/logout/'), (error) => error.response.status === 503 && error.message === 'Network unavailable');
});

test('account deletion invokes the server with the current JWT and only confirmation/password, then revokes the SDK session', async () => {
  const { handle, calls } = fixture({ factors: [verifiedFactor], aal: 'aal2' });
  const result = await handle('POST', '/api/delete-account/', { password: 'Password1', confirmation: 'DELETE', user_id: 'someone-else' });
  assert.equal(result.data.deleted, true);
  assert.deepEqual(calls.find(([name]) => name === 'invoke'), ['invoke', 'delete-account', { method: 'POST', headers: { Authorization: 'Bearer token-aal2' }, body: { password: 'Password1', confirmation: 'DELETE' } }]);
  assert.deepEqual(calls.find(([name]) => name === 'signOut'), ['signOut', { scope: 'local' }]);
});

test('account deletion rejects insufficient MFA or confirmation before invoking the function', async () => {
  const mfa = fixture({ factors: [verifiedFactor] });
  await assert.rejects(mfa.handle('POST', '/api/delete-account/', { password: 'Password1', confirmation: 'DELETE' }), (error) => error.response.status === 403);
  assert.equal(mfa.calls.some(([name]) => name === 'invoke'), false);
  const normal = fixture();
  await assert.rejects(normal.handle('POST', '/api/delete-account/', { password: 'Password1', confirmation: 'delete' }), /type DELETE/);
  assert.equal(normal.calls.some(([name]) => name === 'invoke'), false);
});

test('account deletion preserves server privilege/cleanup errors and never signs out as if deletion succeeded', async () => {
  const { client, handle, calls } = fixture();
  client.functions.invoke = async () => ({ data: null, error: { context: new Response(JSON.stringify({ error: 'Verify your authenticator', code: 'mfa_required' }), { status: 403 }) } });
  await assert.rejects(handle('POST', '/api/delete-account/', { password: 'Password1', confirmation: 'DELETE' }), (error) => error.response.status === 403 && error.response.data.code === 'mfa_required');
  assert.equal(calls.some(([name]) => name === 'signOut'), false);
});

test('account deletion reports an already-deleted account accurately when subsequent local sign-out fails', async () => {
  const { client, handle } = fixture();
  client.auth.signOut = async () => ({ error: new Error('offline') });
  await assert.rejects(handle('POST', '/api/delete-account/', { password: 'Password1', confirmation: 'DELETE' }), (error) => error.response.data.account_deleted === true && error.response.data.code === 'account_deleted_signout_failed');
});
