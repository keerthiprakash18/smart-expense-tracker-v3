import csv
import io
import json
import re
import secrets
from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.conf import settings
from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.hashers import check_password, make_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import Sum
from django.http import JsonResponse
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    Account,
    AccountTransfer,
    AppNotification,
    Bill,
    Category,
    CategoryBudget,
    CreditCard,
    CreditCardActivity,
    Expense,
    MerchantRule,
    MoneyDebt,
    RecurringRule,
    SavingsGoal,
    SecurityCode,
    SecuritySettings,
    UserProfile,
)
from .security_utils import generate_totp_secret, provisioning_uri, verify_totp
from .serializers import ExpenseSerializer
from .v3_serializers import (
    AccountTransferSerializer,
    AppNotificationSerializer,
    CategoryBudgetSerializer,
    CategorySerializer,
    CreditCardActivitySerializer,
    CreditCardSerializer,
    MerchantRuleSerializer,
    RecurringRuleSerializer,
    SecuritySettingsSerializer,
)
from .views import balance_delta, ensure_default_accounts, safe_decimal


def normalize_merchant(value):
    value = re.sub(r"[^a-z0-9 ]+", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", value).strip()[:160]


def advance_date(value, frequency, interval=1):
    interval = max(1, int(interval or 1))
    if frequency == "DAILY":
        return value + timedelta(days=interval)
    if frequency == "WEEKLY":
        return value + timedelta(weeks=interval)
    if frequency == "YEARLY":
        year = value.year + interval
        day = min(value.day, monthrange(year, value.month)[1])
        return date(year, value.month, day)
    # MONTHLY
    month_index = value.year * 12 + (value.month - 1) + interval
    year, month0 = divmod(month_index, 12)
    month = month0 + 1
    day = min(value.day, monthrange(year, month)[1])
    return date(year, month, day)


def process_due_recurring(user, today=None, max_runs=100):
    today = today or timezone.localdate()
    created = []
    rules = RecurringRule.objects.filter(user=user, active=True, next_run__lte=today).order_by("next_run", "id")
    for rule in rules:
        runs = 0
        while rule.active and rule.next_run <= today and runs < max_runs:
            if rule.end_date and rule.next_run > rule.end_date:
                rule.active = False
                break
            account = rule.account
            with transaction.atomic():
                if account:
                    account = Account.objects.select_for_update().filter(pk=account.pk, user=user).first()
                expense = Expense.objects.create(
                    user=user,
                    account=account,
                    title=rule.title,
                    amount=rule.amount,
                    transaction_type=rule.transaction_type,
                    category=rule.category,
                    payment_method=rule.payment_method,
                    date=rule.next_run,
                    notes=(rule.notes or "Recurring transaction").strip(),
                    is_recurring=True,
                )
                if account:
                    account.balance = safe_decimal(account.balance) + balance_delta(rule.transaction_type, rule.amount)
                    account.save(update_fields=["balance"])
            created.append(expense.id)
            rule.last_run = rule.next_run
            rule.next_run = advance_date(rule.next_run, rule.frequency, rule.interval)
            runs += 1
            if rule.end_date and rule.next_run > rule.end_date:
                rule.active = False
        rule.save(update_fields=["last_run", "next_run", "active", "updated_at"])
        if runs:
            AppNotification.objects.get_or_create(
                user=user,
                dedupe_key=f"recurring:{rule.id}:{rule.last_run}",
                defaults={
                    "kind": "RECURRING",
                    "title": f"Recurring {rule.transaction_type.lower()} added",
                    "message": f"{rule.title} was added automatically.",
                    "due_date": rule.last_run,
                    "action_url": "/transactions",
                },
            )
    return created


def current_card_due_date(card, today=None):
    today = today or timezone.localdate()
    candidate = date(today.year, today.month, min(card.due_day, monthrange(today.year, today.month)[1]))
    if candidate < today:
        month_index = today.year * 12 + today.month
        year, month0 = divmod(month_index, 12)
        month = month0 + 1
        candidate = date(year, month, min(card.due_day, monthrange(year, month)[1]))
    return candidate


def sync_notifications(user):
    today = timezone.localdate()
    profile, _ = UserProfile.objects.get_or_create(user=user)
    created = 0

    if profile.bill_reminders:
        for bill in Bill.objects.filter(user=user, is_paid=False, due_date__lte=today + timedelta(days=5)):
            overdue = bill.due_date < today
            _, was_created = AppNotification.objects.get_or_create(
                user=user,
                dedupe_key=f"bill:{bill.id}:{bill.due_date}",
                defaults={
                    "kind": "BILL",
                    "title": f"{'Overdue' if overdue else 'Upcoming'} bill: {bill.title}",
                    "message": f"{bill.title} is {'overdue' if overdue else 'due soon'} — amount {bill.amount}.",
                    "due_date": bill.due_date,
                    "action_url": "/money",
                },
            )
            created += int(was_created)

    if profile.budget_alerts:
        month_expenses = Expense.objects.filter(
            user=user,
            transaction_type__in=["EXPENSE", "BILL"],
            date__year=today.year,
            date__month=today.month,
        )
        for budget in CategoryBudget.objects.filter(user=user, active=True):
            spent = month_expenses.filter(category__iexact=budget.category).aggregate(total=Sum("amount"))["total"] or Decimal("0")
            if budget.amount and spent >= budget.amount * Decimal("0.80"):
                level = "limit" if spent >= budget.amount else "80%"
                _, was_created = AppNotification.objects.get_or_create(
                    user=user,
                    dedupe_key=f"budget:{budget.id}:{today.year}-{today.month}:{level}",
                    defaults={
                        "kind": "BUDGET",
                        "title": f"{budget.category} budget {level} reached",
                        "message": f"You have spent {spent} of {budget.amount} this month.",
                        "action_url": "/planner",
                    },
                )
                created += int(was_created)

    for card in CreditCard.objects.filter(user=user, active=True, outstanding__gt=0):
        due = current_card_due_date(card, today)
        if due <= today + timedelta(days=5):
            _, was_created = AppNotification.objects.get_or_create(
                user=user,
                dedupe_key=f"card:{card.id}:{due}",
                defaults={
                    "kind": "CARD",
                    "title": f"{card.name} payment due",
                    "message": f"Outstanding {card.outstanding} is due by {due}.",
                    "due_date": due,
                    "action_url": "/planner",
                },
            )
            created += int(was_created)

    return created


class UserScopedListCreate(generics.ListCreateAPIView):
    permission_classes = [IsAuthenticated]

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class UserScopedDetail(generics.RetrieveUpdateDestroyAPIView):
    permission_classes = [IsAuthenticated]

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class CategoryListCreateView(UserScopedListCreate):
    serializer_class = CategorySerializer

    def get_queryset(self):
        return Category.objects.filter(user=self.request.user).order_by("category_type", "name")


class CategoryDetailView(UserScopedDetail):
    serializer_class = CategorySerializer

    def get_queryset(self):
        return Category.objects.filter(user=self.request.user)


class CategoryBudgetListCreateView(UserScopedListCreate):
    serializer_class = CategoryBudgetSerializer

    def get_queryset(self):
        return CategoryBudget.objects.filter(user=self.request.user).order_by("category")


class CategoryBudgetDetailView(UserScopedDetail):
    serializer_class = CategoryBudgetSerializer

    def get_queryset(self):
        return CategoryBudget.objects.filter(user=self.request.user)


class RecurringRuleListCreateView(UserScopedListCreate):
    serializer_class = RecurringRuleSerializer

    def get_queryset(self):
        return RecurringRule.objects.filter(user=self.request.user).select_related("account")


class RecurringRuleDetailView(UserScopedDetail):
    serializer_class = RecurringRuleSerializer

    def get_queryset(self):
        return RecurringRule.objects.filter(user=self.request.user).select_related("account")


class RecurringProcessView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        created = process_due_recurring(request.user)
        return Response({"created_count": len(created), "transaction_ids": created})


class AccountTransferListCreateView(UserScopedListCreate):
    serializer_class = AccountTransferSerializer

    def get_queryset(self):
        return AccountTransfer.objects.filter(user=self.request.user).select_related("from_account", "to_account")

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        source = serializer.validated_data["from_account"]
        target = serializer.validated_data["to_account"]
        amount = safe_decimal(serializer.validated_data["amount"])
        with transaction.atomic():
            locked = {
                item.pk: item
                for item in Account.objects.select_for_update().filter(user=request.user, pk__in=[source.pk, target.pk])
            }
            source_locked, target_locked = locked.get(source.pk), locked.get(target.pk)
            if not source_locked or not target_locked:
                return Response({"error": "Account not found."}, status=400)
            source_locked.balance = safe_decimal(source_locked.balance) - amount
            target_locked.balance = safe_decimal(target_locked.balance) + amount
            source_locked.save(update_fields=["balance"])
            target_locked.save(update_fields=["balance"])
            transfer = serializer.save(user=request.user, from_account=source_locked, to_account=target_locked)
        return Response(self.get_serializer(transfer).data, status=201)


class CreditCardListCreateView(UserScopedListCreate):
    serializer_class = CreditCardSerializer

    def get_queryset(self):
        return CreditCard.objects.filter(user=self.request.user).select_related("linked_account").prefetch_related("activities")


class CreditCardDetailView(UserScopedDetail):
    serializer_class = CreditCardSerializer

    def get_queryset(self):
        return CreditCard.objects.filter(user=self.request.user).select_related("linked_account").prefetch_related("activities")


class CreditCardActivityView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, pk):
        card = CreditCard.objects.filter(pk=pk, user=request.user).select_related("linked_account").first()
        if not card:
            return Response({"error": "Card not found."}, status=404)
        serializer = CreditCardActivitySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        activity_type = serializer.validated_data["activity_type"]
        amount = safe_decimal(serializer.validated_data["amount"])
        payment_account_id = request.data.get("payment_account")

        with transaction.atomic():
            locked = CreditCard.objects.select_for_update().get(pk=card.pk, user=request.user)
            if activity_type == "PURCHASE":
                locked.outstanding = safe_decimal(locked.outstanding) + amount
            elif activity_type == "PAYMENT":
                amount = min(amount, safe_decimal(locked.outstanding))
                locked.outstanding = max(Decimal("0"), safe_decimal(locked.outstanding) - amount)
                account = Account.objects.select_for_update().filter(pk=payment_account_id, user=request.user).first() if payment_account_id else None
                if account:
                    account.balance = safe_decimal(account.balance) - amount
                    account.save(update_fields=["balance"])
            else:
                signed = safe_decimal(request.data.get("signed_amount", amount))
                locked.outstanding = max(Decimal("0"), safe_decimal(locked.outstanding) + signed)
            locked.save(update_fields=["outstanding"])
            activity = serializer.save(card=locked, amount=amount)
        return Response(CreditCardActivitySerializer(activity).data, status=201)


