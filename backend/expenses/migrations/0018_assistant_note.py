from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("expenses", "0017_assistant_background_wake"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AssistantNote",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("content", models.TextField()),
                ("source", models.CharField(choices=[("VOICE_WAKE", "Background voice wake"), ("VOICE_APP", "In-app voice"), ("TEXT", "Text")], default="TEXT", max_length=20)),
                ("is_done", models.BooleanField(default=False)),
                ("reminder_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="assistant_notes", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at", "-id"]},
        ),
        migrations.AddIndex(
            model_name="assistantnote",
            index=models.Index(fields=["user", "is_done", "-created_at"], name="assist_note_user_idx"),
        ),
    ]
