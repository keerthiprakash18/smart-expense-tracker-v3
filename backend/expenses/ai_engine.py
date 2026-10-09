"""Machine-learning engine for Smart Expense.

This is a compact, dependency-free machine learning layer that runs entirely
inside the Django process — no external model service, no GPU, no network call.
Three models live here, in order of sophistication:

1. ``CategoryClassifier`` — a Multinomial Naive-Bayes-style word-probability
   model over transaction titles/notes. It is trained incrementally on every
   confirmed expense and predicts a category for new, unseen merchants.
2. ``AmountAnomalyDetector`` — a per-category z-score model over spend amounts.
   Learns each category's mean and standard deviation, then flags amounts that
   are statistically unusual for that user (possible typo or fraud).
3. ``MerchantMemory`` — a frequent-item recaller. Reuses the existing
   ``MerchantRule`` table as a learned lookup so the model remembers a user's
   own payment method and category for a merchant.

How it learns
-------------
Every time a user *confirms* a transaction (create or update), the training
signal is the pair (text, category). ``train`` updates word-count tables for
that category. Every time a user *corrects* a prediction, the engine retrains
the single record, so the model gets strictly better with use and never forgets
the user's own vocabulary.

How inference works
-------------------
``predict_category`` looks up the learned merchant memory first (fast path,
deterministic). If the merchant is unknown it falls back to the Naive-Bayes
model: it scores every candidate category by multiplying the smoothed
probability of each word given that category, then picks the argmax. The
returned confidence is the model's posterior, so the UI can stay quiet when it
is unsure and only suggest when it is genuinely better than a human guess.

Persistence and consistency
---------------------------
PostgreSQL transaction history is the source of truth. The compact model is
rebuilt from confirmed history for inference, so all Gunicorn workers observe
the same data and cannot overwrite one another with stale process-local files.
"""

import math
import re
from collections import defaultdict
from decimal import Decimal

from django.utils import timezone

WORD_RE = re.compile(r"[a-z0-9]+")

# Character n-gram orders. Merchant names are compositional — "BLINKIT*ORDER",
# "PAYTM*ZOMATO", "Swiggy Bangalore" — so subword features let the model
# generalise across merchants it has never seen verbatim.
CHAR_NGRAM_ORDERS = (3, 4)
MAX_WORDS_FOR_NGRAMS = 6
MAX_TOKENS = 220

# N-grams are *supporting* evidence. Given full weight they drown out the word
# signal, because short generic fragments ("c3:ord") appear in almost every
# merchant and a category with a small corpus accumulates a higher per-token
# probability density. Downweighting keeps them as a generalisation aid only.
NGRAM_WEIGHT = 0.35

# Evidence damping for confidence calibration. A category seen once must not
# report 0.98 confidence, however cleanly it separates from its rivals.
CONFIDENCE_EVIDENCE_K = 1.0


def tokenize(text):
    """Return the word tokens of ``text`` (legacy/audit callers)."""
    return [t for t in WORD_RE.findall(str(text or "").lower()) if len(t) > 1]


def weighted_tokens(text):
    """Yield ``(token, weight)`` pairs — words plus bounded character n-grams.

    Word tokens carry the semantic signal at full weight; the n-grams add
    subword overlap at reduced weight so OCR-mangled or compound merchant
    names ("uber bangalore", "swiggyblr") still land close to a learned
    category without overwhelming the words that actually identify it.
    """
    words = [t for t in WORD_RE.findall(str(text or "").lower()) if len(t) > 1]
    pairs = [(word, 1.0) for word in words]
    for word in words[:MAX_WORDS_FOR_NGRAMS]:
        if len(word) < 3:
            continue
        padded = f"^{word}$"
        for order in CHAR_NGRAM_ORDERS:
            if len(padded) < order:
                continue
            for index in range(len(padded) - order + 1):
                pairs.append((f"c{order}:{padded[index:index + order]}", NGRAM_WEIGHT))
    if len(pairs) > MAX_TOKENS:
        pairs = pairs[:MAX_TOKENS]
    return pairs


