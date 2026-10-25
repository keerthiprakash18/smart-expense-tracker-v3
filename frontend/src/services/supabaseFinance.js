// Django-shaped responses for the existing UI; all persistence is Supabase/RLS.
// Never use a service-role key here or silently fall back to the old backend.
const fields = {
  accounts: 'name account_type balance',
  expenses: 'account title amount transaction_type category payment_method date time notes is_recurring receipt_image ocr_confidence',
  bills: 'title amount due_date category is_paid is_recurring',
  savings_goals: 'name target_amount current_amount target_date icon',
  money_debts: 'direction person_name amount transaction_date due_date purpose notes',
  debt_payments: 'debt amount payment_date notes',
  transfers: 'from_account to_account amount date notes',
  category_budgets: 'category amount period active',
  recurring_rules: 'title amount transaction_type category account payment_method frequency interval next_run end_date active notes',
  categories: 'name category_type color icon',
  credit_cards: 'name last4 credit_limit outstanding statement_day due_day linked_account active',
  credit_card_activities: 'card activity_type amount date notes payment_account adjustment_direction',
  notifications: 'is_read',
  profiles: 'name phone country currency monthly_budget savings_goal dark_mode budget_alerts bill_reminders',
};
const routes = {
  accounts: 'accounts', expenses: 'expenses', bills: 'bills', 'savings-goals': 'savings_goals',
  'money-debts': 'money_debts', 'v3/transfers': 'transfers', 'v3/category-budgets': 'category_budgets',
  'v3/recurring': 'recurring_rules', 'v3/categories': 'categories', 'v3/credit-cards': 'credit_cards',
  'v3/notifications': 'notifications',
};
const booleans = new Set('is_recurring is_paid active dark_mode budget_alerts bill_reminders is_read'.split(' '));
const nullable = new Set('account linked_account payment_account end_date due_date target_date receipt_image ocr_confidence phone'.split(' '));
const bucket = 'tracker-receipts';
const PAGE = 500;

export function financeError(message, status = 400) {
  const error = new Error(message);
  error.response = { status, data: { error: message, detail: message } };
  return error;
}

export function checked(result) {
  if (result.error) {
    const code = result.error.code;
    const message = code === '23503' ? 'This record references another account or still has dependent history. Remove or reassign that history first.'
      : code === '23505' ? 'A record with these details already exists.'
      : code === '42501' ? 'Access denied. Sign in and complete authenticator verification if enabled.'
      : code === 'PGRST116' ? 'Record not found or not accessible.'
      : result.error.message || 'Supabase request failed.';
    throw financeError(message, code === '42501' ? 403 : code === 'PGRST116' ? 404 : 400);
  }
  return result.data;
}

export function writePayload(table, body, update = false) {
  const values = body instanceof FormData ? Object.fromEntries(body.entries()) : { ...body };
  const result = {};
  for (const key of fields[table].split(' ')) {
    if (!Object.hasOwn(values, key) || values[key] === undefined) continue;
    if (update && ((table === 'accounts' && key === 'balance') || (table === 'credit_cards' && key === 'outstanding'))) {
      throw financeError('Balances are ledger-managed. Record a transaction or card activity to change them.');
    }
    let value = values[key];
    if (booleans.has(key)) {
      if (![true, false, 'true', 'false'].includes(value)) throw financeError(`Invalid boolean for ${key}.`);
      value = value === true || value === 'true';
    }
    if (value === '' && nullable.has(key)) value = null;
    result[key] = value;
  }
  // Clients never choose owner/identity/audit fields, even in imported data.
  for (const key of ['id', 'user_id', 'created_at', 'updated_at', 'amount_paid', 'status', 'last_run']) {
    if (Object.hasOwn(values, key)) throw financeError(`The server manages ${key}.`);
  }
  return result;
}

