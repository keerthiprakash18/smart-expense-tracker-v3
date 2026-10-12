import hashlib
import secrets
import uuid
from datetime import timedelta

from django.utils import timezone
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .assistant_service import AssistantError, execute_command, prepare_command, serialize_command
from .models import AssistantCommand, AssistantNote, AssistantProfile, AssistantWakeToken


def _digest_wake_token(raw_token):
    return hashlib.sha256(str(raw_token or "").encode("utf-8")).hexdigest()


def _wake_token_record(request):
    authorization = str(request.headers.get("Authorization") or "").strip()
    if not authorization.lower().startswith("bearer "):
        return None
    raw_token = authorization.split(" ", 1)[1].strip()
    if not raw_token.startswith("sew_") or len(raw_token) < 32:
        return None
    record = (
        AssistantWakeToken.objects.select_related("user")
        .filter(
            token_digest=_digest_wake_token(raw_token),
            revoked_at__isnull=True,
            expires_at__gt=timezone.now(),
        )
        .first()
    )
    if not record:
        return None
    profile, _ = AssistantProfile.objects.get_or_create(user=record.user)
    if not profile.background_wake_enabled:
        return None
    record.last_used_at = timezone.now()
    record.save(update_fields=["last_used_at"])
    return record


def serialize_profile(profile):
    return {
        "assistant_name": profile.assistant_name,
        "language": profile.language,
        "voice_responses": profile.voice_responses,
        "personality": profile.personality,
        "confirmation_mode": profile.confirmation_mode,
        "quick_add": profile.quick_add,
        "background_wake_enabled": profile.background_wake_enabled,
        "wake_phrase": f"Hey {profile.assistant_name}",
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


class AssistantSettingsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def _profile(self, user):
        profile, _ = AssistantProfile.objects.get_or_create(user=user)
        return profile

    def get(self, request):
        return Response(serialize_profile(self._profile(request.user)))

    def patch(self, request):
        profile = self._profile(request.user)
        if "assistant_name" in request.data:
            name = str(request.data.get("assistant_name") or "").strip()
            if not name:
                return Response({"error": "Assistant name cannot be empty."}, status=400)
            if len(name) > 40:
                return Response({"error": "Assistant name must be 40 characters or fewer."}, status=400)
            if any(ch in name for ch in "<>{}[]\\/"):
                return Response({"error": "Use a simple assistant name without markup characters."}, status=400)
            profile.assistant_name = name

        choices = {
            "language": dict(AssistantProfile.LANGUAGE_CHOICES),
            "personality": dict(AssistantProfile.PERSONALITY_CHOICES),
            "confirmation_mode": dict(AssistantProfile.CONFIRMATION_CHOICES),
        }
        for field, allowed in choices.items():
            if field in request.data:
                value = str(request.data.get(field) or "").upper()
                if value not in allowed:
                    return Response({"error": f"Invalid {field.replace('_', ' ')}."}, status=400)
                setattr(profile, field, value)

        for field in ("voice_responses", "quick_add", "background_wake_enabled"):
            if field in request.data:
                value = request.data.get(field)
                if not isinstance(value, bool):
                    return Response({"error": f"{field.replace('_', ' ')} must be true or false."}, status=400)
                setattr(profile, field, value)

        profile.save()
        if not profile.background_wake_enabled:
            AssistantWakeToken.objects.filter(user=request.user, revoked_at__isnull=True).update(
                revoked_at=timezone.now()
            )
        return Response(serialize_profile(profile))


class AssistantMessageView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def post(self, request):
        message = str(request.data.get("message") or "").strip()
        raw_request_id = request.data.get("client_request_id")
        try:
            request_id = uuid.UUID(str(raw_request_id)) if raw_request_id else uuid.uuid4()
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "client_request_id must be a valid UUID."}, status=400)

        try:
            source = str(request.data.get("source") or "TEXT").upper()
            if source not in {"TEXT", "VOICE_APP", "VOICE_WAKE"}:
                source = "TEXT"
            command, created = prepare_command(request.user, message, request_id, source=source)
            return Response(serialize_command(command), status=201 if created else 200)
        except AssistantError as exc:
            return Response({"error": str(exc)}, status=400)


class AssistantConfirmView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def post(self, request, command_id):
        command = AssistantCommand.objects.filter(pk=command_id, user=request.user).first()
        if not command:
            return Response({"error": "Assistant command not found."}, status=404)
        if command.status == "COMPLETED":
            return Response(serialize_command(command))
        if command.status != "PENDING":
            return Response({"error": "This command is not waiting for confirmation."}, status=409)
        try:
            execute_command(command)
            return Response(serialize_command(command))
        except AssistantError as exc:
            return Response({"error": str(exc), "command": serialize_command(command)}, status=400)


