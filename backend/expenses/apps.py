from django.apps import AppConfig


class ExpensesConfig(AppConfig):
    name = "expenses"

    def ready(self):
        from . import signals  # noqa: F401

        # Keeps recurring transactions and notifications current without making
        # ordinary API reads perform writes. Safe to call repeatedly.
        from .jobs import start_background_jobs

        start_background_jobs()