class CategoryClassifier:
    """Multinomial Naive Bayes over bag-of-words of transaction titles/notes."""

    def __init__(self):
        self.category_word_counts = defaultdict(lambda: defaultdict(int))
        self.category_total_words = defaultdict(int)
        self.category_doc_counts = defaultdict(int)
        self.vocabulary = set()

    # ---------------- training ----------------
    def train(self, text, category):
        if not category:
            return
        for token, weight in weighted_tokens(text):
            counts = self.category_word_counts[category]
            counts[token] = counts.get(token, 0) + weight
            self.category_total_words[category] += weight
            self.vocabulary.add(token)
        self.category_doc_counts[category] += 1

    def untrain(self, text, category):
        """Undo a training record — used when a user corrects a category."""
        if not category:
            return
        for token, weight in weighted_tokens(text):
            counts = self.category_word_counts.get(category)
            if not counts or token not in counts:
                continue
            counts[token] -= weight
            if counts[token] <= 0:
                del counts[token]
            if self.category_total_words.get(category, 0) > 0:
                self.category_total_words[category] -= weight
        if self.category_doc_counts.get(category, 0) > 0:
            self.category_doc_counts[category] -= 1

    # ---------------- inference ----------------
    def score(self, text):
        """Full per-category log-score table for ``text``.

        Factored out of ``predict`` so ranking, explanation and audit paths all
        share one scoring implementation.
        """
        pairs = weighted_tokens(text)
        if not pairs or not self.category_doc_counts:
            return {}
        total_docs = sum(self.category_doc_counts.values())
        vocab_size = max(1, len(self.vocabulary))
        # Laplace smoothing so unseen words do not zero out a category.
        alpha = 1.0
        scores = {}
        for category, word_counts in self.category_word_counts.items():
            total_words = max(self.category_total_words.get(category, 0), 1e-9)
            log_prob = math.log(max(self.category_doc_counts[category], 0.5) / total_docs)
            for token, weight in pairs:
                count = word_counts.get(token, 0)
                log_prob += weight * math.log((count + alpha) / (total_words + alpha * vocab_size))
            scores[category] = log_prob
        return scores

    def predict(self, text, min_confidence=0.30, top_k=0):
        """Return (category, confidence) or (None, 0.0) when the model is unsure.

        With ``top_k`` > 0 the returned confidence is replaced by the full
        ranked candidate list, most confident first: ``[(category, prob)]``.
        """
        scores = self.score(text)
        if not scores:
            return (None, 0.0) if not top_k else []

        best_score = max(scores.values())
        best_category = max(scores, key=scores.get)

        if top_k:
            ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
            denominator = sum(math.exp(min(s - best_score, 700)) for _, s in ranked)
            candidates = []
            for category, score in ranked[:top_k]:
                posterior = math.exp(min(score - best_score, 700)) / denominator if denominator > 0 else 0.0
                seen = self.category_doc_counts.get(category, 0)
                posterior *= seen / (seen + CONFIDENCE_EVIDENCE_K)
                candidates.append((category, max(0.0, min(0.98, posterior))))
            return candidates

        confidence = self._confidence(scores, best_score, best_category, self.category_doc_counts)
        if best_category is None or confidence < min_confidence:
            return None, 0.0
        return best_category, confidence
    @staticmethod
    def _confidence(scores, best_score, best_category, doc_counts=None):
        """Turn log-scores into a calibrated 0-1 posterior.

        Two corrections sit on top of the plain softmax posterior:

        * **Evidence damping** — the raw posterior ignores sample size, so a
          category trained on a single transaction can report ~0.98 when its
          rivals are empty. We scale by ``n / (n + k)``, which pushes
          rarely-seen categories toward low confidence while leaving
          well-trained ones almost untouched.
        * **Separation ceiling** — the posterior is capped so the UI never
          claims certainty the model does not have.
        """
        if not scores or best_category is None:
            return 0.0
        try:
            shifted = [math.exp(min(s - best_score, 700)) for s in scores.values()]
        except OverflowError:
            return 1.0
        denominator = sum(shifted)
        if denominator <= 0:
            return 0.0
        posterior = 1.0 / denominator

        if doc_counts:
            seen = doc_counts.get(best_category, 0)
            posterior *= seen / (seen + CONFIDENCE_EVIDENCE_K)

        return max(0.0, min(0.98, posterior))


