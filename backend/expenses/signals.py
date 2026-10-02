from django.db.models.signals import post_delete, post_save, pre_save
from django.dispatch import receiver

from .models import Expense, MerchantRule, SecuritySettings
from .security_utils import normalize_merchant


@receiver(pre_save, sender=Expense)
def capture_expense_before_change(sender, instance, **kwargs):
    """Remember the previous category/amount so the ML model can unlearn it."""
    if not instance.pk:
        instance._pre_change_snapshot = None
        return
    try:
        existing = Expense.objects.get(pk=instance.pk)
    except Expense.DoesNotExist:
        instance._pre_change_snapshot = None
        return
    instance._pre_change_snapshot = (
        existing.title,
        existing.notes,
        existing.category,
        existing.amount,
    )


@receiver(post_save, sender=Expense)
def learn_scanned_merchant(sender, instance, created, **kwargs):
    if not instance.user_id or not instance.title:
        return

    # ``post_save`` fires after the row is written, but not necessarily after a
    # cascading parent delete has finished; resolve the user defensively and
    # bail out if it no longer exists rather than raising mid-signal.
    from django.contrib.auth.models import User

    user = User.objects.filter(pk=instance.user_id).only("id").first()
    if user is None:
        return

    # Keep merchant memory (fast lookup) in sync. This used to fire only for
    # scanned receipts, which meant manually typed transactions trained the
    # statistical model but never the fast path — so manual users got a
    # strictly worse predictor than OCR users. Every confirmed transaction is
    # evidence now.
    key = normalize_merchant(instance.title)
    if key:
        rule, was_created = MerchantRule.objects.get_or_create(
            user_id=user.pk,
            merchant_key=key,
            defaults={
                "merchant_label": instance.title[:160],
                "category": instance.category or "General",
                "payment_method": instance.payment_method or "UPI",
                "use_count": 1,
            },
        )
        if not was_created:
            # Only accept a stronger signal: a category the user has now
            # chosen explicitly, or a payment method that was previously unset.
            if instance.category and instance.category != rule.category:
                rule.category = instance.category
            if instance.payment_method and not rule.payment_method:
                rule.payment_method = instance.payment_method
            rule.merchant_label = instance.title[:160]
            rule.use_count += 1
            rule.save(update_fields=["merchant_label", "category", "payment_method", "use_count", "updated_at"])

    # Incremental ML: remove the stale record, then learn the corrected one.
    if instance.transaction_type != "TRANSFER":
        from . import ai_engine

        previous = getattr(instance, "_pre_change_snapshot", None)
        if previous:
            ai_engine.retrain_transaction(user, *previous)
        ai_engine.train_transaction(
            user, instance.title, instance.notes, instance.category, instance.amount
        )


@receiver(post_delete, sender=Expense)
def forget_deleted_expense(sender, instance, **kwargs):
    # Use user_id, not instance.user. During a cascade delete (e.g. the user
    # is deleted) the related user row is already gone, so accessing
    # instance.user raises User.DoesNotExist from inside the delete collector.
    if not instance.user_id or instance.transaction_type == "TRANSFER":
        return
    from . import ai_engine
    from django.contrib.auth.models import User

    user = User.objects.filter(pk=instance.user_id).only("id").first()
    if user is None:
        return

    ai_engine.retrain_transaction(
        user, instance.title, instance.notes, instance.category, instance.amount
    )


@receiver(post_save, sender=SecuritySettings)
def keep_security_record(sender, instance, **kwargs):
    # Signal intentionally exists as a stable hook for future security audit logging.
    return None
