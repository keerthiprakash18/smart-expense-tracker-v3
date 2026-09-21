import re

from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import Expense, MerchantRule, SecuritySettings


def normalize_merchant(value):
    value = re.sub(r"[^a-z0-9 ]+", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", value).strip()[:160]


@receiver(post_save, sender=Expense)
def learn_scanned_merchant(sender, instance, created, **kwargs):
    if not instance.user_id or not instance.title:
        return
    if not (instance.receipt_image or instance.ocr_confidence is not None):
        return
    key = normalize_merchant(instance.title)
    if not key:
        return
    rule, was_created = MerchantRule.objects.get_or_create(
        user_id=instance.user_id,
        merchant_key=key,
        defaults={
            "merchant_label": instance.title[:160],
            "category": instance.category or "General",
            "payment_method": instance.payment_method or "UPI",
            "use_count": 1,
        },
    )
    if not was_created:
        rule.merchant_label = instance.title[:160]
        rule.category = instance.category or rule.category
        rule.payment_method = instance.payment_method or rule.payment_method
        rule.use_count += 1
        rule.save(update_fields=["merchant_label", "category", "payment_method", "use_count", "updated_at"])


@receiver(post_save, sender=SecuritySettings)
def keep_security_record(sender, instance, **kwargs):
    # Signal intentionally exists as a stable hook for future security audit logging.
    return None
