import os
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.contrib.auth.models import User
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import generics, status
from rest_framework.exceptions import ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Account, Bill, DebtPayment, Expense, MoneyDebt, SavingsGoal, UserProfile
from .ocr_service import IndiaReceiptExtractor
from .serializers import (
    AccountSerializer, BillSerializer, DebtPaymentSerializer, ExpenseSerializer,
    MoneyDebtSerializer, SavingsGoalSerializer,
)


def safe_decimal(value, default="0.00"):
    try:
        if value in (None, ""):
            return Decimal(default)
        amount = Decimal(str(value))
        return amount.quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(default)


def nonnegative_decimal(value, default="0.00"):
    amount = safe_decimal(value, default)
    return amount if amount >= 0 else Decimal(default)


def balance_delta(transaction_type, amount):
    amount = safe_decimal(amount)
    if transaction_type == "INCOME":
        return amount
    if transaction_type in {"EXPENSE", "BILL"}:
        return -amount
    return Decimal("0.00")


def ensure_default_accounts(user):
    defaults = [
        ("Primary Bank", "BANK"),
        ("Personal Cash Vault", "CASH"),
    ]
    for name, account_type in defaults:
        Account.objects.get_or_create(
            user=user,
            name=name,
            defaults={"account_type": account_type, "balance": Decimal("0.00")},
        )


def get_user_account(user, account_value):
    if account_value in (None, "", "null", "undefined"):
        return None
    try:
        account = Account.objects.filter(id=int(account_value), user=user).first()
        if account:
            return account
    except (TypeError, ValueError):
        pass
    return Account.objects.filter(user=user, name__iexact=str(account_value).strip()).first()


def detect_currency_from_text(ocr_text):
    text = (ocr_text or "").upper()
    if "$" in text or "USD" in text or "US $" in text:
        return "$"
    if "€" in text or "EUR" in text:
        return "€"
    if "£" in text or "GBP" in text:
        return "£"
    return "₹"


def serializer_error_payload(exc):
    detail = getattr(exc, "detail", None)
    return detail if detail is not None else {"error": str(exc)}


class HealthView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        return Response({"status": "ok", "service": "smart-expense-tracker-api"})


