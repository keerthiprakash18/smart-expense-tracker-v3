from django.db import migrations


def wipe_all_runtime_data(apps, schema_editor):
    # Delete receipt files from the configured storage before deleting rows.
    try:
        Expense = apps.get_model("expenses", "Expense")
        receipt_field = Expense._meta.get_field("receipt_image")
        storage = receipt_field.storage
        for name in Expense.objects.exclude(receipt_image="").exclude(receipt_image__isnull=True).values_list("receipt_image", flat=True):
            if name:
                try:
                    storage.delete(name)
                except Exception:
                    pass
    except LookupError:
        pass

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
            apps.get_model("expenses", model_name).objects.all().delete()
        except LookupError:
            pass

    for app_label, model_name in [
        ("sessions", "Session"),
        ("token_blacklist", "BlacklistedToken"),
        ("token_blacklist", "OutstandingToken"),
    ]:
        try:
            apps.get_model(app_label, model_name).objects.all().delete()
        except LookupError:
            pass

    apps.get_model("auth", "User").objects.all().delete()


def reverse_noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):
    dependencies = [
        ("expenses", "0013_one_time_full_data_reset"),
    ]

    operations = [
        migrations.RunPython(wipe_all_runtime_data, reverse_noop),
    ]
