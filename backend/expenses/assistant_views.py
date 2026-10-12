import uuid

from django.utils import timezone
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .assistant_service import AssistantError, execute_command, prepare_command, serialize_command
from .models import AssistantCommand, AssistantProfile


def serialize_profile(profile):
    return {
        "assistant_name": profile.assistant_name,
        "language": profile.language,
        "voice_responses": profile.voice_responses,
        "personality": profile.personality,
        "confirmation_mode": profile.confirmation_mode,
        "quick_add": profile.quick_add,
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

        for field in ("voice_responses", "quick_add"):
            if field in request.data:
                value = request.data.get(field)
                if not isinstance(value, bool):
                    return Response({"error": f"{field.replace('_', ' ')} must be true or false."}, status=400)
                setattr(profile, field, value)

        profile.save()
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
            command, created = prepare_command(request.user, message, request_id)
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
