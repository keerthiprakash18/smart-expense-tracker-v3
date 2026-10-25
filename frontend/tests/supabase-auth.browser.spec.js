import { test, expect } from '@playwright/test';

const storageKey = 'sb-auth-test-auth-token';
const factor = { id: '11111111-1111-4111-8111-111111111111', factor_type: 'totp', status: 'verified', friendly_name: 'Smart Expense' };
const user = { id: '22222222-2222-4222-8222-222222222222', aud: 'authenticated', role: 'authenticated', email: 'person@example.com', email_confirmed_at: '2026-01-01', app_metadata: {}, user_metadata: {}, factors: [factor] };

function session(aal = 'aal1') {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, aal, exp: expiresAt, iat: expiresAt - 3600, role: 'authenticated' })}.${Buffer.from('offline-test-signature').toString('base64url')}`;
  return { access_token: access, refresh_token: 'offline-refresh-token', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user };
}

async function prepare(page, { aal = 'aal1', recovery = false } = {}) {
  const initial = session(aal);
  const requests = [];
  let refreshAal = aal;
  await page.addInitScript(({ initial, key, recovery }) => {
    localStorage.setItem('smart_expense_intro_seen', 'true');
    localStorage.setItem('access_token', 'old-django-token-must-not-authenticate');
    if (recovery) localStorage.setItem(`${key}-code-verifier`, JSON.stringify('offline-verifier/recovery'));
    else localStorage.setItem(key, JSON.stringify(initial));
  }, { initial, key: storageKey, recovery });
  await page.route('https://auth-test.supabase.co/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname.endsWith('/user')) return route.fulfill({ json: user });
    if (url.pathname.endsWith('/token')) return route.fulfill({ json: session(refreshAal) });
    if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204 });
    if (url.pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { message: `Unexpected offline test endpoint: ${url.pathname}` } });
  });
  await page.route('**/api/**', async (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: {} });
  });
  return { requests, setRefreshAal: (value) => { refreshAal = value; } };
}

test('restored AAL1 with enrolled MFA is routed to the authenticator step before any finance fetch', async ({ page }) => {
  const { requests } = await prepare(page);
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'Verify your authenticator' })).toBeVisible();
  await expect(page).toHaveURL(/#\/login$/);
  expect(requests.some((path) => path.startsWith('/api/') || path.startsWith('/rest/'))).toBe(false);
});

test('session refresh retains an authenticated route and SIGNED_OUT immediately closes it', async ({ page }) => {
  await prepare(page, { aal: 'aal2' });
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'More tools' })).toBeVisible();
  await page.evaluate(async () => {
    const { supabase } = await import('/src/services/supabaseClient.js');
    const { error } = await supabase.auth.refreshSession();
    if (error) throw error;
  });
  await expect(page.getByRole('heading', { name: 'More tools' })).toBeVisible();
  await page.evaluate(async () => {
    const { supabase } = await import('/src/services/supabaseClient.js');
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
  });
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
});

test('a refresh downgraded to AAL1 cannot leave an MFA-protected route open', async ({ page }) => {
  const { setRefreshAal } = await prepare(page, { aal: 'aal2' });
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'More tools' })).toBeVisible();
  setRefreshAal('aal1');
  await page.evaluate(async () => {
    const { supabase } = await import('/src/services/supabaseClient.js');
    const { error } = await supabase.auth.refreshSession();
    if (error) throw error;
  });
  await expect(page.getByRole('heading', { name: 'Verify your authenticator' })).toBeVisible();
});

test('PKCE recovery callback reaches the password page, requires MFA and never opens finance', async ({ page }) => {
  const { requests } = await prepare(page, { recovery: true });
  await page.goto('/?auth=recovery&code=offline-auth-code#/reset-password');
  await expect(page.getByLabel('New password')).toBeVisible();
  await expect(page.getByLabel('Authenticator code')).toBeVisible();
  expect(requests.some((path) => path.startsWith('/api/') || path.startsWith('/rest/'))).toBe(false);
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
});

test('the API auth-expired event revokes both route access and the SDK session', async ({ page }) => {
  await prepare(page, { aal: 'aal2' });
  await page.goto('/#/more');
  await expect(page.getByRole('heading', { name: 'More tools' })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('smart-expense-auth-expired')));
  await expect(page.getByRole('heading', { name: 'Sign in to your workspace' })).toBeVisible();
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBeNull();
});

test('Supabase security settings use authenticator-only language and a masked account deletion form', async ({ page }) => {
  await prepare(page, { aal: 'aal2' });
  await page.route('**/api/v3/security/', (route) => route.fulfill({ json: { two_factor_enabled: true, email_verified: true, mfa_disable_supported: true, recovery_codes_supported: false } }));
  await page.goto('/#/profile');
  await expect(page.getByText('Email confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Enabled • authenticator verification required', { exact: true })).toBeVisible();
  await expect(page.getByText(/recovery codes left/)).toHaveCount(0);
  await expect(page.getByText(/password-reset email are temporarily hidden/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Disable 2FA', exact: true }).click();
  await expect(page.getByLabel('Authenticator code', { exact: true })).toHaveAttribute('pattern', '[0-9]{6}');
  await expect(page.getByLabel('Authenticator or recovery code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByLabel('Current password for account deletion')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Permanently delete account' })).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await expect(page.getByRole('button', { name: 'Permanently delete account' })).toBeEnabled();
});