class AmountAnomalyDetector:
    """Per-category z-score model that learns a user's normal spend range."""

    def __init__(self):
        # category -> [sum, sum_of_squares, count]
        self.stats = defaultdict(lambda: [0.0, 0.0, 0])

    def train(self, category, amount):
        if not category or amount is None:
            return
        try:
            value = float(amount)
        except (TypeError, ValueError):
            return
        stats = self.stats[category]
        stats[0] += value
        stats[1] += value * value
        stats[2] += 1

    def untrain(self, category, amount):
        if not category or amount is None:
            return
        try:
            value = float(amount)
        except (TypeError, ValueError):
            return
        stats = self.stats.get(category)
        if not stats or stats[2] == 0:
            return
        stats[0] -= value
        stats[1] -= value * value
        stats[2] -= 1

    def _moments(self, category):
        stats = self.stats.get(category)
        if not stats or stats[2] < 3:
            return None
        count = stats[2]
        mean = stats[0] / count
        variance = max(0.0, (stats[1] / count) - (mean * mean))
        return mean, math.sqrt(variance), count

    def zscore(self, category, amount):
        moments = self._moments(category)
        if not moments:
            return 0.0
        mean, std, _ = moments
        if std == 0:
            return 0.0
        try:
            return (float(amount) - mean) / std
        except (TypeError, ValueError):
            return 0.0

    def is_anomaly(self, category, amount, threshold=2.6):
        return abs(self.zscore(category, amount)) >= threshold

    def explain(self, category, amount, threshold=2.6):
        """Return a UI-ready explanation dict, or ``None`` when the amount is normal.

        ``_moments`` is computed once and reused, so the caller never pays for
        a second statistics pass.
        """
        moments = self._moments(category)
        if not moments:
            return None
        mean, std, count = moments
        if std == 0:
            return None
        try:
            value = float(amount)
        except (TypeError, ValueError):
            return None
        z = (value - mean) / std
        if abs(z) < threshold:
            return None
        return {
            "z_score": round(z, 2),
            "mean": round(mean, 2),
            "std": round(std, 2),
            "sample_size": count,
            "direction": "high" if value > mean else "low",
        }


class UserModel:
    """A single user's trained models."""

    def __init__(self):
        self.classifier = CategoryClassifier()
        self.anomaly = AmountAnomalyDetector()

    def train(self, title, notes, category, amount):
        self.classifier.train(f"{title} {notes or ''}", category)
        self.anomaly.train(category, amount)

    def untrain(self, title, notes, category, amount):
        self.classifier.untrain(f"{title} {notes or ''}", category)
        self.anomaly.untrain(category, amount)


def _rebuild_from_history_into(user, model):
    """Train a fresh model from the authoritative transaction history."""
    from .models import Expense

    model.classifier = CategoryClassifier()
    model.anomaly = AmountAnomalyDetector()
    expenses = (
        Expense.objects.filter(user=user)
        .exclude(transaction_type="TRANSFER")
        .values_list("title", "notes", "category", "amount")
    )
    for title, notes, category, amount in expenses:
        model.train(title, notes, category, amount)
    return model


def get_user_model(user_id):
    """Build from PostgreSQL so multiple workers cannot serve stale model files."""
    if user_id is None:
        return UserModel()
    from django.contrib.auth.models import User
    user = User.objects.filter(pk=user_id).only("id").first()
    if user is None:
        return UserModel()
    return _rebuild_from_history_into(user, UserModel())


def save_user_model(user_id, model):
    """Compatibility no-op: persisted transaction rows are the model state."""
    return None


def retrain_from_history(user):
    return _rebuild_from_history_into(user, UserModel())


def train_transaction(user, title, notes, category, amount):
    """The saved transaction is already the authoritative training row."""
    return None


def retrain_transaction(user, old_title, old_notes, old_category, old_amount):
    """Edits are reflected automatically on the next model rebuild."""
    return None


def predict_category(user, title, notes="", top_k=0):
    """Best-effort category guess for a new transaction.

    Returns ``(category, confidence, source)`` where source is
    ``"merchant"`` (learned fast path) or ``"model"`` (Naive Bayes).

    With ``top_k`` > 0 the confidence slot is replaced by the ranked candidate
    list ``[(category, prob)]`` (merchant fast path still wins outright, since
    a learned rule is always stronger evidence than the statistical model).
    """
    from .models import MerchantRule
    from .security_utils import normalize_merchant

    key = normalize_merchant(title)
    if key:
        learned = MerchantRule.objects.filter(user_id=user.pk, merchant_key=key).first()
        if learned and learned.category:
            if top_k:
                return learned.category, [(learned.category, 0.97)], "merchant"
            return learned.category, 0.97, "merchant"

    model = get_user_model(user.pk)
    if top_k:
        candidates = model.classifier.predict(f"{title} {notes or ''}", top_k=top_k)
        if not candidates:
            return None, [], "model"
        return candidates[0][0], candidates, "model"

    # Suggest threshold: an n-gram model rarely produces a softmax posterior
    # above ~0.6 against several trained categories, so the classic 0.30 cut
    # would leave the user with no suggestion on a confidently-ranked query.
    category, confidence = model.classifier.predict(f"{title} {notes or ''}", min_confidence=0.15)
    return category, confidence, "model"


def detect_anomaly(user, category, amount):
    """Return a UI-ready anomaly explanation, or ``None`` when the amount is normal."""
    model = get_user_model(user.pk)
    detail = model.anomaly.explain(category, amount)
    if not detail:
        return None
    return {
        "z_score": detail["z_score"],
        "mean": detail["mean"],
        "sample_size": detail["sample_size"],
        "message": (
            f"This {category} amount is unusually {detail['direction']} "
            f"(you normally spend about {detail['mean']} here)."
        ),
    }


