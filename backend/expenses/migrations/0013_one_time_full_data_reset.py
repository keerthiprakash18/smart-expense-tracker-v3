from django.db import migrations


def wipe_all_user_data(apps, schema_editor):
    expense_models = [
        "DebtPayment",
        "CreditCardActivity",
        "Expense",
        "AccountTransfer",
        "CategoryBudget",
        "RecurringRule",
        "MerchantRule",
        "AppNotification",
        "Bill",
        "SavingsGoal",
        "MoneyDebt",
        "CreditCard",
        "Category",
        "Account",
        "SecurityCode",
        "SecuritySettings",
        "UserProfile",
    ]

    for model_name in expense_models:
        try:
            model = apps.get_model("expenses", model_name)
            model.objects.all().delete()
        except LookupError:
            pass

    try:
        session = apps.get_model("sessions", "Session")
        session.objects.all().delete()
    except LookupError:
        pass

    try:
        blacklisted = apps.get_model("token_blacklist", "BlacklistedToken")
        blacklisted.objects.all().delete()
    except LookupError:
        pass

    try:
        outstanding = apps.get_model("token_blacklist", "OutstandingToken")
        outstanding.objects.all().delete()
    except LookupError:
        pass

    user = apps.get_model("auth", "User")
    user.objects.all().delete()


def reverse_noop(apps, schema_editor):
    # Intentional one-time destructive reset; data cannot be reconstructed.
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("expenses", "0012_userprofile_legal_acceptance"),
    ]

    operations = [
        migrations.RunPython(wipe_all_user_data, reverse_noop),
    ]
