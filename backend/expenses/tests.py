from decimal import Decimal

from django.contrib.auth.models import User
from django.urls import reverse
from django.contrib.auth.hashers import make_password
from django.utils import timezone
from datetime import timedelta
from rest_framework import status
from rest_framework.test import APITestCase

from .models import Account, Bill, Expense, MoneyDebt, SavingsGoal, SecurityCode, UserProfile
from .security_utils import totp_code


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

    def test_login_accepts_email_or_username(self):
        self.register_and_login("emailuser", "emailuser@example.com")
        self.client.credentials()
        token = self.client.post(
            reverse("token_obtain_pair"),
            {"username": "emailuser@example.com", "password": "StrongPass123!"},
            format="json",
        )
        self.assertEqual(token.status_code, 200, token.data)
        self.assertIn("access", token.data)

    def test_account_transfer_moves_balance_without_counting_as_spend(self):
        user = self.register_and_login("transfer", "transfer@example.com")
        accounts = list(Account.objects.filter(user=user).order_by("id"))
        accounts[0].balance = Decimal("1000.00")
        accounts[0].save(update_fields=["balance"])
        response = self.client.post(
            reverse("v3-transfer-list"),
            {"from_account": accounts[0].id, "to_account": accounts[1].id, "amount": "250.00", "date": "2026-09-21"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        accounts[0].refresh_from_db(); accounts[1].refresh_from_db()
        self.assertEqual(accounts[0].balance, Decimal("750.00"))
        self.assertEqual(accounts[1].balance, Decimal("250.00"))
        summary = self.client.get(reverse("dashboard-summary"))
        self.assertEqual(summary.data["total_expenses"], 0.0)

    def test_category_budget_and_custom_category(self):
        self.register_and_login("budget", "budget@example.com")
        cat = self.client.post(reverse("v3-category-list"), {"name": "Coffee", "category_type": "EXPENSE"}, format="json")
        self.assertEqual(cat.status_code, 201, cat.data)
        budget = self.client.post(reverse("v3-budget-list"), {"category": "Coffee", "amount": "1000"}, format="json")
        self.assertEqual(budget.status_code, 201, budget.data)
        self.assertEqual(float(budget.data["amount"]), 1000.0)

    def test_recurring_engine_creates_due_transaction_once(self):
        user = self.register_and_login("recurring", "recurring@example.com")
        account = Account.objects.filter(user=user).first()
        rule = self.client.post(
            reverse("v3-recurring-list"),
            {
                "title": "Salary",
                "amount": "50000",
                "transaction_type": "INCOME",
                "category": "Salary",
                "account": account.id,
                "frequency": "MONTHLY",
                "next_run": "2026-09-21",
            },
            format="json",
        )
        self.assertEqual(rule.status_code, 201, rule.data)
        processed = self.client.post(reverse("v3-recurring-process"), {}, format="json")
        self.assertEqual(processed.status_code, 200, processed.data)
        self.assertEqual(processed.data["created_count"], 1)
        processed_again = self.client.post(reverse("v3-recurring-process"), {}, format="json")
        self.assertEqual(processed_again.data["created_count"], 0)
        self.assertTrue(Expense.objects.filter(user=user, title="Salary", is_recurring=True).exists())

    def test_credit_card_purchase_and_payment(self):
        user = self.register_and_login("carduser", "card@example.com")
        account = Account.objects.filter(user=user).first()
        account.balance = Decimal("5000")
        account.save(update_fields=["balance"])
        card = self.client.post(
            reverse("v3-card-list"),
            {"name": "Travel Card", "last4": "1234", "credit_limit": "10000", "linked_account": account.id},
            format="json",
        )
        self.assertEqual(card.status_code, 201, card.data)
        purchase = self.client.post(
            reverse("v3-card-activity", kwargs={"pk": card.data["id"]}),
            {"activity_type": "PURCHASE", "amount": "1000", "date": "2026-09-21"},
            format="json",
        )
        self.assertEqual(purchase.status_code, 201, purchase.data)
        payment = self.client.post(
            reverse("v3-card-activity", kwargs={"pk": card.data["id"]}),
            {"activity_type": "PAYMENT", "amount": "400", "payment_account": account.id, "date": "2026-09-22"},
            format="json",
        )
        self.assertEqual(payment.status_code, 201, payment.data)
        detail = self.client.get(reverse("v3-card-detail", kwargs={"pk": card.data["id"]}))
        self.assertEqual(detail.data["outstanding"], "600.00")
        account.refresh_from_db()
        self.assertEqual(account.balance, Decimal("4600.00"))

    def test_notifications_and_insights_endpoints(self):
        self.register_and_login("notify", "notify@example.com")
        self.client.post(reverse("bill-list-create"), {"title": "Internet", "amount": "999", "due_date": "2026-09-21"}, format="json")
        synced = self.client.post(reverse("v3-notification-sync"), {}, format="json")
        self.assertEqual(synced.status_code, 200, synced.data)
        notes = self.client.get(reverse("v3-notifications"))
        self.assertEqual(notes.status_code, 200)
        self.assertGreaterEqual(len(notes.data), 1)
        insights = self.client.get(reverse("v3-insights"))
        self.assertEqual(insights.status_code, 200)
        self.assertIn("insights", insights.data)

    def test_backup_export_and_security_status(self):
        self.register_and_login("backup", "backup@example.com")
        exported = self.client.get(reverse("v3-backup-export"))
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.json()["version"], 3)
        security = self.client.get(reverse("v3-security-status"))
        self.assertEqual(security.status_code, 200)
        self.assertFalse(security.data["two_factor_enabled"])


    def test_two_factor_login_flow(self):
        self.register_and_login("twofactor", "twofactor@example.com")
        setup = self.client.post(reverse("v3-2fa-setup"), {}, format="json")
        self.assertEqual(setup.status_code, 200, setup.data)
        code = totp_code(setup.data["secret"])
        self.assertTrue(setup.data["qr_data_url"].startswith("data:image/png;base64,"))
        confirmed = self.client.post(reverse("v3-2fa-confirm"), {"code": code}, format="json")
        self.assertEqual(confirmed.status_code, 200, confirmed.data)
        self.assertEqual(len(confirmed.data["recovery_codes"]), 8)
        recovery_code = confirmed.data["recovery_codes"][0]

        self.client.credentials()
        challenge = self.client.post(reverse("token_obtain_pair"), {"username": "twofactor", "password": "StrongPass123!"}, format="json")
        self.assertEqual(challenge.status_code, 202, challenge.data)

        token = self.client.post(reverse("token_obtain_pair"), {"username": "twofactor", "password": "StrongPass123!", "otp": totp_code(setup.data["secret"])}, format="json")
        self.assertEqual(token.status_code, 200, token.data)
        self.assertIn("access", token.data)

        recovery_login = self.client.post(reverse("token_obtain_pair"), {"username": "twofactor", "password": "StrongPass123!", "otp": recovery_code}, format="json")
        self.assertEqual(recovery_login.status_code, 200, recovery_login.data)

        reused = self.client.post(reverse("token_obtain_pair"), {"username": "twofactor", "password": "StrongPass123!", "otp": recovery_code}, format="json")
        self.assertEqual(reused.status_code, 401, reused.data)

    def test_password_reset_confirm(self):
        user = self.register_and_login("resetuser", "reset@example.com")
        self.client.credentials()
        code = "654321"
        SecurityCode.objects.create(user=user, purpose="PASSWORD_RESET", code_digest=make_password(code), expires_at=timezone.now()+timedelta(minutes=10))
        response = self.client.post(reverse("v3-password-reset-confirm"), {"email": "reset@example.com", "code": code, "new_password": "AnotherStrong789!"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        user.refresh_from_db()
        self.assertTrue(user.check_password("AnotherStrong789!"))
