// Deterministic, local-only intent parsing. No network/provider calls and no SQL.
// The database independently validates every staged payload and confirmation.
const CATEGORY_WORDS = {
  Food: ['food', 'lunch', 'dinner', 'breakfast', 'coffee', 'tea', 'snack', 'swiggy', 'zomato', 'சாப்பாடு', 'உணவு', 'லஞ்ச்', 'டின்னர்', 'காபி', 'டீ'],
  Transport: ['petrol', 'fuel', 'diesel', 'uber', 'ola', 'bus', 'train', 'auto', 'bike', 'transport', 'பெட்ரோல்', 'டீசல்', 'பஸ்', 'ரயில்', 'ஆட்டோ'],
  Shopping: ['amazon', 'flipkart', 'shopping', 'headphone', 'headphones', 'clothes', 'dress', 'order', 'வாங்கினேன்', 'வாங்குனேன்', 'ஷாப்பிங்'],
  'Bills & Utilities': ['bill', 'electricity', 'eb bill', 'recharge', 'mobile', 'internet', 'wifi', 'rent', 'பில்', 'ரீசார்ஜ்', 'கரண்ட்', 'வாடகை'],
  Health: ['health', 'medicine', 'medical', 'doctor', 'hospital', 'tablet', 'மருந்து', 'டாக்டர்'],
  Entertainment: ['movie', 'netflix', 'prime', 'spotify', 'game', 'cinema', 'படம்', 'சினிமா'],
  Education: ['course', 'book', 'college', 'exam', 'education', 'fees', 'படிப்பு', 'கல்லூரி', 'பீஸ்'],
  Salary: ['salary', 'paycheck', 'wage', 'சம்பளம்'],
};
const EXPENSE = ['spend', 'spent', 'expense', 'paid', 'bought', 'buy', 'purchase', 'add pann', 'add pannu', 'செலவு', 'வாங்கினேன்', 'வாங்குனேன்', 'கொடுத்தேன்', 'போட்டேன்'];
const INCOME = ['salary', 'income', 'credited', 'credit aachu', 'received', 'deposit', 'earned', 'சம்பளம்', 'வருமானம்', 'கிரெடிட்', 'வந்தது'];
const UPDATE = ['update', 'change', 'correct', 'instead', 'illa', 'make it', 'இல்ல', 'மாற்று', 'கரெக்ட்'];
const DELETE = ['delete', 'remove', 'erase', 'நீக்கு', 'டெலீட்'];
const QUERY = ['how much', 'evlo', 'எவ்வளவு', 'show', 'tell', 'summary', 'overview', 'balance', 'budget', 'spent this'];
const NOTES = ['note pannu', 'note panniko', 'note pannunga', 'note this', 'note that', 'make a note', 'remember this', 'remember that', 'save this note', 'write this down', 'நோட் பண்ணு', 'நோட் பண்ணிக்கோ', 'குறிச்சு வை', 'நினைவில் வை'];
const MERCHANTS = ['swiggy', 'zomato', 'amazon', 'flipkart', 'uber', 'ola', 'netflix', 'spotify'];
const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function has(text, word) {
  // ASCII word boundaries still permit English stems with Tamil suffixes:
  // "foodக்கு", without matching "tea" inside "instead".
  return /^[a-z0-9 ]+$/i.test(word)
    ? new RegExp(`(?:^|[^a-z])${escapeRegex(word)}(?=$|[^a-z])`, 'i').test(text)
    : text.toLowerCase().includes(word.toLowerCase());
}
const any = (text, words) => words.some((word) => has(text, word));

export function detectAssistantLanguage(text) {
  return /[\u0B80-\u0BFF]/.test(text) ? (/[a-z]/i.test(text) ? 'MIXED' : 'TA') : 'EN';
}