export function filterLedger(rows, params, accounts = []) {
  const names = new Map(accounts.map((a) => [String(a.id), a.name]));
  const search = (params.get('search') || '').trim().toLocaleLowerCase();
  return rows.filter((row) => {
    for (const key of ['transaction_type', 'category', 'payment_method']) {
      if (params.get(key) && String(row[key]).toLocaleLowerCase() !== params.get(key).toLocaleLowerCase()) return false;
    }
    if (params.get('start_date') && row.date < params.get('start_date')) return false;
    if (params.get('end_date') && row.date > params.get('end_date')) return false;
    return !search || [row.title, row.category, row.payment_method, row.notes, names.get(String(row.account))].some((value) => String(value || '').toLocaleLowerCase().includes(search));
  }).sort((a, b) => b.date.localeCompare(a.date) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
}

export function paginate(rows, params) {
  const positive = (value, fallback) => /^\d+$/.test(value || '') && Number(value) > 0 ? Number(value) : fallback;
  const pageSize = Math.min(100, positive(params.get('page_size'), 50));
  const page = positive(params.get('page'), 1);
  return { count: rows.length, page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(rows.length / pageSize)),
    has_next: page * pageSize < rows.length, has_previous: page > 1,
    results: rows.slice((page - 1) * pageSize, page * pageSize) };
}

// Keyset paging avoids Supabase's default 1000-row cap. Refuse to silently
// truncate very large exports; aggregates use server-side SQL instead.
export async function readAll(client, table, userId, filter = (q) => q) {
  const rows = [];
  let after;
  for (;;) {
    let query = client.from(`tracker_${table}`).select('*').eq('user_id', userId).order('id').limit(PAGE);
    if (after !== undefined) query = query.gt('id', after);
    const batch = checked(await filter(query));
    rows.push(...batch);
    if (rows.length > 20000) throw financeError('This view exceeds 20,000 records. Use the database export workflow instead of a partial result.', 413);
    if (batch.length < PAGE) return rows;
    after = batch.at(-1).id;
  }
}

