from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("expenses", "0016_ai_finance_assistant"),
    ]

    operations = [
        migrations.AddField(
            model_name="assistantprofile",
            name="background_wake_enabled",
            field=models.BooleanField(default=False),
        ),
    ]
