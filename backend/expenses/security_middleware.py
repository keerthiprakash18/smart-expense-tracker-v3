import uuid

from django.http import JsonResponse


class SecurityFirewallMiddleware:
    """Application-edge request guard and response hardening."""

    blocked_methods = {"TRACE", "TRACK", "CONNECT"}
    max_body_bytes = 12 * 1024 * 1024

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        request.request_id = request_id

        if request.method.upper() in self.blocked_methods:
            return self._harden(JsonResponse({"error": "Method not allowed."}, status=405), request_id, request.path)

        raw_length = request.META.get("CONTENT_LENGTH")
        if raw_length:
            try:
                if int(raw_length) > self.max_body_bytes:
                    return self._harden(JsonResponse({"error": "Request body is too large."}, status=413), request_id, request.path)
            except (TypeError, ValueError):
                pass

        return self._harden(self.get_response(request), request_id, request.path)

    @staticmethod
    def _harden(response, request_id, path):
        response["X-Request-ID"] = request_id
        response["X-Content-Type-Options"] = "nosniff"
        response["X-Frame-Options"] = "DENY"
        response["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=(), payment=()"
        response["Cross-Origin-Opener-Policy"] = "same-origin"
        if path.startswith("/api/"):
            response["Cache-Control"] = "no-store, max-age=0"
            response["Pragma"] = "no-cache"
            response["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        return response
