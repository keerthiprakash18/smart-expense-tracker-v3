"""Run the periodic finance jobs once and report what happened.

Usage:
    python manage.py run_finance_jobs

Useful as a deploy/runbook smoke test and as an alternative to the internal
thread when a deployment prefers cron-based scheduling.
"""

from django.core.management import BaseCommand


class Command(BaseCommand):
    help = "Process due recurring transactions and synthesize notifications for every user."

    def handle(self, *args, **options):
        from expenses.jobs import run_finance_jobs

        run_finance_jobs()
        self.stdout.write(self.style.SUCCESS("Finance jobs completed."))
