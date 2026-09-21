"""Legacy module kept for import compatibility.

CORS is handled by django-cors-headers in config.settings. A custom middleware
that blindly adds Access-Control-Allow-Origin: * is intentionally not used.
"""