class MerchantRuleListView(generics.ListAPIView):
    serializer_class = MerchantRuleSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return MerchantRule.objects.filter(user=self.request.user)[:100]


class NotificationListView(generics.ListAPIView):
    serializer_class = AppNotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = AppNotification.objects.filter(user=self.request.user)
        if self.request.query_params.get("unread") in {"1", "true"}:
            qs = qs.filter(is_read=False)
        return qs[:100]


class NotificationDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = AppNotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return AppNotification.objects.filter(user=self.request.user)


class NotificationSyncView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        process_due_recurring(request.user)
        count = sync_notifications(request.user)
        unread = AppNotification.objects.filter(user=request.user, is_read=False).count()
        return Response({"created": count, "unread": unread})


class NotificationMarkAllReadView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        count = AppNotification.objects.filter(user=request.user, is_read=False).update(is_read=True)
        return Response({"updated": count})


class ReceiptVaultView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        qs = Expense.objects.filter(user=request.user).exclude(receipt_image="").exclude(receipt_image__isnull=True).select_related("account")
        return Response(ExpenseSerializer(qs[:250], many=True, context={"request": request}).data)


class CalendarView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        raw = request.query_params.get("month") or timezone.localdate().strftime("%Y-%m")
        try:
            year, month = [int(x) for x in raw.split("-")]
            start = date(year, month, 1)
            end = date(year, month, monthrange(year, month)[1])
        except Exception:
            return Response({"error": "Use month=YYYY-MM."}, status=400)
        txs = Expense.objects.filter(user=request.user, date__range=[start, end]).select_related("account")
        bills = Bill.objects.filter(user=request.user, due_date__range=[start, end])
        transfers = AccountTransfer.objects.filter(user=request.user, date__range=[start, end]).select_related("from_account", "to_account")
        recurring = RecurringRule.objects.filter(user=request.user, active=True, next_run__range=[start, end]).select_related("account")
        return Response({
            "month": raw,
            "transactions": ExpenseSerializer(txs, many=True, context={"request": request}).data,
            "bills": [{"id": x.id, "title": x.title, "amount": float(x.amount), "date": str(x.due_date), "is_paid": x.is_paid, "kind": "BILL_DUE"} for x in bills],
            "transfers": AccountTransferSerializer(transfers, many=True, context={"request": request}).data,
            "recurring": RecurringRuleSerializer(recurring, many=True, context={"request": request}).data,
        })


class SmartInsightsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today = timezone.localdate()
        first = today.replace(day=1)
        prev_end = first - timedelta(days=1)
        prev_first = prev_end.replace(day=1)
        current = Expense.objects.filter(user=request.user, date__gte=first, date__lte=today)
        previous = Expense.objects.filter(user=request.user, date__gte=prev_first, date__lte=prev_end)
        current_spend = current.filter(transaction_type__in=["EXPENSE", "BILL"]).aggregate(total=Sum("amount"))["total"] or Decimal("0")
        previous_spend = previous.filter(transaction_type__in=["EXPENSE", "BILL"]).aggregate(total=Sum("amount"))["total"] or Decimal("0")
        current_income = current.filter(transaction_type="INCOME").aggregate(total=Sum("amount"))["total"] or Decimal("0")
        insights = []
        if previous_spend > 0:
            pct = (current_spend - previous_spend) / previous_spend * Decimal("100")
            direction = "higher" if pct > 0 else "lower"
            insights.append({"kind": "trend", "title": "Monthly spending trend", "message": f"Spending is {abs(float(pct)):.0f}% {direction} than last month."})
        if current_income > 0:
            savings_rate = (current_income - current_spend) / current_income * Decimal("100")
            insights.append({"kind": "cashflow", "title": "Savings rate", "message": f"Your current-month savings rate is {float(savings_rate):.0f}%."})
        category_rows = current.filter(transaction_type__in=["EXPENSE", "BILL"]).values("category").annotate(total=Sum("amount")).order_by("-total")[:3]
        if category_rows:
            top = category_rows[0]
            insights.append({"kind": "category", "title": "Top spending category", "message": f"{top['category']} is your largest category this month at {top['total']}."})
        subscriptions = RecurringRule.objects.filter(user=request.user, active=True, transaction_type__in=["EXPENSE", "BILL"]).aggregate(total=Sum("amount"))["total"] or Decimal("0")
        if subscriptions:
            insights.append({"kind": "recurring", "title": "Recurring commitments", "message": f"Active recurring expenses total about {subscriptions} per cycle."})
        for budget in CategoryBudget.objects.filter(user=request.user, active=True):
            spent = current.filter(category__iexact=budget.category, transaction_type__in=["EXPENSE", "BILL"]).aggregate(total=Sum("amount"))["total"] or Decimal("0")
            if budget.amount and spent >= budget.amount * Decimal("0.8"):
                insights.append({"kind": "budget", "title": f"{budget.category} budget alert", "message": f"You have used {float(spent / budget.amount * 100):.0f}% of this category budget."})
        return Response({"generated_at": timezone.now(), "insights": insights[:8]})


