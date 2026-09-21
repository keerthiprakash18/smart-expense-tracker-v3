from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken

from .models import SecuritySettings
from .security_utils import verify_totp
from .views import ChangePasswordView, RegisterView, UserProfileView


class LoginView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

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
                return Response({"two_factor_required": True, "detail": "Enter the 6-digit authenticator code."}, status=status.HTTP_202_ACCEPTED)
            if not verify_totp(security.totp_secret, otp):
                return Response({"two_factor_required": True, "detail": "Invalid authenticator code."}, status=status.HTTP_401_UNAUTHORIZED)

        refresh = RefreshToken.for_user(authenticated)
        return Response({"refresh": str(refresh), "access": str(refresh.access_token)}, status=200)


__all__ = ["LoginView", "RegisterView", "UserProfileView", "ChangePasswordView"]