class RegisterView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        name = str(request.data.get("name", "")).strip()
        email = str(request.data.get("email", "")).strip().lower()
        username = str(request.data.get("username", "")).strip() or email
        phone = str(request.data.get("phone", "")).strip()
        password = request.data.get("password", "")

        if not username or not password:
            return Response(
                {"error": "Username/email and password are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if email and User.objects.filter(email__iexact=email).exists():
            return Response(
                {"error": "An account with this email already exists."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if User.objects.filter(username__iexact=username).exists():
            return Response(
                {"error": "Username already exists."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        candidate = User(username=username, email=email, first_name=name)
        try:
            validate_password(password, user=candidate)
        except DjangoValidationError as exc:
            return Response(
                {"error": " ".join(exc.messages)}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            with transaction.atomic():
                user = User.objects.create_user(
                    username=username,
                    email=email,
                    password=password,
                    first_name=name,
                )
                UserProfile.objects.create(
                    user=user,
                    phone=phone or None,
                    currency="₹",
                    monthly_budget=Decimal("50000.00"),
                )
                ensure_default_accounts(user)
        except IntegrityError:
            return Response(
                {"error": "Unable to create account because the username or email already exists."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "message": "Account created successfully. You can sign in now.",
                "username": user.username,
                "email": user.email,
            },
            status=status.HTTP_201_CREATED,
        )


class UserProfileView(APIView):
    permission_classes = [IsAuthenticated]

    def _profile(self, user):
        profile, _ = UserProfile.objects.get_or_create(
            user=user,
            defaults={"currency": "₹", "monthly_budget": Decimal("50000.00")},
        )
        ensure_default_accounts(user)
        return profile

    def get(self, request):
        user = request.user
        profile = self._profile(user)
        return Response(
            {
                "username": user.username,
                "name": user.first_name or user.username,
                "email": user.email or "",
                "phone": profile.phone or "",
                "country": profile.country,
                "currency": profile.currency or "₹",
                "monthly_budget": float(profile.monthly_budget or 0),
                "savings_goal": float(profile.savings_goal or 0),
                "dark_mode": profile.dark_mode,
                "budget_alerts": profile.budget_alerts,
                "bill_reminders": profile.bill_reminders,
                "date_joined": user.date_joined.strftime("%d %b %Y"),
            }
        )

    def put(self, request):
        user = request.user
        profile = self._profile(user)
        username = str(request.data.get("username", user.username)).strip()
        email = str(request.data.get("email", user.email or "")).strip().lower()

        if not username:
            return Response({"error": "Username cannot be empty."}, status=400)
        if User.objects.filter(username__iexact=username).exclude(pk=user.pk).exists():
            return Response({"error": "Username already exists."}, status=400)
        if email and User.objects.filter(email__iexact=email).exclude(pk=user.pk).exists():
            return Response({"error": "Email is already used by another account."}, status=400)

        with transaction.atomic():
            user.username = username
            user.email = email
            if "name" in request.data:
                user.first_name = str(request.data.get("name", "")).strip()
            user.save()

            if "phone" in request.data:
                profile.phone = str(request.data.get("phone", "")).strip() or None
            if "country" in request.data:
                profile.country = str(request.data.get("country", "India")).strip() or "India"
            if "currency" in request.data:
                profile.currency = str(request.data.get("currency", "₹")).strip() or "₹"
            if "monthly_budget" in request.data:
                profile.monthly_budget = nonnegative_decimal(request.data.get("monthly_budget"))
            if "savings_goal" in request.data:
                profile.savings_goal = nonnegative_decimal(request.data.get("savings_goal"))
            for key in ("dark_mode", "budget_alerts", "bill_reminders"):
                if key in request.data:
                    setattr(profile, key, bool(request.data.get(key)))
            profile.save()

        return self.get(request)


class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        old_password = request.data.get("old_password", "")
        new_password = request.data.get("new_password", "")
        if not request.user.check_password(old_password):
            return Response({"error": "Current password is incorrect."}, status=400)
        try:
            validate_password(new_password, user=request.user)
        except DjangoValidationError as exc:
            return Response({"error": " ".join(exc.messages)}, status=400)
        request.user.set_password(new_password)
        request.user.save(update_fields=["password"])
        return Response({"message": "Password updated successfully."})


class AccountListCreateView(generics.ListCreateAPIView):
    serializer_class = AccountSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        ensure_default_accounts(self.request.user)
        return Account.objects.filter(user=self.request.user).order_by("created_at", "id")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class AccountDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = AccountSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Account.objects.filter(user=self.request.user)

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class ExpenseListCreateView(generics.ListCreateAPIView):
    serializer_class = ExpenseSerializer
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        qs = Expense.objects.filter(user=self.request.user).select_related("account")
        tx_type = self.request.query_params.get("transaction_type")
        category = self.request.query_params.get("category")
        start_date = self.request.query_params.get("start_date")
        end_date = self.request.query_params.get("end_date")
        if tx_type:
            qs = qs.filter(transaction_type=tx_type.upper())
        if category:
            qs = qs.filter(category__iexact=category)
        if start_date:
            qs = qs.filter(date__gte=start_date)
        if end_date:
            qs = qs.filter(date__lte=end_date)
        return qs.order_by("-date", "-id")

    def create(self, request, *args, **kwargs):
        data = request.data.copy()
        amount = safe_decimal(data.get("amount"))
        if amount <= 0:
            return Response({"error": "Amount must be greater than 0."}, status=400)

        tx_type = str(data.get("transaction_type", "EXPENSE")).upper().strip()
        if tx_type not in dict(Expense.TRANSACTION_TYPES):
            return Response({"error": "Invalid transaction type."}, status=400)
        data["transaction_type"] = tx_type
        data["amount"] = str(amount)
        data["title"] = str(data.get("title", "Quick Record")).strip() or "Quick Record"
        data["category"] = str(data.get("category", "General")).strip() or "General"
        data["payment_method"] = str(data.get("payment_method", "UPI")).strip() or "UPI"
        if not data.get("date"):
            data["date"] = timezone.localdate().isoformat()

        ensure_default_accounts(request.user)
        account_value = data.get("account")
        account = get_user_account(request.user, account_value)
        if account_value not in (None, "", "null", "undefined") and not account:
            return Response({"error": "Selected account was not found."}, status=400)
        if account is None:
            account = Account.objects.filter(user=request.user).order_by("id").first()
        if account:
            data["account"] = str(account.id)

        serializer = self.get_serializer(data=data)
        try:
            serializer.is_valid(raise_exception=True)
            with transaction.atomic():
                if account:
                    account = Account.objects.select_for_update().get(pk=account.pk, user=request.user)
                expense = serializer.save(user=request.user, account=account)
                if account:
                    account.balance = safe_decimal(account.balance) + balance_delta(tx_type, amount)
                    account.save(update_fields=["balance"])
        except ValidationError as exc:
            return Response(serializer_error_payload(exc), status=400)

        return Response(self.get_serializer(expense).data, status=status.HTTP_201_CREATED)


class ExpenseDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ExpenseSerializer
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_queryset(self):
        return Expense.objects.filter(user=self.request.user).select_related("account")

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        try:
            with transaction.atomic():
                expense = Expense.objects.select_for_update().get(pk=kwargs["pk"], user=request.user)
                old_amount = safe_decimal(expense.amount)
                old_type = expense.transaction_type
                old_account_id = expense.account_id
                data = request.data.copy()

                if "account" in data:
                    new_account = get_user_account(request.user, data.get("account"))
                    if data.get("account") not in (None, "", "null", "undefined") and not new_account:
                        return Response({"error": "Selected account was not found."}, status=400)
                    data["account"] = str(new_account.id) if new_account else ""
                else:
                    new_account = Account.objects.filter(pk=old_account_id, user=request.user).first() if old_account_id else None

                serializer = self.get_serializer(expense, data=data, partial=partial)
                serializer.is_valid(raise_exception=True)
                new_amount = safe_decimal(serializer.validated_data.get("amount", old_amount))
                new_type = serializer.validated_data.get("transaction_type", old_type)

                old_account = None
                if old_account_id:
                    old_account = Account.objects.select_for_update().filter(pk=old_account_id, user=request.user).first()
                if old_account:
                    old_account.balance = safe_decimal(old_account.balance) - balance_delta(old_type, old_amount)
                    old_account.save(update_fields=["balance"])

                updated = serializer.save(user=request.user, account=new_account)

                if new_account:
                    new_account = Account.objects.select_for_update().get(pk=new_account.pk, user=request.user)
                    new_account.balance = safe_decimal(new_account.balance) + balance_delta(new_type, new_amount)
                    new_account.save(update_fields=["balance"])
        except Expense.DoesNotExist:
            return Response({"error": "Transaction not found."}, status=404)
        except ValidationError as exc:
            return Response(serializer_error_payload(exc), status=400)

        return Response(self.get_serializer(updated).data)

    def destroy(self, request, *args, **kwargs):
        try:
            with transaction.atomic():
                expense = Expense.objects.select_for_update().get(pk=kwargs["pk"], user=request.user)
                if expense.account_id:
                    account = Account.objects.select_for_update().filter(pk=expense.account_id, user=request.user).first()
                    if account:
                        account.balance = safe_decimal(account.balance) - balance_delta(expense.transaction_type, expense.amount)
                        account.save(update_fields=["balance"])
                expense.delete()
        except Expense.DoesNotExist:
            return Response({"error": "Transaction not found."}, status=404)
        return Response(status=status.HTTP_204_NO_CONTENT)


class BillListCreateView(generics.ListCreateAPIView):
    serializer_class = BillSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Bill.objects.filter(user=self.request.user).order_by("is_paid", "due_date", "id")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class BillDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = BillSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Bill.objects.filter(user=self.request.user)

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class SavingsGoalListCreateView(generics.ListCreateAPIView):
    serializer_class = SavingsGoalSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return SavingsGoal.objects.filter(user=self.request.user).order_by("-created_at", "id")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class SavingsGoalDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = SavingsGoalSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return SavingsGoal.objects.filter(user=self.request.user)

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class MoneyDebtListCreateView(generics.ListCreateAPIView):
    serializer_class = MoneyDebtSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        qs = MoneyDebt.objects.filter(user=self.request.user).prefetch_related("payments")
        direction = self.request.query_params.get("direction")
        if direction:
            qs = qs.filter(direction=direction.upper())
        return qs.order_by("-created_at", "-id")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class MoneyDebtDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = MoneyDebtSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return MoneyDebt.objects.filter(user=self.request.user).prefetch_related("payments")

    def get_serializer_context(self):
        return {**super().get_serializer_context(), "request": self.request}


class DebtPaymentListCreateView(generics.ListCreateAPIView):
    serializer_class = DebtPaymentSerializer
    permission_classes = [IsAuthenticated]

    def _debt(self):
        return get_object_or_404(MoneyDebt, pk=self.kwargs["debt_id"], user=self.request.user)

    def get_queryset(self):
        return DebtPayment.objects.filter(debt=self._debt()).order_by("-payment_date", "-id")

    def create(self, request, *args, **kwargs):
        debt = self._debt()
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payment_amount = safe_decimal(serializer.validated_data["amount"])
        remaining = debt.remaining_amount
        if payment_amount > remaining:
            return Response({"error": f"Payment cannot exceed the remaining amount ({remaining})."}, status=400)

        with transaction.atomic():
            locked = MoneyDebt.objects.select_for_update().get(pk=debt.pk, user=request.user)
            payment = serializer.save(debt=locked)
            locked.amount_paid = safe_decimal(locked.amount_paid) + payment_amount
            remaining_after = locked.amount - locked.amount_paid
            locked.status = "PAID" if remaining_after <= 0 else "PARTIAL"
            if locked.due_date and remaining_after > 0 and locked.due_date < timezone.localdate():
                locked.status = "OVERDUE"
            locked.save(update_fields=["amount_paid", "status", "updated_at"])

        return Response(self.get_serializer(payment).data, status=status.HTTP_201_CREATED)


class DashboardSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        txs = Expense.objects.filter(user=request.user)
        total_exp = txs.filter(transaction_type="EXPENSE").aggregate(total=Sum("amount"))["total"] or Decimal("0")
        total_inc = txs.filter(transaction_type="INCOME").aggregate(total=Sum("amount"))["total"] or Decimal("0")
        total_bills = txs.filter(transaction_type="BILL").aggregate(total=Sum("amount"))["total"] or Decimal("0")
        net_balance = total_inc - total_exp - total_bills
        account_balance = Account.objects.filter(user=request.user).aggregate(total=Sum("balance"))["total"] or Decimal("0")
        ocr_count = txs.exclude(receipt_image="").exclude(receipt_image__isnull=True).count()
        profile, _ = UserProfile.objects.get_or_create(user=request.user)
        open_debts = MoneyDebt.objects.filter(user=request.user).exclude(status="PAID")
        borrowed_remaining = sum((item.remaining_amount for item in open_debts.filter(direction="BORROWED")), Decimal("0"))
        lent_remaining = sum((item.remaining_amount for item in open_debts.filter(direction="LENT")), Decimal("0"))
        unpaid_bills = Bill.objects.filter(user=request.user, is_paid=False).aggregate(total=Sum("amount"))["total"] or Decimal("0")
        savings_current = SavingsGoal.objects.filter(user=request.user).aggregate(total=Sum("current_amount"))["total"] or Decimal("0")
        return Response(
            {
                "total_income": float(total_inc),
                "total_expenses": float(total_exp),
                "total_bills": float(total_bills),
                "net_balance": float(net_balance),
                "account_balance": float(account_balance),
                "count": txs.count(),
                "ocr_scanned_count": ocr_count,
                "monthly_budget": float(profile.monthly_budget or 0),
                "borrowed_remaining": float(borrowed_remaining),
                "lent_remaining": float(lent_remaining),
                "unpaid_bills": float(unpaid_bills),
                "savings_current": float(savings_current),
            }
        )


class ReceiptScanView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]
    max_file_size = 10 * 1024 * 1024

    def post(self, request):
        file_obj = request.FILES.get("receipt")
        if not file_obj:
            return Response({"error": "No receipt image or PDF uploaded."}, status=400)
        if file_obj.size > self.max_file_size:
            return Response({"error": "File size exceeds the 10MB limit."}, status=400)

        filename = (file_obj.name or "receipt").lower()
        content_type = (getattr(file_obj, "content_type", "") or "").lower()
        is_pdf = filename.endswith(".pdf") or content_type == "application/pdf"
        is_image = content_type.startswith("image/") or filename.endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff"))
        if not (is_pdf or is_image):
            return Response({"error": "Only receipt images and PDF files are supported."}, status=400)

        extracted_text = ""
        try:
            if is_pdf:
                import pypdf

                reader = pypdf.PdfReader(file_obj)
                extracted_text = "\n".join((page.extract_text() or "") for page in reader.pages)
            else:
                from PIL import Image, ImageEnhance, ImageOps
                import pytesseract

                tesseract_cmd = os.getenv("TESSERACT_CMD", "").strip()
                if tesseract_cmd:
                    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd

                image = Image.open(file_obj).convert("RGB")
                gray = ImageEnhance.Sharpness(
                    ImageEnhance.Contrast(ImageOps.autocontrast(ImageOps.grayscale(image))).enhance(2.0)
                ).enhance(2.0)
                if max(gray.size) < 1800:
                    gray = gray.resize((gray.width * 2, gray.height * 2))
                threshold = gray.point(lambda p: 255 if p > 170 else 0)
                texts = []
                for variant, config in ((gray, "--oem 3 --psm 6"), (gray, "--oem 3 --psm 11"), (threshold, "--oem 3 --psm 6")):
                    text = pytesseract.image_to_string(variant, config=config).strip()
                    if text:
                        texts.append(text)
                extracted_text = max(texts, key=len) if texts else ""
        except Exception as exc:
            return Response(
                {"error": "Receipt text extraction failed.", "detail": str(exc)},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        if not extracted_text.strip():
            return Response(
                {"error": "No readable text was found. Try a clearer image or a text-based PDF."},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        parsed = IndiaReceiptExtractor.parse_document(extracted_text, filename)
        parsed["currency"] = detect_currency_from_text(extracted_text + " " + filename)
        parsed_amount = safe_decimal(parsed.get("amount"))
        parsed_date = parsed.get("date") or None

        duplicate = None
        if parsed_amount > 0 and parsed_date:
            duplicate = Expense.objects.filter(user=request.user, amount=parsed_amount, date=parsed_date).first()

        return Response(
            {
                "parsed_data": parsed,
                "is_duplicate": bool(duplicate),
                "duplicate_match": (
                    {
                        "id": duplicate.id,
                        "title": duplicate.title,
                        "amount": float(duplicate.amount),
                        "date": str(duplicate.date),
                    }
                    if duplicate
                    else None
                ),
            }
        )
