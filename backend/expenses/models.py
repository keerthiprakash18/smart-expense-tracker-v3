from django.db import models
from django.contrib.auth.models import User
from decimal import Decimal
from django.utils import timezone

class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    phone = models.CharField(max_length=20, blank=True, null=True)
    country = models.CharField(max_length=50, default='India')
    currency = models.CharField(max_length=10, default='₹')
    monthly_budget = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('45000.00'))
    savings_goal = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('100000.00'))
    dark_mode = models.BooleanField(default=True)
    budget_alerts = models.BooleanField(default=True)
    bill_reminders = models.BooleanField(default=True)

    def __str__(self):
        return f"Profile: {self.user.username}"

class Account(models.Model):
    ACCOUNT_TYPES = [
        ('BANK', 'Bank Account'),
        ('UPI', 'UPI'),
        ('CASH', 'Cash'),
        ('CARD', 'Credit / Debit Card'),
        ('WALLET', 'Digital Wallet'),
        ('CUSTOM', 'Custom Account')
    ]
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True, related_name='accounts')
    name = models.CharField(max_length=100, default='Primary Account')
    account_type = models.CharField(max_length=20, choices=ACCOUNT_TYPES, default='BANK')
    balance = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))
    created_at = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return f"{self.name} - {self.balance}"

class Category(models.Model):
    CATEGORY_TYPES = [
        ('EXPENSE', 'Expense'),
        ('INCOME', 'Income')
    ]
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True, related_name='custom_categories')
    name = models.CharField(max_length=100)
    category_type = models.CharField(max_length=10, choices=CATEGORY_TYPES, default='EXPENSE')
    color = models.CharField(max_length=20, default='#0A84FF')
    icon = models.CharField(max_length=50, default='Tag')

    class Meta:
        verbose_name_plural = "Categories"

    def __str__(self):
        return f"{self.name} ({self.category_type})"

class Expense(models.Model):
    TRANSACTION_TYPES = [
        ('EXPENSE', 'Expense'),
        ('INCOME', 'Income'),
        ('TRANSFER', 'Transfer'),
        ('BILL', 'Bill Payment')
    ]
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True, related_name='expenses')
    account = models.ForeignKey(Account, on_delete=models.SET_NULL, null=True, blank=True, related_name='transactions')
    title = models.CharField(max_length=200, default='Transaction')
    amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))
    transaction_type = models.CharField(max_length=10, choices=TRANSACTION_TYPES, default='EXPENSE')
    category = models.CharField(max_length=100, default='General')
    payment_method = models.CharField(max_length=50, default='UPI')
    date = models.DateField(default=timezone.now)
    time = models.CharField(max_length=10, default='12:00')
    notes = models.TextField(blank=True, null=True)
    is_recurring = models.BooleanField(default=False)
    receipt_image = models.ImageField(upload_to='receipts/', blank=True, null=True)
    ocr_confidence = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ['-date', '-id']

    def __str__(self):
        return f"{self.title} - {self.amount} ({self.transaction_type})"

class Bill(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='bills')
    title = models.CharField(max_length=150)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    due_date = models.DateField()
    category = models.CharField(max_length=100, default='Bills & Utilities')
    is_paid = models.BooleanField(default=False)
    is_recurring = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return f"{self.title} - Due: {self.due_date}"

class SavingsGoal(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='savings_goals')
    name = models.CharField(max_length=150)
    target_amount = models.DecimalField(max_digits=12, decimal_places=2)
    current_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.00'))
    target_date = models.DateField(null=True, blank=True)
    icon = models.CharField(max_length=50, default='🎯')
    created_at = models.DateTimeField(default=timezone.now)

    def __str__(self):
        return f"{self.name} - {self.current_amount}/{self.target_amount}"

# ============================================================
# MONEY HUB - BORROWED / LENT MONEY
# ============================================================

class MoneyDebt(models.Model):
    DIRECTION_CHOICES = [
        ("BORROWED", "I Owe"),
        ("LENT", "Owed to Me"),
    ]

    STATUS_CHOICES = [
        ("PENDING", "Pending"),
        ("PARTIAL", "Partially Paid"),
        ("PAID", "Paid"),
        ("OVERDUE", "Overdue"),
    ]

    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="money_debts"
    )

    direction = models.CharField(
        max_length=10,
        choices=DIRECTION_CHOICES
    )

    person_name = models.CharField(
        max_length=150
    )

    amount = models.DecimalField(
        max_digits=12,
        decimal_places=2
    )

    amount_paid = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal("0.00")
    )

    transaction_date = models.DateField(
        default=timezone.now
    )

    due_date = models.DateField(
        null=True,
        blank=True
    )

    purpose = models.CharField(
        max_length=200,
        blank=True,
        default=""
    )

    notes = models.TextField(
        blank=True,
        null=True
    )

    status = models.CharField(
        max_length=10,
        choices=STATUS_CHOICES,
        default="PENDING"
    )

    created_at = models.DateTimeField(
        default=timezone.now
    )

    updated_at = models.DateTimeField(
        auto_now=True
    )

    class Meta:
        ordering = ["-created_at", "-id"]

    @property
    def remaining_amount(self):
        remaining = self.amount - self.amount_paid

        if remaining < Decimal("0.00"):
            return Decimal("0.00")

        return remaining

    def __str__(self):
        return (
            f"{self.person_name} - "
            f"{self.amount} ({self.direction})"
        )


# ============================================================
# MONEY HUB - REPAYMENT HISTORY
# ============================================================

class DebtPayment(models.Model):
    debt = models.ForeignKey(
        MoneyDebt,
        on_delete=models.CASCADE,
        related_name="payments"
    )

    amount = models.DecimalField(
        max_digits=12,
        decimal_places=2
    )

    payment_date = models.DateField(
        default=timezone.now
    )

    notes = models.TextField(
        blank=True,
        null=True
    )

    created_at = models.DateTimeField(
        default=timezone.now
    )

    class Meta:
        ordering = ["-payment_date", "-id"]

    def __str__(self):
        return (
            f"{self.debt.person_name} - "
            f"Payment {self.amount}"
        )