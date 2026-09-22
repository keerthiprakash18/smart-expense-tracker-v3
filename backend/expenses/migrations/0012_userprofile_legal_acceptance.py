from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("expenses", "0011_securitysettings_recovery_codes")]
    operations = [
        migrations.AddField(model_name="userprofile", name="privacy_accepted_at", field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name="userprofile", name="terms_accepted_at", field=models.DateTimeField(blank=True, null=True)),
    ]
