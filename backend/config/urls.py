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

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)


if settings.DEBUG or os.getenv("ENABLE_ADMIN", "False").lower() in {"1", "true", "yes", "on"}:
    urlpatterns.append(path("admin/", admin.site.urls))