class BackupExportView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        data = {
            "version": 3,
            "exported_at": timezone.now().isoformat(),
            "profile": {
                "name": request.user.first_name,
                "email": request.user.email,
                "phone": profile.phone,
                "country": profile.country,
                "currency": profile.currency,
                "monthly_budget": str(profile.monthly_budget),
                "savings_goal": str(profile.savings_goal),
            },
            "accounts": list(Account.objects.filter(user=request.user).values("name", "account_type", "balance")),
            "transactions": list(Expense.objects.filter(user=request.user).values("title", "amount", "transaction_type", "category", "payment_method", "date", "time", "notes", "is_recurring", "account__name")),
            "bills": list(Bill.objects.filter(user=request.user).values("title", "amount", "due_date", "category", "is_paid", "is_recurring")),
            "goals": list(SavingsGoal.objects.filter(user=request.user).values("name", "target_amount", "current_amount", "target_date", "icon")),
            "debts": list(MoneyDebt.objects.filter(user=request.user).values("direction", "person_name", "amount", "amount_paid", "transaction_date", "due_date", "purpose", "notes", "status")),
            "categories": list(Category.objects.filter(user=request.user).values("name", "category_type", "color", "icon")),
            "category_budgets": list(CategoryBudget.objects.filter(user=request.user).values("category", "amount", "period", "active")),
            "recurring_rules": list(RecurringRule.objects.filter(user=request.user).values("title", "amount", "transaction_type", "category", "payment_method", "frequency", "interval", "next_run", "end_date", "active", "notes", "account__name")),
            "credit_cards": list(CreditCard.objects.filter(user=request.user).values("name", "last4", "credit_limit", "outstanding", "statement_day", "due_day", "active", "linked_account__name")),
        }
        return JsonResponse(data, json_dumps_params={"indent": 2}, safe=True)