function decimalMoney(raw, suffix) {
  if (raw.startsWith('-')) return null;
  const normalized = raw.replace(/^\+/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  if (whole.length > 12 || fraction.length > 8) return null;
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * (suffix ? 100000n : 100n);
  const cents = numerator / scale + (numerator % scale * 2n >= scale ? 1n : 0n);
  if (cents <= 0n || cents > 999999999999n) return null;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function parseAssistantAmount(text, { correction = false } = {}) {
  let value = text.replace(/[௦-௯]/g, (digit) => String(digit.charCodeAt(0) - 0x0be6));
  if (/\b(?:NaN|infinity|infinite)\b|\d(?:\.\d+)?e[+-]?\d/i.test(value)) return null;
  value = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '')
    .replace(/(?:transaction\s*#?|#)\s*\d+/gi, '');
  const matches = [...value.matchAll(/(?<![\p{L}\p{N}.])([+-]?\d[\d,]*(?:\.\d+)?)\s*([kK]?)(?![\p{L}\p{N}.])/gu)];
  if (!matches.length || (!correction && matches.length !== 1)) return null;
  return decimalMoney(matches.at(-1)[1], matches.at(-1)[2]);
}

const iso = (date) => date.toISOString().slice(0, 10);
function day(value) {
  const result = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(result.valueOf()) || iso(result) !== value) throw new Error('Invalid assistant date.');
  return result;
}
const addDays = (value, days) => new Date(value.valueOf() + days * 86400000);

export function assistantPeriod(text, today = iso(new Date())) {
  const now = day(today);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (any(text, ['yesterday', 'nethu', 'netthu', 'நேத்து', 'நேற்று'])) {
    return { start: iso(addDays(now, -1)), end: iso(addDays(now, -1)), label: 'yesterday' };
  }
  if (any(text, ['last month', 'previous month', 'pona maasam', 'கடந்த மாத'])) {
    const end = addDays(first, -1);
    return { start: iso(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))), end: iso(end), label: 'last month' };
  }
  if (any(text, ['this week', 'indha vaaram', 'இந்த வார'])) {
    return { start: iso(addDays(now, -(now.getUTCDay() + 6) % 7)), end: today, label: 'this week' };
  }
  if (any(text, ['today', 'innaiku', 'inniku', 'இன்னைக்கு', 'இன்று'])) return { start: today, end: today, label: 'today' };
  return { start: iso(first), end: today, label: 'this month' };
}

function categoryFor(text, categories, type) {
  const actual = categories.filter((row) => (row.category_type || 'EXPENSE') === type).map((row) => row.name).filter(Boolean);
  const named = [...actual].sort((a, b) => b.length - a.length).find((name) => has(text, name));
  if (named) return named;
  if (type === 'INCOME' && any(text, INCOME)) return actual.find((name) => has(name, 'salary')) || 'Salary';
  const ranked = Object.entries(CATEGORY_WORDS).map(([name, words]) => [name, words.filter((word) => has(text, word)).length]).sort((a, b) => b[1] - a[1]);
  const best = ranked[0]?.[1] ? ranked[0][0] : null;
  return actual.find((name) => name.toLowerCase() === best?.toLowerCase()) || best;
}

function titleFor(text, category, type) {
  const word = MERCHANTS.find((item) => has(text, item))
    || (CATEGORY_WORDS[category] || []).find((item) => item !== category.toLowerCase() && has(text, item));
  if (word) return word[0].toUpperCase() + word.slice(1);
  return category || (type === 'INCOME' ? 'Income' : 'Expense');
}

function noteContent(text) {
  let value = text;
  for (const phrase of NOTES) value = value.replace(new RegExp(escapeRegex(phrase), 'ig'), '').trim();
  return value.replace(/^[\s,:.-]+|[\s,:.-]+$/g, '');
}

const COPY_FIELDS = ['amount', 'category', 'title', 'transaction_type', 'date', 'period_start', 'period_end', 'period_label', 'language', 'account'];

