from django.contrib import admin

from .models import (
    Account, AccountTransfer, AppNotification, Bill, Category, CategoryBudget,
    CreditCard, CreditCardActivity, DebtPayment, Expense, MerchantRule, MoneyDebt,
    RecurringRule, SavingsGoal, SecurityCode, SecuritySettings, UserProfile,
)


class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "phone", "country", "currency", "monthly_budget", "savings_goal")
    search_fields = ("user__username", "user__email", "phone")


class AccountAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "account_type", "balance", "created_at")
    list_filter = ("account_type",)
    search_fields = ("name", "user__username")


class ExpenseAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "title", "amount", "category", "transaction_type", "payment_method", "date")
    list_filter = ("transaction_type", "category", "payment_method", "date")
    search_fields = ("title", "user__username", "category")
    date_hierarchy = "date"


class CategoryAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "category_type", "color")
    list_filter = ("category_type",)
    search_fields = ("name", "user__username")


class BillAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "title", "amount", "due_date", "is_paid", "is_recurring")
    list_filter = ("is_paid", "is_recurring")
    search_fields = ("title", "user__username")
    date_hierarchy = "due_date"


class SavingsGoalAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "target_amount", "current_amount", "target_date")
    search_fields = ("name", "user__username")


class MoneyDebtAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "person_name", "direction", "amount", "amount_paid", "status", "due_date")
    list_filter = ("direction", "status")
    search_fields = ("person_name", "user__username")


class DebtPaymentAdmin(admin.ModelAdmin):
    list_display = ("id", "debt", "amount", "payment_date")
    date_hierarchy = "payment_date"


class AccountTransferAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "from_account", "to_account", "amount", "date")
    date_hierarchy = "date"


class CategoryBudgetAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "category", "amount", "period", "active")
    list_filter = ("period", "active")
    search_fields = ("category", "user__username")


class RecurringRuleAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "title", "amount", "transaction_type", "frequency", "next_run", "active")
    list_filter = ("frequency", "transaction_type", "active")
    search_fields = ("title", "user__username")
    date_hierarchy = "next_run"


class MerchantRuleAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "merchant_label", "category", "payment_method", "use_count", "updated_at")
    search_fields = ("merchant_label", "category", "user__username")


class CreditCardAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "last4", "credit_limit", "outstanding", "statement_day", "due_day", "active")
    list_filter = ("active",)


class CreditCardActivityAdmin(admin.ModelAdmin):
    list_display = ("id", "card", "activity_type", "amount", "date")
    list_filter = ("activity_type",)
    date_hierarchy = "date"


class AppNotificationAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "kind", "title", "is_read", "due_date", "created_at")
    list_filter = ("kind", "is_read")
    search_fields = ("title", "user__username")
    date_hierarchy = "created_at"


class SecuritySettingsAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "email_verified", "two_factor_enabled", "updated_at")
    list_filter = ("email_verified", "two_factor_enabled")


class SecurityCodeAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "purpose", "expires_at", "consumed_at")
    list_filter = ("purpose",)
    date_hierarchy = "expires_at"


admin.site.register(UserProfile, UserProfileAdmin)
admin.site.register(Account, AccountAdmin)
admin.site.register(Expense, ExpenseAdmin)
admin.site.register(Category, CategoryAdmin)
admin.site.register(Bill, BillAdmin)
admin.site.register(SavingsGoal, SavingsGoalAdmin)
admin.site.register(MoneyDebt, MoneyDebtAdmin)
admin.site.register(DebtPayment, DebtPaymentAdmin)
admin.site.register(AccountTransfer, AccountTransferAdmin)
admin.site.register(CategoryBudget, CategoryBudgetAdmin)
admin.site.register(RecurringRule, RecurringRuleAdmin)
admin.site.register(MerchantRule, MerchantRuleAdmin)
admin.site.register(CreditCard, CreditCardAdmin)
admin.site.register(CreditCardActivity, CreditCardActivityAdmin)
admin.site.register(AppNotification, AppNotificationAdmin)
admin.site.register(SecuritySettings, SecuritySettingsAdmin)
admin.site.register(SecurityCode, SecurityCodeAdmin)
