FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .

# collectstatic runs while the image is being built, before Railway injects the
# runtime DATABASE_URL. Use a non-routable build-only URL so production keeps
# requiring a real persistent PostgreSQL database at runtime without blocking
# the Docker image build.
RUN SECRET_KEY=build-only-secret DEBUG=False DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build python manage.py collectstatic --noinput

CMD ["sh", "-c", "python manage.py migrate --noinput && python manage.py flushexpiredtokens && gunicorn config.wsgi:application --preload --bind 0.0.0.0:${PORT:-8000} --workers 2 --timeout 120"]
