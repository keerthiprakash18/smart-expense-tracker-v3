import os

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from expenses.auth_views import LoginView, LogoutView, ThrottledTokenRefreshView

urlpatterns = [
    path("api/token/", LoginView.as_view(), name="token_obtain_pair"),
    path("api/token/refresh/", ThrottledTokenRefreshView.as_view(), name="token_refresh"),
    path("api/logout/", LogoutView.as_view(), name="logout"),
    path("api/", include("expenses.urls")),
]

# Dev convenience: plain static() media mount.
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Production without S3/R2: receipts are on the container filesystem and would
# otherwise 404. Serve them through an authenticated, traversal-safe view.
if getattr(settings, "MEDIA_SERVE_ENABLED", False) and not settings.DEBUG:
    from expenses.media_views import ProtectedMediaView

    urlpatterns.insert(0, path("media/<path:filepath>", ProtectedMediaView.as_view(), name="protected-media"))


if settings.DEBUG or os.getenv("ENABLE_ADMIN", "False").lower() in {"1", "true", "yes", "on"}:
    urlpatterns.append(path("admin/", admin.site.urls))
