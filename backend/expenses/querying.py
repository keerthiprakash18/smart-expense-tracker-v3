from django.db.models import Q

from .models import Expense


def filtered_expenses(user, params):
    """Return the authenticated user's ledger filtered entirely on the server."""
    qs = Expense.objects.filter(user=user).select_related("account")

    tx_type = str(params.get("transaction_type") or "").strip().upper()
    category = str(params.get("category") or "").strip()
    payment_method = str(params.get("payment_method") or "").strip()
    start_date = str(params.get("start_date") or "").strip()
    end_date = str(params.get("end_date") or "").strip()
    search = str(params.get("search") or "").strip()

    if tx_type:
        qs = qs.filter(transaction_type=tx_type)
    if category:
        qs = qs.filter(category__iexact=category)
    if payment_method:
        qs = qs.filter(payment_method__iexact=payment_method)
    if start_date:
        qs = qs.filter(date__gte=start_date)
    if end_date:
        qs = qs.filter(date__lte=end_date)
    if search:
        qs = qs.filter(
            Q(title__icontains=search)
            | Q(category__icontains=search)
            | Q(payment_method__icontains=search)
            | Q(notes__icontains=search)
            | Q(account__name__icontains=search)
        )

    return qs.order_by("-date", "-id")
