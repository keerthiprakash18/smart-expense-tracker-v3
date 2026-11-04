"""Authenticated bank statement preview and explicitly confirmed import.

Accepts uploaded files per request and never retains the raw file or PDF password.
The selected account is locked during import, preventing simultaneous balance drift.
"""
import json
from decimal import Decimal

from django.db import transaction
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .bank_statement import StatementError, parse_statement, prepare_rows
from .models import Account, BankStatementEntry, Expense
from .views import balance_delta, safe_decimal


def read_statement_request(request):
    uploaded = request.FILES.get("file")
    account_id = request.data.get("account_id")
    if not uploaded:
        raise StatementError("Choose a statement file.")
    account = Account.objects.filter(pk=account_id, user=request.user).first()
    if not account:
        raise StatementError("Choose one of your own accounts.")
    password = str(request.data.get("pdf_password") or "")[:150]
    rows = parse_statement(uploaded, password=password)
    return account, rows


class BankStatementPreviewView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]
    throttle_scope = "imports"

    def post(self, request):
        try:
            account, parsed = read_statement_request(request)
            rows = prepare_rows(request.user, account, parsed)
        except (StatementError, TypeError, ValueError) as exc:
            return Response({"error": str(exc)}, status=400)
        return Response({
            "account": {"id": account.id, "name": account.name},
            "rows": rows,
            "counts": {name: sum(r["status"] == name for r in rows)
                       for name in ("ready", "duplicate", "possible_match", "review_transfer")},
            "warning": "This is a statement upload, not a live bank sync. Review all entries. "
                       "Self transfers and card settlements need manual reconciliation.",
        })


class BankStatementCommitView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]
    throttle_scope = "imports"

    def post(self, request):
        try:
            account, parsed = read_statement_request(request)
            indices = json.loads(request.data.get("selected_indices") or "[]")
            category_overrides = json.loads(request.data.get("category_overrides") or "{}")
            allow_possible = request.data.get("allow_possible_matches") == "true"
            if (not isinstance(indices, list)
                    or len(indices) > 1000
                    or not all(type(i) is int for i in indices)
                    or not isinstance(category_overrides, dict)):
                raise StatementError("Invalid transaction selection.")
            if not indices:
                raise StatementError("Select at least one transaction to import.")
            chosen = set(indices)
            if len(chosen) != len(indices) or min(chosen) < 0 or max(chosen) >= len(parsed):
                raise StatementError("Invalid transaction selection.")
            if len(category_overrides) > 1000:
                raise StatementError("Too many category overrides.")
            created = 0
            skipped = 0
            with transaction.atomic():
                locked = Account.objects.select_for_update().get(pk=account.pk, user=request.user)
                candidates = prepare_rows(request.user, locked, parsed)
                if any(r["index"] in chosen and r["status"] == "review_transfer" for r in candidates):
                    raise StatementError("Transfers and card bill payments require manual reconciliation; do not import them as expenses.")
                if (not allow_possible and
                        any(r["index"] in chosen and r["status"] == "possible_match" for r in candidates)):
                    raise StatementError("Possible matches require explicit confirmation.")
                for row in candidates:
                    if row["index"] not in chosen:
                        continue
                    if row["status"] == "duplicate":
                        skipped += 1
                        continue
                    category = str(category_overrides.get(str(row["index"]), row["category"])).strip()[:100]
                    if not category:
                        category = row["category"]
                    description = row["description"]
                    method = "UPI" if "upi" in description.lower() else (
                        "CARD" if any(x in description.lower() for x in ("card", "pos", "visa")) else
                        "BANK_TRANSFER"
                    )
                    amount = Decimal(row["amount"])
                    expense = Expense.objects.create(
                        user=request.user, account=locked, title=description[:200],
                        amount=amount, transaction_type=row["transaction_type"],
                        category=category, payment_method=method,
                        date=row["date"], notes="Imported from reviewed bank statement",
                    )
                    BankStatementEntry.objects.create(
                        user=request.user, account=locked, expense=expense,
                        fingerprint=row["fingerprint"],
                    )
                    locked.balance = safe_decimal(locked.balance) + balance_delta(row["transaction_type"], amount)
                    created += 1
                if created:
                    locked.save(update_fields=["balance"])
            return Response({
                "created": created, "already_imported": skipped,
                "message": "Selected transactions imported. Account balance is based on your app ledger, "
                           "not a verified live bank balance.",
            })
        except Account.DoesNotExist:
            return Response({"error": "Account no longer exists."}, status=404)
        except (StatementError, ValueError, TypeError) as exc:
            return Response({"error": str(exc)}, status=400)