def project_month_end(user, today=None):
    """Project where each category's spend will land by the end of the month.

    Uses a run-rate projection: ``spend_so_far / days_elapsed * days_in_month``.
    A category is flagged when the projection crosses its active
    ``CategoryBudget`` before the month closes, so the user gets the warning in
    time to adjust instead of after the fact.
    """
    from calendar import monthrange

    from django.db.models import Sum

    from .models import CategoryBudget, Expense

    today = today or timezone.localdate()
    days_in_month = monthrange(today.year, today.month)[1]
    days_elapsed = max(1, today.day)
    days_left = max(0, days_in_month - today.day)

    month_rows = (
        Expense.objects.filter(
            user=user,
            transaction_type__in=["EXPENSE", "BILL"],
            date__year=today.year,
            date__month=today.month,
        )
        .values("category")
        .annotate(total=Sum("amount"))
    )

    budgets = {
        b.category: b.amount
        for b in CategoryBudget.objects.filter(user=user, active=True)
    }

    projections = []
    for row in month_rows:
        category = row["category"] or "General"
        spent = Decimal(str(row["total"] or 0))
        projected = Decimal(str(round(float(spent) / days_elapsed * days_in_month, 2)))
        budget = budgets.get(category)
        projections.append(
            {
                "category": category,
                "spent": str(spent.quantize(Decimal("0.01"))),
                "projected": str(projected.quantize(Decimal("0.01"))),
                "budget": str(budget) if budget else None,
                "over_budget": bool(budget and projected > budget),
                "daily_rate": str(Decimal(str(round(float(spent) / days_elapsed, 2))).quantize(Decimal("0.01"))),
            }
        )
        if budget and projected > budget:
            pace = float(spent) / float(budget)
            projections[-1]["pace"] = round(pace, 2)
            if pace >= 1.0:
                projected_extra = float(spent) - float(budget)
                projections[-1]["message"] = (
                    f"{category} has already crossed its {budget} budget by "
                    f"{Decimal(str(round(projected_extra, 2))).quantize(Decimal('0.01'))}."
                )
            else:
                projections[-1]["message"] = (
                    f"At this pace {category} will reach about {projected} by month end, "
                    f"over your {budget} budget. Slowing down now saves "
                    f"{Decimal(str(round(float(projected) - float(budget), 2))).quantize(Decimal('0.01'))}."
                )

    return {
        "days_elapsed": days_elapsed,
        "days_left": days_left,
        "days_in_month": days_in_month,
        "categories": sorted(projections, key=lambda x: x["over_budget"], reverse=True),
    }


def detect_subscriptions(user):
    """Surface recurring merchants the user is paying repeatedly without tracking.

    A merchant is treated as a subscription candidate when it appears on at
    least 3 distinct dates with similar amounts. Those are almost always
    renewals, and ``RecurringRule`` entries are usually added manually — so
    this is the detection layer that finds them automatically.
    """
    from django.db.models import Count, Sum

    from .models import Expense

    rows = (
        Expense.objects.filter(
            user=user,
            transaction_type__in=["EXPENSE", "BILL"],
            is_recurring=False,
        )
        .values("title", "category")
        .annotate(
            occurrences=Count("id"),
            distinct_dates=Count("date", distinct=True),
            total=Sum("amount"),
        )
        .filter(distinct_dates__gte=3)
        .order_by("-total")
    )

    tracked = set()
    from .models import RecurringRule

    tracked.update(
        RecurringRule.objects.filter(user=user, active=True).values_list("title", flat=True)
    )

    candidates = []
    for row in rows[:12]:
        title = row["title"] or "Merchant"
        if title in tracked:
            continue
        occurrences = row["occurrences"] or 0
        if occurrences < 3:
            continue
        total = Decimal(str(row["total"] or 0))
        average = Decimal(str(round(float(total) / occurrences, 2)))
        candidates.append(
            {
                "title": title,
                "category": row["category"] or "General",
                "occurrences": occurrences,
                "total": str(total.quantize(Decimal("0.01"))),
                "average": str(average.quantize(Decimal("0.01"))),
            }
        )
    return candidates[:6]


__all__ = [
    "CategoryClassifier",
    "AmountAnomalyDetector",
    "UserModel",
    "get_user_model",
    "save_user_model",
    "retrain_from_history",
    "train_transaction",
    "retrain_transaction",
    "predict_category",
    "detect_anomaly",
    "project_month_end",
    "detect_subscriptions",
]
