"""Periodic finance jobs executed by the platform scheduler."""

import logging

from django.db import transaction

logger = logging.getLogger("smart_expense.jobs")


def _process_user(user_id):
    from django.contrib.auth.models import User
    from .v3_views import process_due_recurring, sync_notifications

    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return

    try:
        process_due_recurring(user)
    except Exception:
        logger.exception("Recurring processing failed for user %s", user.username)

    try:
        with transaction.atomic():
            sync_notifications(user)
    except Exception:
        logger.exception("Notification sync failed for user %s", user.username)


def run_finance_jobs():
    from django.contrib.auth.models import User

    for user_id in User.objects.values_list("id", flat=True).iterator(chunk_size=500):
        _process_user(user_id)


__all__ = ["run_finance_jobs"]
