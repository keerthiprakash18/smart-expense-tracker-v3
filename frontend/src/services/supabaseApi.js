import { requireSupabase } from './supabaseClient.js';
import { handleSupabaseAuth } from './supabaseAuth.js';
import { createFinanceHandler, financeError } from './supabaseFinance.js';
import { handleSupabaseAssistant } from './supabaseAssistant.js';

let finance;
async function request(method, path, data, config = {}) {
  const client = requireSupabase();
  if (!String(path).startsWith('/api/') || String(path).includes('://')) throw financeError('Only app-relative API routes are permitted.');
  if (config.signal?.aborted) throw financeError('Request cancelled.', 499);
  const authResult = await handleSupabaseAuth(method, path, data);
  if (authResult) return authResult;
  const { data: before, error } = await client.auth.getSession();
  if (error || !before.session) throw financeError('Sign in to continue.', 401);
  const userId = before.session.user.id;
  const assistant = await handleSupabaseAssistant(client, method, path, data);
  finance ||= createFinanceHandler(client, {
    scanReceipt: async (...args) => (await import('./receiptOcr.js')).scanReceipt(...args),
    predict: async (...args) => (await import('./trackerLearning.js')).learningResponse(...args),
  });
  const result = assistant || await finance(method, path, data, config);
  const { data: after } = await client.auth.getSession();
  if (after.session?.user.id !== userId) throw financeError('The signed-in account changed. Reload the workspace.', 401);
  return result;
}

export default {
  get: (path, config) => request('GET', path, undefined, config),
  post: (path, data, config) => request('POST', path, data, config),
  put: (path, data, config) => request('PUT', path, data, config),
  patch: (path, data, config) => request('PATCH', path, data, config),
  delete: (path, config) => request('DELETE', path, config?.data, config),
};
