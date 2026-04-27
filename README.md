## Leadpulse backend

Minimal backend for phase 2:

- `GET /health`
- `GET /db/ping`
- `POST /auth/session`
- `GET /billing/state`
- `POST /billing/checkout-session`
- `POST /billing/customer-portal`
- `POST /verify/email`
- `POST /verify/bulk`
- `POST /stripe/webhook`

Required env vars:

- `LEADPULSE_DB_HOST`
- `LEADPULSE_DB_PORT`
- `LEADPULSE_DB_NAME`
- `LEADPULSE_DB_USER`
- `LEADPULSE_DB_PASSWORD`
- `FIREBASE_PROJECT_ID`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER_MONTHLY`
- `STRIPE_PRICE_GROWTH_MONTHLY`
- `STRIPE_PRICE_OPS_MONTHLY`

Optional:

- `LEADPULSE_DB_SSLMODE=require`
- `CORS_ORIGIN=https://leadpulse.email`
- `HOST=127.0.0.1`
- `PORT=8787`
- `PUBLIC_APP_URL=https://leadpulse.email`
- `LEADPULSE_VERIFY_MAX_BATCH=1000`
- `LEADPULSE_VERIFY_DOMAIN_CACHE_TTL_MS=86400000`
- `LEADPULSE_VERIFY_EMAIL_CACHE_TTL_MS=604800000`
- `LEADPULSE_VERIFY_DNS_TIMEOUT_MS=6000`
- `LEADPULSE_VERIFY_RDAP_TIMEOUT_MS=4500`
- `LEADPULSE_SMTP_PROBE_ENABLED=false`
- `LEADPULSE_SMTP_MAIL_FROM=verify@leadpulse.email`
- `LEADPULSE_SMTP_HELO_NAME=leadpulse.email`
- `LEADPULSE_SMTP_TIMEOUT_MS=5000`

Email verification endpoints require the same Firebase bearer token as the billing/account endpoints.

`POST /verify/email`

```json
{
  "email": "person@example.com",
  "dns": true,
  "smtp": false
}
```

`POST /verify/bulk`

```json
{
  "emails": ["person@example.com", "role@example.com"],
  "dns": true,
  "smtp": false
}
```

SMTP probing is disabled by default. Enable it only from a VPS/network that allows outbound port 25 and after configuring a sender domain with sane DNS/reputation.
