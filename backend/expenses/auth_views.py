from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

from .models import SecuritySettings
from .security_utils import consume_recovery_code, verify_totp


def _refresh_cookie_name():
    return getattr(settings, "JWT_REFRESH_COOKIE_NAME", "smart_expense_refresh")


def _set_refresh_cookie(response, token):
    response.set_cookie(
        _refresh_cookie_name(),
        str(token),
        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        httponly=True,
        secure=getattr(settings, "JWT_COOKIE_SECURE", not settings.DEBUG),
        samesite=getattr(settings, "JWT_COOKIE_SAMESITE", "None" if not settings.DEBUG else "Lax"),
        path=getattr(settings, "JWT_COOKIE_PATH", "/api/"),
    )


def _clear_refresh_cookie(response):
    response.delete_cookie(
        _refresh_cookie_name(),
        path=getattr(settings, "JWT_COOKIE_PATH", "/api/"),
        samesite=getattr(settings, "JWT_COOKIE_SAMESITE", "None" if not settings.DEBUG else "Lax"),
    )


def _refresh_from_request(request):
    return str(request.COOKIES.get(_refresh_cookie_name()) or request.data.get("refresh") or "").strip()


def _require_xhr_for_cookie(request):
    if request.COOKIES.get(_refresh_cookie_name()) and request.headers.get("X-Requested-With") != "XMLHttpRequest":
        return Response({"detail": "Invalid refresh request."}, status=status.HTTP_403_FORBIDDEN)
    return None


class LoginRateThrottle(ScopedRateThrottle):
    scope = "login"

    def get_cache_key(self, request, view):
        ident = self.get_ident(request)
        try:
            from django.utils.http import quote_etag
        except ImportError:
            quote_etag = lambda value: value  # noqa: E731
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
        response = Response({"access": str(refresh.access_token)}, status=200)
        _set_refresh_cookie(response, refresh)
        return response


class ThrottledTokenRefreshView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "token_refresh"

    def post(self, request):
        rejected = _require_xhr_for_cookie(request)
        if rejected:
            return rejected
        refresh_value = _refresh_from_request(request)
        if not refresh_value:
            response = Response({"detail": "Session expired."}, status=status.HTTP_401_UNAUTHORIZED)
            _clear_refresh_cookie(response)
            return response
        serializer = TokenRefreshSerializer(data={"refresh": refresh_value})
        try:
            serializer.is_valid(raise_exception=True)
        except (User.DoesNotExist, InvalidToken, TokenError, serializers.ValidationError):
            response = Response({"detail": "Invalid or expired session."}, status=status.HTTP_401_UNAUTHORIZED)
            _clear_refresh_cookie(response)
            return response
        data = serializer.validated_data
        response = Response({"access": data["access"]}, status=200)
        if data.get("refresh"):
            _set_refresh_cookie(response, data["refresh"])
        return response


class LogoutView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "security"

    def post(self, request):
        rejected = _require_xhr_for_cookie(request)
        if rejected:
            return rejected
        refresh_value = _refresh_from_request(request)
        if refresh_value:
            try:
                RefreshToken(refresh_value).blacklist()
            except Exception:
                pass
        response = Response({"message": "Signed out securely."})
        _clear_refresh_cookie(response)
        return response


__all__ = ["LoginView", "LogoutView", "ThrottledTokenRefreshView"]