class BackupImportView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser]

    def post(self, request):
        payload = request.data.get("data") if isinstance(request.data, dict) and "data" in request.data else request.data
        if not isinstance(payload, dict) or int(payload.get("version", 0) or 0) < 3:
            return Response({"error": "Invalid Smart Expense V3 backup."}, status=400)
        if request.data.get("confirm") is not True:
            return Response({"error": "Set confirm=true to replace your current finance data."}, status=400)

        with transaction.atomic():
            user = request.user
            Expense.objects.filter(user=user).delete()
            AccountTransfer.objects.filter(user=user).delete()
            RecurringRule.objects.filter(user=user).delete()
            CategoryBudget.objects.filter(user=user).delete()
            Category.objects.filter(user=user).delete()
            CreditCard.objects.filter(user=user).delete()
            Bill.objects.filter(user=user).delete()
            SavingsGoal.objects.filter(user=user).delete()
            MoneyDebt.objects.filter(user=user).delete()
            Account.objects.filter(user=user).delete()

            account_map = {}
            for row in payload.get("accounts", []):
                account = Account.objects.create(user=user, name=row.get("name") or "Account", account_type=row.get("account_type") or "BANK", balance=safe_decimal(row.get("balance")))
                account_map[account.name] = account
            if not account_map:
                ensure_default_accounts(user)
                account_map = {x.name: x for x in Account.objects.filter(user=user)}

            for row in payload.get("transactions", []):
                Expense.objects.create(
                    user=user,
                    account=account_map.get(row.get("account__name")),
                    title=row.get("title") or "Imported transaction",
                    amount=safe_decimal(row.get("amount")),
                    transaction_type=row.get("transaction_type") or "EXPENSE",
                    category=row.get("category") or "General",
                    payment_method=row.get("payment_method") or "Other",
                    date=row.get("date") or timezone.localdate(),
                    time=row.get("time") or "12:00",
                    notes=row.get("notes") or "",
                    is_recurring=bool(row.get("is_recurring")),
                )
            for row in payload.get("categories", []):
                Category.objects.create(user=user, name=row.get("name") or "Imported", category_type=row.get("category_type") or "EXPENSE", color=row.get("color") or "#0A84FF", icon=row.get("icon") or "Tag")
            for row in payload.get("category_budgets", []):
                CategoryBudget.objects.create(user=user, category=row.get("category") or "General", amount=safe_decimal(row.get("amount")), period=row.get("period") or "MONTHLY", active=bool(row.get("active", True)))
            for row in payload.get("bills", []):
                Bill.objects.create(user=user, title=row.get("title") or "Bill", amount=safe_decimal(row.get("amount")), due_date=row.get("due_date") or timezone.localdate(), category=row.get("category") or "Bills & Utilities", is_paid=bool(row.get("is_paid")), is_recurring=bool(row.get("is_recurring", True)))
            for row in payload.get("goals", []):
                SavingsGoal.objects.create(user=user, name=row.get("name") or "Goal", target_amount=safe_decimal(row.get("target_amount")), current_amount=safe_decimal(row.get("current_amount")), target_date=row.get("target_date") or None, icon=row.get("icon") or "🎯")
            for row in payload.get("debts", []):
                MoneyDebt.objects.create(user=user, direction=row.get("direction") or "BORROWED", person_name=row.get("person_name") or "Person", amount=safe_decimal(row.get("amount")), amount_paid=safe_decimal(row.get("amount_paid")), transaction_date=row.get("transaction_date") or timezone.localdate(), due_date=row.get("due_date") or None, purpose=row.get("purpose") or "", notes=row.get("notes") or "", status=row.get("status") or "PENDING")
            for row in payload.get("recurring_rules", []):
                RecurringRule.objects.create(user=user, account=account_map.get(row.get("account__name")), title=row.get("title") or "Recurring", amount=safe_decimal(row.get("amount")), transaction_type=row.get("transaction_type") or "EXPENSE", category=row.get("category") or "General", payment_method=row.get("payment_method") or "Other", frequency=row.get("frequency") or "MONTHLY", interval=max(1, int(row.get("interval") or 1)), next_run=row.get("next_run") or timezone.localdate(), end_date=row.get("end_date") or None, active=bool(row.get("active", True)), notes=row.get("notes") or "")
            for row in payload.get("credit_cards", []):
                CreditCard.objects.create(user=user, linked_account=account_map.get(row.get("linked_account__name")), name=row.get("name") or "Card", last4=row.get("last4") or "", credit_limit=safe_decimal(row.get("credit_limit")), outstanding=safe_decimal(row.get("outstanding")), statement_day=int(row.get("statement_day") or 1), due_day=int(row.get("due_day") or 20), active=bool(row.get("active", True)))

        return Response({"message": "Backup restored successfully."})


