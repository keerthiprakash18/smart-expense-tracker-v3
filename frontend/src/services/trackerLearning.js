// A small per-user text classifier rebuilt from the authenticated ledger. No
// external AI service, persistence outside the account, or invented training data.
const tokens = (text) => String(text || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
export function train(rows) {
  const classes = new Map(), merchants = new Map(), vocabulary = new Set();
  for (const row of rows) {
    const category = row.category || 'General';
    const model = classes.get(category) || { documents: 0, words: new Map(), total: 0, amounts: [] };
    model.documents++; model.amounts.push(Number(row.amount));
    for (const word of tokens(`${row.title} ${row.notes || ''}`)) {
      vocabulary.add(word); model.words.set(word, (model.words.get(word) || 0) + 1); model.total++;
    }
    classes.set(category, model);
    const merchant = tokens(row.title).join(' ');
    const votes = merchants.get(merchant) || new Map();
    votes.set(category, (votes.get(category) || 0) + 1); merchants.set(merchant, votes);
  }
  return { classes, merchants, vocabulary, samples: rows.length };
}

export function prediction(model, body) {
  const title = String(body.title || '').trim();
  const words = tokens(`${title} ${body.notes || ''}`);
  const votes = model.merchants.get(tokens(title).join(' '));
  let source = votes ? 'merchant_memory' : 'local_naive_bayes';
  let candidates = [];
  if (votes) {
    const total = [...votes.values()].reduce((sum, n) => sum + n, 0);
    candidates = [...votes].map(([category, n]) => ({ category, confidence: n / total }));
  } else if (words.some((word) => model.vocabulary.has(word))) {
    const scores = [...model.classes].map(([category, c]) => ({ category, score: Math.log(c.documents / model.samples) + words.reduce((n, word) => n + Math.log(((c.words.get(word) || 0) + 1) / (c.total + model.vocabulary.size)), 0) }));
    const max = Math.max(...scores.map((x) => x.score));
    const total = scores.reduce((n, x) => n + Math.exp(x.score - max), 0);
    candidates = scores.map((x) => ({ category: x.category, confidence: Math.exp(x.score - max) / total }));
  } else source = 'insufficient_history';
  candidates.sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category));
  candidates = candidates.slice(0, Math.min(8, Math.max(1, Number(body.top_n) || 3)));
  const result = { title, category: candidates[0]?.category || null, confidence: candidates[0]?.confidence || 0, candidates, source, learned: candidates.length > 0 };
  const amounts = model.classes.get(result.category)?.amounts || [];
  if (amounts.length >= 5 && Number(body.amount) > 0) {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((n, a) => n + (a - mean) ** 2, 0) / amounts.length);
    if (Number(body.amount) > mean + Math.max(3 * sd, mean)) result.anomaly = { severity: 'warning', message: 'This amount is unusually high for your recorded category history.', mean, amount: Number(body.amount) };
  }
  return result;
}

export function learningResponse(route, method, body, rows, rules) {
  const model = train(rows);
  const status = { training_samples: model.samples, learned_categories: model.classes.size, vocabulary_size: model.vocabulary.size, merchant_rules: model.merchants.size, ready: model.samples >= 5, note: 'Local suggestions are rebuilt from your own saved transactions.' };
  if (route === 'v3/ai/status' && method === 'GET') return status;
  if (route === 'v3/ai/retrain' && method === 'POST') return { ...status, message: 'Model rebuilt from your transaction history.' };
  if (route === 'v3/ai/predict' && method === 'POST') return prediction(model, body);
  if (route === 'v3/ai/subscriptions' && method === 'GET') {
    const groups = new Map();
    for (const row of rows.filter((r) => ['EXPENSE', 'BILL'].includes(r.transaction_type))) {
      const key = tokens(row.title).join(' '); const group = groups.get(key) || [];
      group.push(row); groups.set(key, group);
    }
    const tracked = new Set(rules.map((r) => tokens(r.title).join(' ')));
    const candidates = [];
    for (const [key, group] of groups) {
      if (tracked.has(key) || new Set(group.map((r) => r.date)).size < 3) continue;
      const average = group.reduce((n, r) => n + Number(r.amount), 0) / group.length;
      if (group.some((r) => Math.abs(Number(r.amount) - average) > average * .15)) continue;
      candidates.push({ title: group[0].title, category: group[0].category, average: Math.round(average * 100) / 100, occurrences: group.length });
    }
    return { candidates };
  }
  throw new Error('Unknown learning operation.');
}
