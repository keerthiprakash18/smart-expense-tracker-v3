from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("expenses", "0010_v3_finance_features"),
    ]

    operations = [
        migrations.AddField(
            model_name="securitysettings",
            name="recovery_codes",
            field=models.TextField(blank=True, default="[]"),
        ),
    ]