class CsvImportView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        file_obj = request.FILES.get("file")
        if not file_obj:
            return Response({"error": "Upload a CSV file in the 'file' field."}, status=400)
        try:
            content = file_obj.read().decode("utf-8-sig")
            rows = list(csv.DictReader(io.StringIO(content)))
        except Exception as exc:
            return Response({"error": f"Could not read CSV: {exc}"}, status=400)
        if len(rows) > 1000:
            return Response({"error": "CSV import is limited to 1000 rows per upload."}, status=400)

        created = 0
        ensure_default_accounts(request.user)
        accounts = {x.name.lower(): x for x in Account.objects.filter(user=request.user)}
        for row in rows:
            amount = safe_decimal(row.get("Amount") or row.get("amount"))
            if amount <= 0:
                continue
            account_name = str(row.get("Account") or row.get("account") or "Primary Bank").strip()
            account = accounts.get(account_name.lower())
            if not account:
                account = Account.objects.create(user=request.user, name=account_name, account_type="CUSTOM", balance=Decimal("0"))
                accounts[account_name.lower()] = account
            tx_type = str(row.get("Type") or row.get("type") or "EXPENSE").upper()
            if tx_type not in {"EXPENSE", "INCOME", "BILL"}:
                tx_type = "EXPENSE"
            raw_date = row.get("Date") or row.get("date") or timezone.localdate().isoformat()
            try:
                tx_date = datetime.fromisoformat(str(raw_date)).date()
            except Exception:
                tx_date = timezone.localdate()
            with transaction.atomic():
                locked = Account.objects.select_for_update().get(pk=account.pk, user=request.user)
                Expense.objects.create(user=request.user, account=locked, title=row.get("Title") or row.get("title") or "Imported transaction", amount=amount, transaction_type=tx_type, category=row.get("Category") or row.get("category") or "General", payment_method=row.get("Payment Method") or row.get("payment_method") or "Other", date=tx_date, notes=row.get("Notes") or row.get("notes") or "Imported from CSV")
                locked.balance = safe_decimal(locked.balance) + balance_delta(tx_type, amount)
                locked.save(update_fields=["balance"])
            created += 1
        return Response({"created": created})


def get_security(user):
    obj, _ = SecuritySettings.objects.get_or_create(user=user)
    return obj


def email_delivery_configured():
    backend = str(getattr(settings, "EMAIL_BACKEND", ""))
    if backend.endswith("console.EmailBackend"):
        return bool(settings.DEBUG)
    if backend.endswith("smtp.EmailBackend"):
        return bool(
            getattr(settings, "EMAIL_HOST", "")
            and getattr(settings, "EMAIL_HOST_USER", "")
            and getattr(settings, "EMAIL_HOST_PASSWORD", "")
        )
    return True


def issue_security_code(user, purpose):
    SecurityCode.objects.filter(user=user, purpose=purpose, consumed_at__isnull=True).delete()
    code = f"{secrets.randbelow(1000000):06d}"
    SecurityCode.objects.create(user=user, purpose=purpose, code_digest=make_password(code), expires_at=timezone.now() + timedelta(minutes=10))
    return code


