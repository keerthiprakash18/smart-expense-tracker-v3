from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("expenses", "0019_assistant_wake_token"),
    ]

    operations = [
        migrations.CreateModel(
            name="BankStatementEntry",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("fingerprint", models.CharField(max_length=64)),
                ("imported_at", models.DateTimeField(auto_now_add=True)),
                ("account", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bank_statement_entries", to="expenses.account")),
                ("expense", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="bank_import_entries", to="expenses.expense")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="bank_statement_entries", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ["-imported_at"],
            },
        ),
        migrations.AddConstraint(
            model_name="bankstatemententry",
            constraint=models.UniqueConstraint(
                fields=("user", "account", "fingerprint"),
                name="uniq_bank_statement_entry_user_account_fingerprint",
            ),
        ),
    ]
