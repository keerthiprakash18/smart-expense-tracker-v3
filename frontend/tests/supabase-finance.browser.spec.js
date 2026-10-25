import { test, expect } from '@playwright/test';

test('real UI login, expense creation and refresh use Supabase only (HTTP mocked)', async ({ page }) => {
  const user = { id: '22222222-2222-4222-8222-222222222222', email: 'person@example.com', email_confirmed_at: '2026-01-01', created_at: '2026-01-01', app_metadata: {}, user_metadata: {}, factors: [], aud: 'authenticated', role: 'authenticated' };
  const encode = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${encode({ alg: 'HS256' })}.${encode({ sub: user.id, aal: 'aal1', exp, role: 'authenticated' })}.${Buffer.from('offline-signature').toString('base64url')}`;
  const session = { access_token: token, refresh_token: 'offline-only', expires_in: 3600, expires_at: exp, token_type: 'bearer', user };
  const entries = [], legacy = [], errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('smart_expense_intro_seen', 'true'));
  await page.route('**/api/**', (route) => { legacy.push(route.request().url()); return route.abort(); });
  await page.route('https://auth-test.supabase.co/**', async (route) => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path.endsWith('/user')) return route.fulfill({ json: user });
    if (path.endsWith('/token')) return route.fulfill({ json: session });
    if (path.endsWith('/logout')) return route.fulfill({ status: 204 });
    if (path.endsWith('/tracker_profiles')) return route.fulfill({ json: { id: user.id, name: 'Test User', currency: '₹', monthly_budget: 45000, savings_goal: 100000 } });
    if (path.endsWith('/tracker_accounts')) return route.fulfill({ json: [{ id: 1, user_id: user.id, name: 'Primary Bank', account_type: 'BANK', balance: 1000 - entries.reduce((sum, r) => sum + Number(r.amount), 0) }] });
    if (path.endsWith('/rpc/tracker_summary')) return route.fulfill({ json: { dashboard: { count: entries.length, account_balance: 1000 }, analytics: { month: { categories: [] }, totals: {}, months: [] }, insights: { insights: [] }, forecast: { categories: [] } } });
    if (path.endsWith('/tracker_expenses')) {
      if (req.method() === 'POST') { const row = { ...req.postDataJSON(), id: entries.length + 1 }; entries.push(row); return route.fulfill({ status: 201, json: row }); }
      return route.fulfill({ json: entries });
    }
    if (path.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 400, json: { message: `Unhandled test route ${path}` } });
  });
  await page.goto('/#/login');
  await page.getByLabel('Email', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('Offline-test-only-123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/#\/login$/);
  await page.goto('/#/add');
  await page.getByPlaceholder('0.00').fill('125.50');
  await page.getByLabel('Title / Merchant').fill('Supabase persistence check');
  await page.getByRole('combobox', { name: 'Account', exact: true }).selectOption('1');
  await page.getByRole('button', { name: 'Save transaction', exact: true }).click();
  await expect(page).toHaveURL(/#\/transactions$/);
  await expect(page.getByText('Supabase persistence check', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Supabase persistence check', { exact: true })).toBeVisible();
  expect(entries).toHaveLength(1);
  expect(entries[0].user_id).toBe(user.id);
  expect(entries[0].amount).toBe('125.50');
  expect(legacy).toEqual([]);
  expect(errors).toEqual([]);
});
