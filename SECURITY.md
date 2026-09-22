# Security Policy

## Supported version
The production main branch is the supported version.

## Reporting a vulnerability
Please use GitHub's private security advisory flow for this repository instead of opening a public issue with exploit details.

## Security controls
The application uses HTTPS-only production deployment, strict CORS, JWT rotation and refresh-token blacklisting, optional TOTP 2FA with hashed one-time recovery codes, user-scoped API access, request-size limits, rate limits on sensitive endpoints, security headers, upload validation, database transactions for balance changes, and automated CI checks.

Never commit production secrets, database credentials, storage keys, SMTP/API keys, TOTP secrets or recovery codes.