def send_code_email(user, code, subject):
    if not user.email:
        return False
    send_mail(subject, f"Your Smart Expense verification code is {code}. It expires in 10 minutes.", getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@smartexpense.app"), [user.email], fail_silently=False)
    return True


class SecurityStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response(SecuritySettingsSerializer(get_security(request.user)).data)


class EmailVerificationRequestView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        if not request.user.email:
            return Response({"error": "Add an email address first."}, status=400)
        if not email_delivery_configured():
            return Response(
                {
                    "error": "Email delivery is not configured on the server.",
                    "detail": "Add SMTP email variables to the Railway backend service and redeploy.",
                },
                status=503,
            )
        code = issue_security_code(request.user, "EMAIL_VERIFY")
        try:
            send_code_email(request.user, code, "Verify your Smart Expense email")
        except Exception as exc:
            return Response({"error": "Unable to send verification email.", "detail": str(exc)}, status=503)
        data = {"message": "Verification code sent."}
        if settings.DEBUG:
            data["dev_code"] = code
        return Response(data)


class EmailVerificationConfirmView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        code = str(request.data.get("code", "")).strip()
        obj = SecurityCode.objects.filter(user=request.user, purpose="EMAIL_VERIFY", consumed_at__isnull=True, expires_at__gte=timezone.now()).first()
        if not obj or not check_password(code, obj.code_digest):
            return Response({"error": "Invalid or expired verification code."}, status=400)
        obj.consumed_at = timezone.now()
        obj.save(update_fields=["consumed_at"])
        sec = get_security(request.user)
        sec.email_verified = True
        sec.save(update_fields=["email_verified", "updated_at"])
        return Response({"message": "Email verified."})


class PasswordResetRequestView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        if not email_delivery_configured():
            return Response(
                {
                    "error": "Email delivery is not configured on the server.",
                    "detail": "Add SMTP email variables to the Railway backend service and redeploy.",
                },
                status=503,
            )
        email = str(request.data.get("email", "")).strip().lower()
        user = User.objects.filter(email__iexact=email).first()
        if user:
            code = issue_security_code(user, "PASSWORD_RESET")
            try:
                send_code_email(user, code, "Reset your Smart Expense password")
            except Exception:
                pass
        return Response({"message": "If that email exists, a reset code has been sent."})


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        email = str(request.data.get("email", "")).strip().lower()
        code = str(request.data.get("code", "")).strip()
        new_password = request.data.get("new_password", "")
        user = User.objects.filter(email__iexact=email).first()
        if not user:
            return Response({"error": "Invalid or expired reset code."}, status=400)
        obj = SecurityCode.objects.filter(user=user, purpose="PASSWORD_RESET", consumed_at__isnull=True, expires_at__gte=timezone.now()).first()
        if not obj or not check_password(code, obj.code_digest):
            return Response({"error": "Invalid or expired reset code."}, status=400)
        try:
            validate_password(new_password, user=user)
        except DjangoValidationError as exc:
            return Response({"error": " ".join(exc.messages)}, status=400)
        user.set_password(new_password)
        user.save(update_fields=["password"])
        obj.consumed_at = timezone.now()
        obj.save(update_fields=["consumed_at"])
        return Response({"message": "Password reset successfully."})


class TwoFactorSetupView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        sec = get_security(request.user)
        secret = generate_totp_secret()
        sec.totp_secret = secret
        sec.two_factor_enabled = False
        sec.save(update_fields=["totp_secret", "two_factor_enabled", "updated_at"])
        return Response({"secret": secret, "otpauth_uri": provisioning_uri(secret, request.user.email or request.user.username)})


class TwoFactorConfirmView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        sec = get_security(request.user)
        if not sec.totp_secret:
            return Response({"error": "Start 2FA setup first."}, status=400)
        if not verify_totp(sec.totp_secret, request.data.get("code")):
            return Response({"error": "Invalid authenticator code."}, status=400)
        sec.two_factor_enabled = True
        sec.save(update_fields=["two_factor_enabled", "updated_at"])
        return Response({"message": "Two-factor authentication enabled."})


class TwoFactorDisableView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        sec = get_security(request.user)
        if not request.user.check_password(request.data.get("password", "")):
            return Response({"error": "Password is incorrect."}, status=400)
        if sec.two_factor_enabled and not verify_totp(sec.totp_secret, request.data.get("code")):
            return Response({"error": "Invalid authenticator code."}, status=400)
        sec.two_factor_enabled = False
        sec.totp_secret = ""
        sec.save(update_fields=["two_factor_enabled", "totp_secret", "updated_at"])
        return Response({"message": "Two-factor authentication disabled."})
