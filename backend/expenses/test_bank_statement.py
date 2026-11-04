"""Bank statement import regressions use synthetic financial data only."""
import io
import json
from decimal import Decimal

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from .models import Account, BankStatementEntry, Expense


CSV_DATA = (
    "Date,Narration,Withdrawal Amt,Deposit Amt,Closing Balance,Reference No\n"
    "04/11/2026,SWIGGY UPI,350.00,,650.00,TXN-101\n"
    "05/11/2026,SALARY,,25000.00,25650.00,TXN-102\n"
    "06/11/2026,SELF TRANSFER UPI,500.00,,25150.00,TXN-103\n"
    "07/11/2026,NETFLIX UPI,199.00,,24951.00,TXN-104\n"
)


class BankImportTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="bankuser", password="StrongPassword123!")
        self.account = Account.objects.create(
            user=self.user, name="Test Bank", account_type="BANK", balance=Decimal("1000.00")
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    @staticmethod
    def uploaded(content=CSV_DATA):
        return SimpleUploadedFile("synthetic-statement.csv", content.encode("utf-8"), content_type="text/csv")

    def preview(self, content=CSV_DATA, account_id=None):
        return self.client.post(
            reverse("v3-bank-statement-preview"),
            {"account_id": account_id or self.account.id, "file": self.uploaded(content)},
            format="multipart",
        )

    def commit(self, selected, content=CSV_DATA, allow=False, account_id=None):
        return self.client.post(
            reverse("v3-bank-statement-import"),
            {
                "account_id": account_id or self.account.id,
                "file": self.uploaded(content),
                "selected_indices": json.dumps(selected),
                "category_overrides": json.dumps({}),
                "allow_possible_matches": "true" if allow else "false",
            },
            format="multipart",
        )

    def test_preview_does_not_change_money_and_flags_transfers(self):
        response = self.preview()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(response.data["rows"]), 4)
        self.assertEqual(response.data["rows"][0]["category"], "Food & Dining")
        self.assertEqual(response.data["rows"][2]["status"], "review_transfer")
        self.assertEqual(Expense.objects.filter(user=self.user).count(), 0)
        self.account.refresh_from_db()
        self.assertEqual(self.account.balance, Decimal("1000.00"))

    def test_confirm_import_is_idempotent_and_keeps_balance_consistent(self):
        response = self.commit([0, 1, 3])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["created"], 3)
        self.account.refresh_from_db()
        self.assertEqual(self.account.balance, Decimal("25451.00"))
        self.assertEqual(BankStatementEntry.objects.filter(user=self.user).count(), 3)
        again = self.commit([0, 1, 3])
        self.assertEqual(again.status_code, 200, again.data)
        self.assertEqual(again.data["created"], 0)
        self.assertEqual(again.data["already_imported"], 3)
        self.account.refresh_from_db()
        self.assertEqual(self.account.balance, Decimal("25451.00"))

    def test_transfer_requires_manual_reconciliation(self):
        response = self.commit([2])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Expense.objects.count(), 0)

    def test_possible_manual_match_requires_explicit_confirmation(self):
        Expense.objects.create(
            user=self.user, account=self.account, title="Previously added",
            amount=Decimal("350.00"), date="2026-11-04", transaction_type="EXPENSE",
        )
        preview = self.preview()
        self.assertEqual(preview.data["rows"][0]["status"], "possible_match")
        blocked = self.commit([0])
        self.assertEqual(blocked.status_code, 400)
        imported = self.commit([0], allow=True)
        self.assertEqual(imported.status_code, 200, imported.data)
        self.assertEqual(imported.data["created"], 1)

    def test_other_users_account_cannot_be_accessed(self):
        other = User.objects.create_user(username="another")
        another_account = Account.objects.create(user=other, name="Private", account_type="BANK")
        response = self.preview(account_id=another_account.pk)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Expense.objects.count(), 0)

    def test_invalid_statement_fails_closed(self):
        response = self.preview("Hello,World\nA,B\n")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Expense.objects.count(), 0)

    def test_xlsx_statement_can_be_previewed(self):
        from openpyxl import Workbook

        book = Workbook()
        sheet = book.active
        sheet.append(["Date", "Narration", "Debit", "Credit", "Balance", "Reference"])
        sheet.append(["2026-11-04", "Petrol", 200, None, 800, "X100"])
        buffer = io.BytesIO()
        book.save(buffer)
        file_obj = SimpleUploadedFile(
            "synthetic.xlsx", buffer.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        result = self.client.post(
            reverse("v3-bank-statement-preview"),
            {"account_id": self.account.pk, "file": file_obj},
            format="multipart",
        )
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data["rows"][0]["category"], "Transport")
