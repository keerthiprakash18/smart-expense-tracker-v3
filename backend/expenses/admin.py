from django.contrib import admin

from .models import Account, Bill, Category, DebtPayment, Expense, MoneyDebt, SavingsGoal, UserProfile


@admin.register(Expense)
class ExpenseAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "title", "amount", "category", "transaction_type", "payment_method", "date")
    list_filter = ("transaction_type", "category", "payment_method", "date")
    search_fields = ("title", "user__username", "category")


@admin.register(Account)
class AccountAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "name", "account_type", "balance", "created_at")
    list_filter = ("account_type",)
    search_fields = ("name", "user__username")


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ("id", "user", "phone", "country", "currency", "monthly_budget", "savings_goal")
    search_fields = ("user__username", "user__email", "phone")


admin.site.register([Category, Bill, SavingsGoal, MoneyDebt, DebtPayment])
