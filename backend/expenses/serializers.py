from decimal import Decimal

from rest_framework import serializers

from .models import Account, Bill, DebtPayment, Expense, MoneyDebt, SavingsGoal


class AccountSerializer(serializers.ModelSerializer):
    balance = serializers.DecimalField(max_digits=12, decimal_places=2, required=False)

    class Meta:
        model = Account
        fields = ["id", "name", "account_type", "balance", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Account name cannot be empty.")
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            qs = Account.objects.filter(user=request.user, name__iexact=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("You already have an account with this name.")
        return value

    def create(self, validated_data):
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            raise serializers.ValidationError("Authenticated user required.")
        validated_data["user"] = request.user
        return super().create(validated_data)

    def update(self, instance, validated_data):
        validated_data.pop("user", None)
        return super().update(instance, validated_data)


class ExpenseSerializer(serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True, allow_null=True)
    account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.none(), required=False, allow_null=True)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    ocr_confidence = serializers.DecimalField(max_digits=5, decimal_places=2, min_value=Decimal("0"), max_value=Decimal("100"), required=False, allow_null=True)

    class Meta:
        model = Expense
        fields = ["id", "user", "account", "account_name", "title", "amount", "transaction_type", "category", "payment_method", "date", "time", "notes", "is_recurring", "receipt_image", "ocr_confidence", "created_at"]
        read_only_fields = ["id", "user", "account_name", "created_at"]
        extra_kwargs = {
            "title": {"required": False}, "category": {"required": False}, "payment_method": {"required": False},
            "date": {"required": False}, "time": {"required": False}, "notes": {"required": False, "allow_blank": True, "allow_null": True},
            "is_recurring": {"required": False}, "receipt_image": {"required": False, "allow_null": True}, "transaction_type": {"required": False},
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request and getattr(request, "user", None) and request.user.is_authenticated:
            self.fields["account"].queryset = Account.objects.filter(user=request.user)

    def validate_title(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Title cannot be empty.")
        return value

    def validate_category(self, value):
        return (value or "General").strip() or "General"

    def validate_payment_method(self, value):
        return (value or "UPI").strip() or "UPI"

    def validate_time(self, value):
        value = (value or "").strip()
        if not value:
            return "12:00"
        if len(value) > 10:
            raise serializers.ValidationError("Time must be 10 characters or fewer.")
        return value

    def validate(self, attrs):
        request = self.context.get("request")
        account = attrs.get("account")
        if account is not None and request and request.user.is_authenticated and account.user_id != request.user.id:
            raise serializers.ValidationError({"account": "You can only use your own account."})
        transaction_type = attrs.get("transaction_type", getattr(self.instance, "transaction_type", "EXPENSE"))
        if transaction_type not in dict(Expense.TRANSACTION_TYPES):
            raise serializers.ValidationError({"transaction_type": "Invalid transaction type."})
        return attrs

    def create(self, validated_data):
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            validated_data["user"] = request.user
        return super().create(validated_data)

    def update(self, instance, validated_data):
        validated_data.pop("user", None)
        return super().update(instance, validated_data)


class BillSerializer(serializers.ModelSerializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))

    class Meta:
        model = Bill
        fields = ["id", "title", "amount", "due_date", "category", "is_paid", "is_recurring", "created_at"]
        read_only_fields = ["id", "created_at"]

    def create(self, validated_data):
        validated_data["user"] = self.context["request"].user
        return super().create(validated_data)


class SavingsGoalSerializer(serializers.ModelSerializer):
    target_amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    current_amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.00"), required=False)
    progress_percent = serializers.SerializerMethodField()

    class Meta:
        model = SavingsGoal
        fields = ["id", "name", "target_amount", "current_amount", "target_date", "icon", "progress_percent", "created_at"]
        read_only_fields = ["id", "progress_percent", "created_at"]

    def get_progress_percent(self, obj):
        if not obj.target_amount:
            return 0
        return round(min(100, float(obj.current_amount / obj.target_amount * 100)), 1)

    def validate(self, attrs):
        target = attrs.get("target_amount", getattr(self.instance, "target_amount", Decimal("0")))
        current = attrs.get("current_amount", getattr(self.instance, "current_amount", Decimal("0")))
        if current > target:
            raise serializers.ValidationError({"current_amount": "Current savings cannot exceed the target amount."})
        return attrs

    def create(self, validated_data):
        validated_data["user"] = self.context["request"].user
        return super().create(validated_data)


class DebtPaymentSerializer(serializers.ModelSerializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))

    class Meta:
        model = DebtPayment
        fields = ["id", "amount", "payment_date", "notes", "created_at"]
        read_only_fields = ["id", "created_at"]


class MoneyDebtSerializer(serializers.ModelSerializer):
    remaining_amount = serializers.DecimalField(max_digits=12, decimal_places=2, read_only=True)
    payments = DebtPaymentSerializer(many=True, read_only=True)

    class Meta:
        model = MoneyDebt
        fields = ["id", "direction", "person_name", "amount", "amount_paid", "remaining_amount", "transaction_date", "due_date", "purpose", "notes", "status", "payments", "created_at", "updated_at"]
        read_only_fields = ["id", "amount_paid", "remaining_amount", "status", "payments", "created_at", "updated_at"]

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Amount must be greater than zero.")
        return value

    def create(self, validated_data):
        validated_data["user"] = self.context["request"].user
        return super().create(validated_data)
