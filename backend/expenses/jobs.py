"""Lightweight periodic finance jobs.

Recurring transactions and notification synthesis used to run as blocking
POSTs on every page load, which turned a read-only render into several writes.
This module performs the same work on a single background thread, driven by the
app startup signal, so API reads stay cheap and rules still fire on time.
"""

import logging
import os
import sys
import threading
import time

from django.db import transaction

logger = logging.getLogger("smart_expense.jobs")

_JOB_INTERVAL_SECONDS = 60 * 30  # twice an hour is enough for due-date work.
_JOB_LOCK = threading.Lock()
_JOB_THREAD = None
_JOB_STARTED = False


def _process_user(user_id):
    """Process one user's due rules and notifications in its own transaction."""
    from django.contrib.auth.models import User

    from .v3_views import process_due_recurring, sync_notifications

    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return

    try:
        with transaction.atomic():
            process_due_recurring(user)
    except Exception:
        logger.exception("Recurring processing failed for user %s", user.username)

    try:
        sync_notifications(user)
    except Exception:
        logger.exception("Notification sync failed for user %s", user.username)


def run_finance_jobs():
    """One pass over all users with due recurring rules or pending alerts."""
    from django.contrib.auth.models import User

    try:
        user_ids = list(User.objects.values_list("id", flat=True))
    except Exception:
        logger.exception("Finance job could not enumerate users")
        return

    for user_id in user_ids:
        _process_user(user_id)


def _job_loop():
    while True:
        try:
            run_finance_jobs()
        except Exception:
            logger.exception("Finance job loop crashed; will retry next tick")
        time.sleep(_JOB_INTERVAL_SECONDS)


def start_background_jobs():
    """Idempotently starts the periodic finance worker thread.

    The thread is daemonised, so it is not a correctness problem if it starts
    before migrations have run in a one-off management command — the loop
    catches the resulting database error and retries on the next tick. But
    starting it during ``manage.py migrate`` or a data-only command is pure
    noise, so it is skipped for those two entry points.
    """
    global _JOB_THREAD, _JOB_STARTED

    if os.environ.get("RUN_MAIN") != "true" and "migrate" in sys.argv[:2]:
        return

    with _JOB_LOCK:
        if _JOB_STARTED:
            return
        _JOB_STARTED = True
        _JOB_THREAD = threading.Thread(target=_job_loop, daemon=True, name="smart-expense-jobs")
        _JOB_THREAD.start()
        logger.info("Smart Expense background finance jobs started (every %ss)", _JOB_INTERVAL_SECONDS)


__all__ = ["run_finance_jobs", "start_background_jobs"]