class AssistantCancelView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def post(self, request, command_id):
        command = AssistantCommand.objects.filter(pk=command_id, user=request.user).first()
        if not command:
            return Response({"error": "Assistant command not found."}, status=404)
        if command.status == "COMPLETED":
            return Response({"error": "A completed financial action cannot be cancelled."}, status=409)
        if command.status != "CANCELLED":
            command.status = "CANCELLED"
            command.response_text = "Cancelled. No financial change was made."
            command.save(update_fields=["status", "response_text", "updated_at"])
        return Response(serialize_command(command))


class AssistantHistoryView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def get(self, request):
        commands = AssistantCommand.objects.filter(user=request.user).order_by("-created_at")[:20]
        return Response({"results": [serialize_command(item) for item in commands]})



class AssistantNotesView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def get(self, request):
        notes = AssistantNote.objects.filter(user=request.user).order_by("-created_at")[:50]
        return Response({
            "results": [
                {
                    "id": note.id,
                    "content": note.content,
                    "source": note.source,
                    "is_done": note.is_done,
                    "reminder_at": note.reminder_at.isoformat() if note.reminder_at else None,
                    "created_at": note.created_at.isoformat(),
                }
                for note in notes
            ]
        })



class AssistantWakeTokenView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "assistant"

    def post(self, request):
        profile, _ = AssistantProfile.objects.get_or_create(user=request.user)
        if not profile.background_wake_enabled:
            return Response({"error": "Enable Background Wake Mode first."}, status=409)

        AssistantWakeToken.objects.filter(
            user=request.user,
            revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())

        raw_token = "sew_" + secrets.token_urlsafe(32)
        expires_at = timezone.now() + timedelta(days=30)
        AssistantWakeToken.objects.create(
            user=request.user,
            token_digest=_digest_wake_token(raw_token),
            expires_at=expires_at,
        )
        return Response({
            "token": raw_token,
            "expires_at": expires_at.isoformat(),
            "scope": "assistant:wake",
        }, status=201)

    def delete(self, request):
        AssistantWakeToken.objects.filter(
            user=request.user,
            revoked_at__isnull=True,
        ).update(revoked_at=timezone.now())
        return Response(status=204)


class AssistantWakeMessageView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "assistant"

    def post(self, request):
        token_record = _wake_token_record(request)
        if not token_record:
            return Response({"error": "Wake session expired. Open the app to re-enable Wake Mode."}, status=401)

        message = str(request.data.get("message") or "").strip()
        raw_request_id = request.data.get("client_request_id")
        try:
            request_id = uuid.UUID(str(raw_request_id)) if raw_request_id else uuid.uuid4()
        except (ValueError, TypeError, AttributeError):
            return Response({"error": "client_request_id must be a valid UUID."}, status=400)

        try:
            command, created = prepare_command(
                token_record.user,
                message,
                request_id,
                source="VOICE_WAKE",
            )
            return Response(serialize_command(command), status=201 if created else 200)
        except AssistantError as exc:
            return Response({"error": str(exc)}, status=400)


class AssistantWakeConfirmView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "assistant"

    def post(self, request, command_id):
        token_record = _wake_token_record(request)
        if not token_record:
            return Response({"error": "Wake session expired."}, status=401)
        command = AssistantCommand.objects.filter(pk=command_id, user=token_record.user).first()
        if not command:
            return Response({"error": "Assistant command not found."}, status=404)
        if command.status == "COMPLETED":
            return Response(serialize_command(command))
        if command.status != "PENDING":
            return Response({"error": "This command is not waiting for confirmation."}, status=409)
        try:
            execute_command(command)
            return Response(serialize_command(command))
        except AssistantError as exc:
            return Response({"error": str(exc), "command": serialize_command(command)}, status=400)


class AssistantWakeCancelView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []
    throttle_scope = "assistant"

    def post(self, request, command_id):
        token_record = _wake_token_record(request)
        if not token_record:
            return Response({"error": "Wake session expired."}, status=401)
        command = AssistantCommand.objects.filter(pk=command_id, user=token_record.user).first()
        if not command:
            return Response({"error": "Assistant command not found."}, status=404)
        if command.status == "COMPLETED":
            return Response({"error": "A completed action cannot be cancelled."}, status=409)
        if command.status != "CANCELLED":
            command.status = "CANCELLED"
            command.response_text = "Cancelled. No financial change was made."
            command.save(update_fields=["status", "response_text", "updated_at"])
        return Response(serialize_command(command))
