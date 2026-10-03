import api from './api';

/**
 * On-device AI client.
 *
 * Every call here hits the per-user models in backend/expenses/ai_engine.py.
 * Those models train on each transaction the user confirms and never leave the
 * server, so there is no third-party call, no API key and no per-request cost.
 */

const PREDICT_DEBOUNCE_MS = 350;

let predictTimer = null;
let predictToken = 0;

/**
 * Ask the engine for category candidates for a transaction that has not been
 * classified yet. Returns up to `topN` ranked guesses; merchant memory wins
 * outright when the user has paid this merchant before.
 */
export async function predictCategory({ title, notes = '', amount = null, topN = 3, transactionType = null } = {}) {
  const trimmed = String(title || '').trim();
  if (!trimmed) return null;

  const payload = { title: trimmed, notes: String(notes || ''), top_n: topN };
  if (amount !== null && amount !== undefined && amount !== '' && Number(amount) > 0) {
    payload.amount = amount;
  }
  if (transactionType) payload.transaction_type = transactionType;

  try {
    const response = await api.post('/api/v3/ai/predict/', payload, { timeout: 20000 });
    return response.data || null;
  } catch {
    return null;
  }
}

/**
 * Debounced variant for typing in a form. Resolves to null for an empty title,
 * an aborted request or a network failure — callers must treat null as "no
 * opinion" and never block the user on it.
 *
 * The timer is paired with a monotonic token: a slow request from an earlier
 * keystroke must never overwrite the result of the latest one.
 */
export function predictCategoryDebounced(params, callback) {
  if (predictTimer) clearTimeout(predictTimer);
  const title = String(params?.title || '').trim();
  if (!title) {
    callback(null);
    return () => {};
  }
  const token = ++predictToken;
  predictTimer = setTimeout(() => {
    predictTimer = null;
    predictCategory(params)
      .then((data) => {
        if (token === predictToken) callback(data);
      })
      .catch(() => {
        if (token === predictToken) callback(null);
      });
  }, PREDICT_DEBOUNCE_MS);
  return () => {
    if (predictTimer) {
      clearTimeout(predictTimer);
      predictTimer = null;
    }
    predictToken++;
  };
}

/** How much the on-device model has learned about this user. */
export async function getAIStatus() {
  try {
    const response = await api.get('/api/v3/ai/status/', { timeout: 15000 });
    return response.data || null;
  } catch {
    return null;
  }
}

/** Rebuild the model from the user's full transaction history. */
export async function retrainModel() {
  try {
    const response = await api.post('/api/v3/ai/retrain/', {}, { timeout: 60000 });
    return response.data || null;
  } catch {
    return null;
  }
}

/** Run-rate projection of where each category lands by month end. */
export async function getForecast() {
  try {
    const response = await api.get('/api/v3/ai/forecast/', { timeout: 15000 });
    return response.data || null;
  } catch {
    return null;
  }
}

/** Recurring merchants the user pays repeatedly but does not track. */
export async function getSubscriptionCandidates() {
  try {
    const response = await api.get('/api/v3/ai/subscriptions/', { timeout: 15000 });
    return response.data?.candidates || [];
  } catch {
    return [];
  }
}

export { PREDICT_DEBOUNCE_MS };
