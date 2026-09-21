from decimal import Decimal

from django.contrib.auth.models import User
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Account, Bill, Expense, MoneyDebt, SavingsGoal, UserProfile


class SmartExpenseApiTests(APITestCase):
    def register_and_login(self, username="tester", email="tester@example.com", password="StrongPass123!"):
        register = self.client.post(
            reverse("register"),
            {
                "username": username,
                "name": "Test User",
                "email": email,
                "phone": "+919999999999",
                "password": password,
            },
            format="json",
        )
        self.assertEqual(register.status_code, status.HTTP_201_CREATED, register.data)
        token = self.client.post(
            reverse("token_obtain_pair"),
            {"username": username, "password": password},
            format="json",
        )
        self.assertEqual(token.status_code, status.HTTP_200_OK, token.data)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.data['access']}")
        return User.objects.get(username=username)

    def test_registration_creates_profile_and_default_accounts(self):
        user = self.register_and_login()
        self.assertTrue(UserProfile.objects.filter(user=user).exists())
        self.assertEqual(Account.objects.filter(user=user).count(), 2)
        response = self.client.get(reverse("account-list-create"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 2)

    def test_profile_update_and_change_password(self):
        user = self.register_and_login()
        profile = self.client.put(
            reverse("profile"),
            {"username": "tester2", "email": "new@example.com", "currency": "$", "monthly_budget": "75000"},
            format="json",
        )
        self.assertEqual(profile.status_code, 200, profile.data)
        self.assertEqual(profile.data["username"], "tester2")
        self.assertEqual(profile.data["currency"], "$")

        change = self.client.post(
            reverse("change-password"),
            {"old_password": "StrongPass123!", "new_password": "NewStrongPass456!"},
            format="json",
        )
        self.assertEqual(change.status_code, 200, change.data)
        user.refresh_from_db()
        self.assertTrue(user.check_password("NewStrongPass456!"))

    def test_expense_crud_keeps_account_balance_consistent(self):
        user = self.register_and_login()
        account = Account.objects.filter(user=user).order_by("id").first()

        created = self.client.post(
            reverse("expense-list-create"),
            {
                "title": "Lunch",
                "amount": "250.00",
                "transaction_type": "EXPENSE",
                "category": "Food & Dining",
                "account": account.id,
                "payment_method": "UPI",
                "date": "2026-09-21",
            },
            format="json",
        )
        self.assertEqual(created.status_code, 201, created.data)
        account.refresh_from_db()
        self.assertEqual(account.balance, Decimal("-250.00"))

        expense_id = created.data["id"]
        updated = self.client.patch(
            reverse("expense-detail", kwargs={"pk": expense_id}),
            {"amount": "100.00", "transaction_type": "INCOME"},
            format="json",
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        account.refresh_from_db()
        self.assertEqual(account.balance, Decimal("100.00"))

        deleted = self.client.delete(reverse("expense-detail", kwargs={"pk": expense_id}))
        self.assertEqual(deleted.status_code, 204)
        account.refresh_from_db()
        self.assertEqual(account.balance, Decimal("0.00"))

    def test_user_cannot_access_another_users_transactions_or_accounts(self):
        first = self.register_and_login("first", "first@example.com")
        first_account = Account.objects.filter(user=first).first()
        expense = Expense.objects.create(
            user=first,
            account=first_account,
            title="Private",
            amount=Decimal("500.00"),
            transaction_type="EXPENSE",
        )

        self.client.credentials()
        self.register_and_login("second", "second@example.com")
        response = self.client.get(reverse("expense-detail", kwargs={"pk": expense.pk}))
        self.assertEqual(response.status_code, 404)
        bad_create = self.client.post(
            reverse("expense-list-create"),
            {"title": "Bad", "amount": "10", "account": first_account.id},
            format="json",
        )
        self.assertEqual(bad_create.status_code, 400)

    def test_dashboard_summary(self):
        user = self.register_and_login()
        account = Account.objects.filter(user=user).first()
        for tx_type, amount in (("INCOME", "1000"), ("EXPENSE", "250"), ("BILL", "100")):
            response = self.client.post(
                reverse("expense-list-create"),
                {"title": tx_type, "amount": amount, "transaction_type": tx_type, "account": account.id},
                format="json",
            )
            self.assertEqual(response.status_code, 201, response.data)
        summary = self.client.get(reverse("dashboard-summary"))
        self.assertEqual(summary.status_code, 200)
        self.assertEqual(summary.data["total_income"], 1000.0)
        self.assertEqual(summary.data["total_expenses"], 250.0)
        self.assertEqual(summary.data["total_bills"], 100.0)
        self.assertEqual(summary.data["net_balance"], 650.0)


    def test_money_hub_debt_and_repayment_flow(self):
        self.register_and_login()
        debt = self.client.post(
            reverse("money-debt-list-create"),
            {
                "direction": "BORROWED",
                "person_name": "Alex",
                "amount": "1000.00",
                "transaction_date": "2026-09-21",
                "due_date": "2026-10-01",
                "purpose": "Trip",
            },
            format="json",
        )
        self.assertEqual(debt.status_code, 201, debt.data)
        self.assertEqual(debt.data["remaining_amount"], "1000.00")
        payment = self.client.post(
            reverse("debt-payment-list-create", kwargs={"debt_id": debt.data["id"]}),
            {"amount": "400.00", "payment_date": "2026-09-22"},
            format="json",
        )
        self.assertEqual(payment.status_code, 201, payment.data)
        detail = self.client.get(reverse("money-debt-detail", kwargs={"pk": debt.data["id"]}))
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.data["amount_paid"], "400.00")
        self.assertEqual(detail.data["remaining_amount"], "600.00")
        self.assertEqual(detail.data["status"], "PARTIAL")

    def test_bills_and_savings_are_user_scoped(self):
        first = self.register_and_login("money1", "money1@example.com")
        bill = self.client.post(
            reverse("bill-list-create"),
            {"title": "Internet", "amount": "999.00", "due_date": "2026-09-30"},
            format="json",
        )
        self.assertEqual(bill.status_code, 201, bill.data)
        goal = self.client.post(
            reverse("savings-goal-list-create"),
            {"name": "Laptop", "target_amount": "100000.00", "current_amount": "25000.00"},
            format="json",
        )
        self.assertEqual(goal.status_code, 201, goal.data)
        self.client.credentials()
        self.register_and_login("money2", "money2@example.com")
        bills = self.client.get(reverse("bill-list-create"))
        goals = self.client.get(reverse("savings-goal-list-create"))
        self.assertEqual(bills.status_code, 200)
        self.assertEqual(goals.status_code, 200)
        self.assertEqual(len(bills.data), 0)
        self.assertEqual(len(goals.data), 0)
