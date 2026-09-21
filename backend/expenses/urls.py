from django.urls import path

from .views import (
    AccountDetailView, AccountListCreateView, BillDetailView, BillListCreateView,
    ChangePasswordView, DashboardSummaryView, DebtPaymentListCreateView,
    ExpenseDetailView, ExpenseListCreateView, HealthView, MoneyDebtDetailView,
    MoneyDebtListCreateView, ReceiptScanView, RegisterView, SavingsGoalDetailView,
    SavingsGoalListCreateView, UserProfileView,
)

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("register/", RegisterView.as_view(), name="register"),
    path("profile/", UserProfileView.as_view(), name="profile"),
    path("change-password/", ChangePasswordView.as_view(), name="change-password"),
    path("accounts/", AccountListCreateView.as_view(), name="account-list-create"),
    path("accounts/<int:pk>/", AccountDetailView.as_view(), name="account-detail"),
    path("expenses/", ExpenseListCreateView.as_view(), name="expense-list-create"),
    path("expenses/<int:pk>/", ExpenseDetailView.as_view(), name="expense-detail"),
    path("bills/", BillListCreateView.as_view(), name="bill-list-create"),
    path("bills/<int:pk>/", BillDetailView.as_view(), name="bill-detail"),
    path("savings-goals/", SavingsGoalListCreateView.as_view(), name="savings-goal-list-create"),
    path("savings-goals/<int:pk>/", SavingsGoalDetailView.as_view(), name="savings-goal-detail"),
    path("money-debts/", MoneyDebtListCreateView.as_view(), name="money-debt-list-create"),
    path("money-debts/<int:pk>/", MoneyDebtDetailView.as_view(), name="money-debt-detail"),
    path("money-debts/<int:debt_id>/payments/", DebtPaymentListCreateView.as_view(), name="debt-payment-list-create"),
    path("dashboard/", DashboardSummaryView.as_view(), name="dashboard-summary"),
    path("scan-receipt/", ReceiptScanView.as_view(), name="scan-receipt"),
]