export function createFinanceHandler(client, { scanReceipt, predict, now = () => new Date() } = {}) {
  const rpc = async (name, args) => checked(await client.rpc(name, args));
  return async function handle(method, path, body = {}, config = {}) {
    method = method.toUpperCase();
    const url = new URL(path, 'https://local.invalid');
    for (const [key, value] of Object.entries(config.params || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const route = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
    const { user } = checked(await client.auth.getUser());
    if (!user) throw financeError('Sign in to continue.', 401);
    const uid = user.id;
    const all = (table, filter) => readAll(client, table, uid, filter);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
    const answer = (data, status = 200) => ({ data, status });

    async function enrich(table, rows) {
      let accounts = [];
      if (['expenses', 'transfers', 'recurring_rules', 'credit_cards'].includes(table)) accounts = await all('accounts');
      const names = new Map(accounts.map((a) => [String(a.id), a.name]));
      let spending = new Map();
      if (table === 'category_budgets') {
        const { analytics } = await rpc('tracker_summary');
        spending = new Map(analytics.month.categories.map((c) => [c.name, c.value]));
      }
      const paths = [...new Set(rows.map((r) => r.receipt_image).filter(Boolean))];
      let signed = new Map();
      if (paths.length) {
        const result = checked(await client.storage.from(bucket).createSignedUrls(paths, 300));
        signed = new Map(result.filter((x) => !x.error).map((x) => [x.path, x.signedUrl]));
      }
      return rows.map((row) => {
        const item = { ...row };
        if ('account' in item) item.account_name = names.get(String(item.account)) || null;
        if (table === 'expenses') { item.receipt_path = item.receipt_image; item.receipt_image = signed.get(item.receipt_image) || null; }
        if (table === 'transfers') { item.from_account_name = names.get(String(item.from_account)); item.to_account_name = names.get(String(item.to_account)); }
        if (table === 'money_debts') {
          item.remaining_amount = Math.max(0, Number(item.amount) - Number(item.amount_paid));
          if (item.remaining_amount > 0 && item.due_date && item.due_date < today) item.status = 'OVERDUE';
        }
        if (table === 'savings_goals') item.progress_percent = Number(item.target_amount) > 0 ? Math.round(Number(item.current_amount) / Number(item.target_amount) * 1000) / 10 : 0;
        if (table === 'credit_cards') {
          item.available_credit = Math.max(0, Number(item.credit_limit) - Number(item.outstanding));
          item.utilization_percent = Number(item.credit_limit) > 0 ? Math.round(Number(item.outstanding) / Number(item.credit_limit) * 1000) / 10 : 0;
        }
        if (table === 'category_budgets') { item.spent = spending.get(item.category) || 0; item.percent = Number(item.amount) > 0 ? Math.round(item.spent / Number(item.amount) * 1000) / 10 : 0; }
        return item;
      });
    }

    if (route === 'profile') {
      if (['PUT', 'PATCH'].includes(method)) {
        if ((body.username && body.username !== user.email) || (body.email && body.email.toLowerCase() !== user.email?.toLowerCase())) throw financeError('Email is your sign-in identity in Supabase mode. Keep it unchanged here; email changes require a separate confirmation flow.');
        checked(await client.from('tracker_profiles').update(writePayload('profiles', body, true)).eq('id', uid));
      } else if (method !== 'GET') throw financeError('Method not supported.', 405);
      const row = checked(await client.from('tracker_profiles').select('*').eq('id', uid).single());
      return answer({ ...row, username: user.email, email: user.email, date_joined: user.created_at?.slice(0, 10), monthly_budget: Number(row.monthly_budget), savings_goal: Number(row.savings_goal) });
    }
    const summaryRoutes = { dashboard: 'dashboard', 'v3/analytics/summary': 'analytics', 'v3/insights': 'insights', 'v3/ai/forecast': 'forecast' };
    if (summaryRoutes[route] && method === 'GET') return answer((await rpc('tracker_summary'))[summaryRoutes[route]]);
    if (route === 'v3/recurring/process' && method === 'POST') return answer(await rpc('tracker_process_recurring'));
    if (route === 'v3/notifications/sync' && method === 'POST') return answer(await rpc('tracker_sync_notifications'));
    if (route === 'v3/notifications/read-all' && method === 'POST') {
      checked(await client.from('tracker_notifications').update({ is_read: true }).eq('user_id', uid));
      return answer({ message: 'Notifications marked read.' });
    }
    if (route === 'v3/backup/export' && method === 'GET') return answer(await rpc('tracker_export_backup'));
    if (route === 'v3/backup/import' && method === 'POST') return answer(await rpc('tracker_restore_backup', { p_data: body.data, p_confirm: body.confirm === true }));
    if (route === 'scan-receipt' && method === 'POST') return answer(await scanReceipt(body, { signal: config.signal }));
    if (route === 'v3/receipts/status' && method === 'GET') return answer({ storage_durable: true, backend: 'supabase-private-storage' });
    if (route === 'v3/receipts' && method === 'GET') {
      const rows = await all('expenses', (q) => q.not('receipt_image', 'is', null));
      return answer({ storage_durable: true, results: await enrich('expenses', rows.sort((a, b) => b.date.localeCompare(a.date))) });
    }
    if (route === 'v3/calendar' && method === 'GET') {
      const month = url.searchParams.get('month') || today.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw financeError('Use a valid YYYY-MM month.');
      const selectMonth = (rows, key) => rows.filter((r) => r[key]?.startsWith(month));
      const [tx, bills, transfers, rules] = await Promise.all([all('expenses'), all('bills'), all('transfers'), all('recurring_rules')]);
      return answer({ transactions: selectMonth(tx, 'date'), bills: selectMonth(bills, 'due_date').map((b) => ({ ...b, date: b.due_date })), transfers: await enrich('transfers', selectMonth(transfers, 'date')), recurring: selectMonth(rules, 'next_run') });
    }
    if (route.startsWith('v3/ai/') && predict) return answer(await predict(route, method, body, await all('expenses'), await all('recurring_rules')));
    if (route === 'v3/transactions/export.csv' && method === 'GET') {
      const [rows, accounts] = await Promise.all([all('expenses'), all('accounts')]);
      const { exportCsv } = await import('./trackerCsv.js');
      return answer(new Blob([exportCsv(filterLedger(rows, url.searchParams, accounts), accounts)], { type: 'text/csv;charset=utf-8' }));
    }
    if (route === 'v3/import/csv' && method === 'POST') {
      const file = body instanceof FormData && body.get('file');
      if (!(file instanceof Blob) || file.size > 2 * 1024 * 1024) throw financeError('Choose a CSV file smaller than 2 MiB.');
      const { importCsv } = await import('./trackerCsv.js');
      return answer(await rpc('tracker_import_expenses', { p_rows: importCsv(await file.text(), await all('accounts')) }));
    }
    // Remaining paths are strict CRUD collections or owned child collections.
    let table, id, parent;
    const payment = route.match(/^money-debts\/(\d+)\/payments$/);
    const activity = route.match(/^v3\/credit-cards\/(\d+)\/activity$/);
    if (payment) { table = 'debt_payments'; parent = { debt: payment[1] }; }
    else if (activity) { table = 'credit_card_activities'; parent = { card: activity[1] }; }
    else {
      const match = route.match(/^(.*?)(?:\/(\d+))?$/);
      table = routes[match?.[1]]; id = match?.[2];
    }
    if (!table) throw financeError(`This operation is not available in Supabase mode: ${route}`, 501);
    if (method === 'GET') {
      let rows = id ? [checked(await client.from(`tracker_${table}`).select('*').eq('user_id', uid).eq('id', id).single())]
        : await all(table, (q) => parent ? q.eq(Object.keys(parent)[0], Object.values(parent)[0]) : q);
      if (table === 'expenses' && !id) {
        rows = filterLedger(rows, url.searchParams, await all('accounts'));
        const result = paginate(rows, url.searchParams);
        result.results = await enrich(table, result.results);
        return answer(result);
      }
      rows = await enrich(table, rows);
      return answer(id ? rows[0] : table === 'notifications' ? { results: rows.reverse() } : rows);
    }
    if (method === 'DELETE' && id) {
      const deleted = checked(await client.from(`tracker_${table}`).delete().eq('user_id', uid).eq('id', id).select('id'));
      if (!deleted.length) throw financeError('Record not found.', 404);
      return answer(null, 204);
    }
    if (!['POST', 'PUT', 'PATCH'].includes(method) || (method !== 'POST' && !id) || (method === 'POST' && id) || (table === 'notifications' && method === 'POST')) throw financeError('Method not supported.', 405);
    const payload = { ...writePayload(table, body, method !== 'POST'), ...parent };
    if (table === 'expenses' && payload.receipt_image instanceof Blob) {
      const file = payload.receipt_image;
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[file.type];
      if (!ext || file.size > 10 * 1024 * 1024) throw financeError('Receipt must be JPEG, PNG, WebP or PDF, at most 10 MiB.');
      const objectPath = `${uid}/${crypto.randomUUID()}.${ext}`;
      checked(await client.storage.from(bucket).upload(objectPath, file, { upsert: false, contentType: file.type }));
      // Retain a possibly orphaned private object on ambiguous DB failure. Never
      // delete it automatically: the write may have committed despite a timeout.
      payload.receipt_image = objectPath;
    }
    if (payload.receipt_image && !String(payload.receipt_image).startsWith(`${uid}/`)) throw financeError('Receipt path must belong to the current user.');
    const query = method === 'POST' ? client.from(`tracker_${table}`).insert({ ...payload, user_id: uid })
      : client.from(`tracker_${table}`).update(payload).eq('user_id', uid).eq('id', id);
    const row = checked(await query.select('*').single());
    return answer((await enrich(table, [row]))[0], method === 'POST' ? 201 : 200);
  };
}