export function parseAssistantCommand(utterance, { categories = [], recent = null, today = iso(new Date()), now = new Date() } = {}) {
  const text = clean(utterance);
  if (!text || text.length > 600) throw new Error('Enter an assistant request between 1 and 600 characters.');
  const language = detectAssistantLanguage(text);
  const period = assistantPeriod(text, today);
  const correcting = any(text, UPDATE);
  const amount = parseAssistantAmount(text, { correction: correcting });
  let intent; let confidence;
  if (any(text, NOTES)) { intent = 'CREATE_NOTE'; confidence = 0.99; }
  else if (any(text, DELETE)) { intent = 'DELETE_TRANSACTION'; confidence = 0.9; }
  else if (correcting) { intent = 'UPDATE_TRANSACTION'; confidence = 0.86; }
  else if (any(text, ['compare', 'comparison', 'ஒப்பிட'])) { intent = 'COMPARE_SPENDING'; confidence = 0.96; }
  else if (any(text, ['budget', 'பட்ஜெட்'])) { intent = 'GET_BUDGET_STATUS'; confidence = 0.95; }
  else if (any(text, ['balance', 'பேலன்ஸ்'])) { intent = 'GET_BALANCE'; confidence = 0.95; }
  else if (any(text, QUERY)) {
    const category = categoryFor(text, categories, 'EXPENSE');
    intent = category ? 'GET_CATEGORY_SPENDING'
      : any(text, ['financial summary', 'overview']) ? 'GET_FINANCIAL_SUMMARY'
        : has(text, 'summary') ? 'GET_SPENDING_SUMMARY'
          : ['today', 'yesterday'].includes(period.label) ? 'GET_DAILY_SPENDING'
            : period.label === 'this week' ? 'GET_WEEKLY_SPENDING' : 'GET_MONTHLY_SPENDING';
    confidence = 0.9;
  } else if (any(text, INCOME)) { intent = 'CREATE_INCOME'; confidence = amount ? 0.93 : 0.7; }
  else if (any(text, EXPENSE) || amount) { intent = 'CREATE_EXPENSE'; confidence = amount ? 0.9 : 0.62; }
  else { intent = 'GET_FINANCIAL_SUMMARY'; confidence = 0.48; }

  if (['UPDATE_TRANSACTION', 'DELETE_TRANSACTION'].includes(intent) && /\b(?:all|every|everything)\b|எல்லா|அனைத்து/i.test(text)) {
    return { unsupported: 'Bulk transaction changes are not supported. Identify one transaction by title, category, or date.' };
  }
  const type = intent === 'CREATE_INCOME' ? 'INCOME' : 'EXPENSE';
  const category = categoryFor(text, categories, type);
  const explicitDate = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (explicitDate) day(explicitDate);
  const payload = {
    amount, category, title: titleFor(text, category, type), transaction_type: type,
    date: explicitDate || (period.label === 'yesterday' ? period.start : today),
    period_start: explicitDate || period.start, period_end: explicitDate || period.end,
    period_label: period.label, language,
  };
  if (intent === 'CREATE_NOTE') payload.note_content = noteContent(text);
  if (['UPDATE_TRANSACTION', 'DELETE_TRANSACTION'].includes(intent)) {
    payload.corrected_amount = amount;
    payload.merchant = MERCHANTS.find((word) => has(text, word)) || (CATEGORY_WORDS[category] || []).find((word) => has(text, word) && word !== category?.toLowerCase()) || null;
    payload.filter_date = Boolean(explicitDate) || ['today', 'yesterday'].includes(period.label);
    payload.use_recent = correcting && text.split(' ').length <= 4 || /\b(?:that|last|it)\b/i.test(text);
    const target = text.match(/(?:transaction\s*#?|#)\s*(\d+)/i)?.[1];
    if (target) payload.target_transaction_id = target;
  }
  if (intent === 'CREATE_EXPENSE' && !category) confidence = Math.min(confidence, 0.74);

  // Clarifications copy only known fields and never turn a budget/query/note into
  // a financial write. The database rechecks ownership and superseded status.
  const oldPayload = recent?.payload || recent?.safe_payload;
  const age = now.valueOf() - new Date(recent?.created_at || 0).valueOf();
  if (oldPayload && ['PENDING', 'NEEDS_CLARIFICATION'].includes(recent.status)
    && ['CREATE_EXPENSE', 'CREATE_INCOME'].includes(recent.intent) && age >= 0 && age <= 600000
    && !any(text, [...QUERY, ...NOTES, ...DELETE, 'compare', 'ஒப்பிட'])) {
    const oldType = recent.intent === 'CREATE_INCOME' ? 'INCOME' : 'EXPENSE';
    const followCategory = categoryFor(text, categories, oldType);
    const amountOnly = /^[₹$€£\s\d.,+kK]+$/.test(text);
    const categoryOnly = Boolean(followCategory) && text.split(' ').length <= 3 && !any(text, [...EXPENSE, ...INCOME]) && !amount;
    if (correcting || amountOnly || categoryOnly) {
      const merged = Object.fromEntries(COPY_FIELDS.filter((key) => Object.hasOwn(oldPayload, key)).map((key) => [key, oldPayload[key]]));
      // An invalid correction must request a new amount, never silently reuse
      // the previous amount (which could otherwise become Quick Add eligible).
      if (correcting || amountOnly) merged.amount = amount;
      if (followCategory && (categoryOnly || !merged.category)) {
        merged.category = followCategory;
        if (!merged.title || ['Expense', 'General'].includes(merged.title)) merged.title = titleFor(text, followCategory, oldType);
      }
      merged.language = language;
      return { intent: recent.intent, confidence: merged.amount && (merged.category || oldType === 'INCOME') ? 0.94 : 0.7,
        payload: merged, supersedes: recent.id };
    }
  }
  return { intent, confidence, payload, supersedes: null };
}
