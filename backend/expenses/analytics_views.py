import csv
from datetime import date
from decimal import Decimal

from django.db.models import Avg, Q, Sum
from django.db.models.functions import TruncMonth
from django.http import HttpResponse
from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Expense, UserProfile
from .querying import filtered_expenses


ZERO = Decimal("0")


def _num(value):
    return float(value or ZERO)


def _month_key(value):
    return value.strftime("%Y-%m")


def _previous_month(year, month, steps):
    index = year * 12 + (month - 1) - steps
    y, m0 = divmod(index, 12)
    return y, m0 + 1


def _safe_csv_cell(value):
    text = "" if value is None else str(value)
    if text[:1] in {"=", "+", "-", "@"}:
        return "'" + text
    return text


class AnalyticsSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today = timezone.localdate()
        txs = Expense.objects.filter(user=request.user)
        spend_filter = Q(transaction_type__in=["EXPENSE", "BILL"])
        income_filter = Q(transaction_type="INCOME")

        totals = txs.aggregate(
            income=Sum("amount", filter=income_filter),
            spend=Sum("amount", filter=spend_filter),
            average_spend=Avg("amount", filter=spend_filter),
        )
        current = txs.filter(date__year=today.year, date__month=today.month)
        current_totals = current.aggregate(
            income=Sum("amount", filter=income_filter),
            spend=Sum("amount", filter=spend_filter),
        )
        category_rows = list(
            current.filter(transaction_type__in=["EXPENSE", "BILL"])
            .values("category")
            .annotate(value=Sum("amount"))
            .order_by("-value", "category")
        )
        monthly_rows = (
            txs.annotate(month=TruncMonth("date"))
            .values("month")
            .annotate(
                income=Sum("amount", filter=income_filter),
                spend=Sum("amount", filter=spend_filter),
            )
            .order_by("month")
        )
        monthly_map = {
            _month_key(row["month"]): {"income": _num(row["income"]), "spend": _num(row["spend"])}
            for row in monthly_rows if row["month"]
        }

        months = []
        for offset in range(7, -1, -1):
            year, month = _previous_month(today.year, today.month, offset)
            key = f"{year:04d}-{month:02d}"
            values = monthly_map.get(key, {"income": 0.0, "spend": 0.0})
            first = date(year, month, 1)
            months.append({
                "key": key,
                "label": first.strftime("%b %y"),
                "income": values["income"],
                "spend": values["spend"],
                "net": values["income"] - values["spend"],
            })

        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        budget = Decimal(profile.monthly_budget or 0)
        month_spend = Decimal(current_totals["spend"] or 0)
        budget_percent = float(month_spend / budget * 100) if budget > 0 else 0.0

        return Response({
            "month": {
                "income": _num(current_totals["income"]),
                "spend": _num(current_totals["spend"]),
                "budget": _num(budget),
                "budget_percent": round(budget_percent, 1),
                "categories": [{"name": row["category"] or "General", "value": _num(row["value"])} for row in category_rows],
            },
            "totals": {
                "income": _num(totals["income"]),
                "spend": _num(totals["spend"]),
                "average_spend": _num(totals["average_spend"]),
                "net": _num(totals["income"]) - _num(totals["spend"]),
                "transaction_count": txs.count(),
            },
            "months": months,
            "generated_at": timezone.now(),
        })


class TransactionCsvExportView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        rows = filtered_expenses(request.user, request.query_params)
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = 'attachment; filename="smart-expense-transactions.csv"'
        writer = csv.writer(response)
        writer.writerow(["Date", "Title", "Type", "Category", "Account", "Payment Method", "Amount", "Notes"])
        for tx in rows.iterator(chunk_size=500):
            writer.writerow([
                _safe_csv_cell(tx.date),
                _safe_csv_cell(tx.title),
                _safe_csv_cell(tx.transaction_type),
                _safe_csv_cell(tx.category),
                _safe_csv_cell(tx.account.name if tx.account else ""),
                _safe_csv_cell(tx.payment_method),
                _safe_csv_cell(tx.amount),
                _safe_csv_cell(tx.notes),
            ])
        return response
