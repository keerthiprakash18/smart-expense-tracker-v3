from decimal import Decimal

from rest_framework import serializers

from .models import (
    Account,
    AccountTransfer,
    AppNotification,
    Category,
    CategoryBudget,
    CreditCard,
    CreditCardActivity,
    MerchantRule,
    RecurringRule,
    SecuritySettings,
)


class UserOwnedSerializerMixin:
    def create(self, validated_data):
        validated_data["user"] = self.context["request"].user
        return super().create(validated_data)


class CategorySerializer(UserOwnedSerializerMixin, serializers.ModelSerializer):
    class Meta:
        model = Category
        fields = ["id", "name", "category_type", "color", "icon"]

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("Category name cannot be empty.")
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            qs = Category.objects.filter(user=request.user, name__iexact=value)
            if self.instance:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("A category with this name already exists.")
        return value


class CategoryBudgetSerializer(UserOwnedSerializerMixin, serializers.ModelSerializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    spent = serializers.SerializerMethodField()
    percent = serializers.SerializerMethodField()

    class Meta:
        model = CategoryBudget
        fields = ["id", "category", "amount", "period", "active", "spent", "percent", "created_at", "updated_at"]
        read_only_fields = ["id", "spent", "percent", "created_at", "updated_at"]

    def _spent(self, obj):
        request = self.context.get("request")
        if not request:
            return Decimal("0")
        from django.db.models import Sum
        from django.utils import timezone
        from .models import Expense

        today = timezone.localdate()
        return (
            Expense.objects.filter(
                user=request.user,
                category__iexact=obj.category,
                transaction_type__in=["EXPENSE", "BILL"],
                date__year=today.year,
                date__month=today.month,
            ).aggregate(total=Sum("amount"))["total"]
            or Decimal("0")
        )

    def get_spent(self, obj):
        return float(self._spent(obj))

    def get_percent(self, obj):
        if not obj.amount:
            return 0
        return round(float(self._spent(obj) / obj.amount * 100), 1)


class RecurringRuleSerializer(UserOwnedSerializerMixin, serializers.ModelSerializer):
    account_name = serializers.CharField(source="account.name", read_only=True, allow_null=True)
    account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.none(), required=False, allow_null=True)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    interval = serializers.IntegerField(min_value=1, max_value=365, required=False)

    class Meta:
        model = RecurringRule
        fields = [
            "id", "title", "amount", "transaction_type", "category", "account", "account_name",
            "payment_method", "frequency", "interval", "next_run", "end_date", "active", "last_run",
            "notes", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "account_name", "last_run", "created_at", "updated_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            self.fields["account"].queryset = Account.objects.filter(user=request.user)

    def validate(self, attrs):
        request = self.context.get("request")
        account = attrs.get("account", getattr(self.instance, "account", None))
        if account and request and account.user_id != request.user.id:
            raise serializers.ValidationError({"account": "You can only use your own account."})
        end_date = attrs.get("end_date", getattr(self.instance, "end_date", None))
        next_run = attrs.get("next_run", getattr(self.instance, "next_run", None))
        if end_date and next_run and end_date < next_run:
            raise serializers.ValidationError({"end_date": "End date must be on or after the next run date."})
        return attrs


class AccountTransferSerializer(serializers.ModelSerializer):
    from_account_name = serializers.CharField(source="from_account.name", read_only=True)
    to_account_name = serializers.CharField(source="to_account.name", read_only=True)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))
    from_account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.none())
    to_account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.none())

    class Meta:
        model = AccountTransfer
        fields = [
            "id", "from_account", "from_account_name", "to_account", "to_account_name",
            "amount", "date", "notes", "created_at",
        ]
        read_only_fields = ["id", "from_account_name", "to_account_name", "created_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            qs = Account.objects.filter(user=request.user)
            self.fields["from_account"].queryset = qs
            self.fields["to_account"].queryset = qs

    def validate(self, attrs):
        if attrs.get("from_account") == attrs.get("to_account"):
            raise serializers.ValidationError("Source and destination accounts must be different.")
        return attrs


class MerchantRuleSerializer(UserOwnedSerializerMixin, serializers.ModelSerializer):
    class Meta:
        model = MerchantRule
        fields = ["id", "merchant_key", "merchant_label", "category", "payment_method", "use_count", "updated_at"]
        read_only_fields = ["id", "merchant_key", "use_count", "updated_at"]


class CreditCardActivitySerializer(serializers.ModelSerializer):
    amount = serializers.DecimalField(max_digits=12, decimal_places=2, min_value=Decimal("0.01"))

    class Meta:
        model = CreditCardActivity
        fields = ["id", "activity_type", "amount", "date", "notes", "created_at"]
        read_only_fields = ["id", "created_at"]


class CreditCardSerializer(UserOwnedSerializerMixin, serializers.ModelSerializer):
    linked_account = serializers.PrimaryKeyRelatedField(queryset=Account.objects.none(), required=False, allow_null=True)
    linked_account_name = serializers.CharField(source="linked_account.name", read_only=True, allow_null=True)
    available_credit = serializers.SerializerMethodField()
    utilization_percent = serializers.SerializerMethodField()
    activities = CreditCardActivitySerializer(many=True, read_only=True)

    class Meta:
        model = CreditCard
        fields = [
            "id", "name", "last4", "credit_limit", "outstanding", "available_credit", "utilization_percent",
            "statement_day", "due_day", "linked_account", "linked_account_name", "active", "activities", "created_at",
        ]
        read_only_fields = ["id", "available_credit", "utilization_percent", "activities", "created_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        if request and request.user.is_authenticated:
            self.fields["linked_account"].queryset = Account.objects.filter(user=request.user)

    def validate_last4(self, value):
        value = (value or "").strip()
        if value and (len(value) != 4 or not value.isdigit()):
            raise serializers.ValidationError("Last 4 digits must contain exactly four numbers.")
        return value

    def validate_statement_day(self, value):
        if value < 1 or value > 28:
            raise serializers.ValidationError("Use a statement day between 1 and 28.")
        return value

    def validate_due_day(self, value):
        if value < 1 or value > 28:
            raise serializers.ValidationError("Use a due day between 1 and 28.")
        return value

    def get_available_credit(self, obj):
        return float(max(Decimal("0"), obj.credit_limit - obj.outstanding))

    def get_utilization_percent(self, obj):
        if not obj.credit_limit:
            return 0
        return round(float(obj.outstanding / obj.credit_limit * 100), 1)


class AppNotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppNotification
        fields = ["id", "kind", "title", "message", "due_date", "action_url", "is_read", "created_at"]
        read_only_fields = ["id", "kind", "title", "message", "due_date", "action_url", "created_at"]


class SecuritySettingsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SecuritySettings
        fields = ["email_verified", "two_factor_enabled", "updated_at"]
        read_only_fields = fields
