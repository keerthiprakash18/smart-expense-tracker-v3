from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .models import SecuritySettings
from .security_utils import consume_recovery_code, verify_totp


class LoginRateThrottle(ScopedRateThrottle):
    """Rate-limits login by account, not just by IP.

    A pure IP bucket is too blunt: every user on a shared office NAT or a
    mobile carrier shares one bucket, so a handful of legitimate sign-ins can
    lock each other out. We scope the bucket to ``<account>:<client ip>``,
    which is also strictly better brute-force protection — an attacker is
    confined to the victim's bucket instead of a shared one. Requests that
    name an unknown account fall back to the IP-only bucket, so a probing
    scan still pays the cost.
    """

    scope = "login"

    def get_cache_key(self, request, view):
        ident = self.get_ident(request)
        try:
            from django.utils.http import quote_etag
        except ImportError:  # pragma: no cover - Django < 5.0 shim
            quote_etag = lambda value: value  # noqa: E731

        # ``request.data`` parses the request body, which can raise if a prior
        # consumer already read ``request.body`` raw. Throttling must never turn
        # a parse problem into a 500, so fall back to the IP-only bucket.
        try:
            identifier = str(request.data.get("username") or request.data.get("email") or "").strip()
        except Exception:
            identifier = ""
        account = quote_etag(identifier.lower()) if identifier else "unknown"
        return self.cache_format % {"scope": self.scope, "ident": f"{account}:{ident}"}


class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_classes = [LoginRateThrottle]

    def post(self, request):
        identifier = str(request.data.get("username") or request.data.get("email") or "").strip()
        password = request.data.get("password", "")
        otp = str(request.data.get("otp", "")).strip()
        if not identifier or not password:
            return Response({"detail": "Email/username and password are required."}, status=400)

        user = User.objects.filter(username__iexact=identifier).first()
        if user is None:
            user = User.objects.filter(email__iexact=identifier).first()
        authenticated = authenticate(request=request, username=user.username, password=password) if user else None
        if authenticated is None or not authenticated.is_active:
            return Response({"detail": "No active account found with the given credentials"}, status=status.HTTP_401_UNAUTHORIZED)

        security, _ = SecuritySettings.objects.get_or_create(user=authenticated)
        if security.two_factor_enabled:
            if not otp:
                return Response({"two_factor_required": True, "detail": "Enter your authenticator code or a recovery code."}, status=status.HTTP_202_ACCEPTED)
            if not verify_totp(security.totp_secret, otp) and not consume_recovery_code(security, otp):
                return Response({"two_factor_required": True, "detail": "Invalid authenticator or recovery code."}, status=status.HTTP_401_UNAUTHORIZED)

        refresh = RefreshToken.for_user(authenticated)
        return Response({"refresh": str(refresh), "access": str(refresh.access_token)}, status=200)


__all__ = ["LoginView", "LogoutView", "ThrottledTokenRefreshView"]



class ThrottledTokenRefreshView(TokenRefreshView):
    throttle_scope = "token_refresh"


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "security"

    def post(self, request):
        refresh_value = str(request.data.get("refresh", "")).strip()
        if not refresh_value:
            return Response({"error": "Refresh token is required."}, status=400)
        try:
            RefreshToken(refresh_value).blacklist()
        except Exception:
            return Response({"error": "Invalid refresh token."}, status=400)
        return Response({"message": "Signed out securely."})
