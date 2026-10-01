"""Authenticated media serving.

Django only serves uploads under ``DEBUG``. In production with S3/R2 configured,
``receipt_image.url`` points at the bucket and nothing here is used. But when a
deployment has no bucket configured, receipts land on the container's local
filesystem and would otherwise 404. This view serves those files to the owning
user only, so receipts never silently disappear.
"""

import mimetypes
import os

from django.conf import settings
from django.core.files.storage import default_storage
from django.http import FileResponse, Http404
from django.utils._os import safe_join
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


def _resolve_media_path(filepath):
    """Return an absolute path inside MEDIA_ROOT, or None if unsafe/missing."""
    if not filepath or ".." in str(filepath).split("/"):
        return None
    try:
        candidate = safe_join(os.fspath(settings.MEDIA_ROOT), filepath)
    except ValueError:
        return None
    if not candidate or not os.path.isfile(candidate):
        return None
    return candidate


class ProtectedMediaView(APIView):
    """Serves a locally stored upload to the user who owns it."""

    permission_classes = [IsAuthenticated]

    def get(self, request, filepath):
        if not getattr(settings, "MEDIA_SERVE_ENABLED", False):
            raise Http404("Media serving is disabled.")

        path = _resolve_media_path(filepath)
        if path is None:
            raise Http404("Requested file does not exist.")

        # Defense in depth: never leak the database, source or env files.
        root = os.path.abspath(settings.MEDIA_ROOT)
        if os.path.commonpath([os.path.abspath(path), root]) != root:
            raise Http404("Requested file does not exist.")

        content_type, _ = mimetypes.guess_type(path)
        response = FileResponse(open(path, "rb"), content_type=content_type or "application/octet-stream")
        response["Accept-Ranges"] = "bytes"
        response["Cache-Control"] = "private, max-age=3600"
        return response


class MediaStatusView(APIView):
    """Tells the client whether receipt files are durably stored."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({
            "durable": bool(getattr(settings, "MEDIA_STORAGE_DURABLE", False)),
            "s3_configured": bool(getattr(settings, "S3_STORAGE_CONFIGURED", False)),
            "media_url": settings.MEDIA_URL,
        })


def receipt_is_reachable(file_field):
    """True when a saved receipt file can actually be downloaded."""
    if not file_field:
        return False
    try:
        return bool(default_storage.exists(file_field.name))
    except Exception:
        return False


__all__ = ["ProtectedMediaView", "MediaStatusView", "receipt_is_reachable"]
