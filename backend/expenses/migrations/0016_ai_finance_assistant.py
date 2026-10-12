import decimal
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("expenses", "0015_alter_expense_category_alter_expense_date"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AssistantProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("assistant_name", models.CharField(default="Nova", max_length=40)),
                ("language", models.CharField(choices=[("AUTO", "Auto detect"), ("EN", "English"), ("TA", "Tamil")], default="AUTO", max_length=10)),
                ("voice_responses", models.BooleanField(default=True)),
                ("personality", models.CharField(choices=[("FRIENDLY", "Friendly"), ("PROFESSIONAL", "Professional"), ("MINIMAL", "Minimal")], default="FRIENDLY", max_length=20)),
                ("confirmation_mode", models.CharField(choices=[("SMART", "Smart confirmation"), ("ALWAYS", "Always confirm")], default="SMART", max_length=20)),
                ("quick_add", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_profile", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name="AssistantCommand",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("client_request_id", models.UUIDField()),
                ("intent", models.CharField(max_length=40)),
                ("safe_payload", models.JSONField(blank=True, default=dict)),
                ("result_payload", models.JSONField(blank=True, default=dict)),
                ("confidence", models.DecimalField(decimal_places=3, default=decimal.Decimal("0.000"), max_digits=4)),
                ("status", models.CharField(choices=[("PENDING", "Pending confirmation"), ("NEEDS_CLARIFICATION", "Needs clarification"), ("COMPLETED", "Completed"), ("CANCELLED", "Cancelled"), ("FAILED", "Failed")], default="PENDING", max_length=24)),
                ("requires_confirmation", models.BooleanField(default=True)),
                ("response_text", models.TextField(blank=True, default="")),
                ("fingerprint", models.CharField(blank=True, db_index=True, default="", max_length=64)),
                ("utterance_digest", models.CharField(blank=True, default="", max_length=64)),
                ("executed_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("transaction", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="assistant_commands", to="expenses.expense")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_commands", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
        migrations.AddConstraint(
            model_name="assistantcommand",
            constraint=models.UniqueConstraint(fields=("user", "client_request_id"), name="uniq_user_assistant_request"),
        ),
        migrations.AddIndex(
            model_name="assistantcommand",
            index=models.Index(fields=["user", "status", "-created_at"], name="assist_user_status_idx"),
        ),
    ]
