from django.core.management import BaseCommand, call_command


class Command(BaseCommand):
    help = "Delete all database rows while keeping the schema and migrations."

    def add_arguments(self, parser):
        parser.add_argument(
            "--confirm",
            default="",
            help="Must be exactly RESET_ALL_DATA.",
        )

    def handle(self, *args, **options):
        if options["confirm"] != "RESET_ALL_DATA":
            self.stderr.write(
                self.style.ERROR(
                    "Refusing to reset. Run with --confirm RESET_ALL_DATA."
                )
            )
            return

        self.stdout.write(
            self.style.WARNING(
                "Resetting ALL database data: users, accounts, transactions, "
                "budgets, tokens, notifications, security settings and related rows."
            )
        )
        call_command("flush", interactive=False, verbosity=1)
        self.stdout.write(self.style.SUCCESS("Database data reset complete."))
