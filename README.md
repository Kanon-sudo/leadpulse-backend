## Leadpulse backend

Minimal backend for phase 2:

- `GET /health`
- `GET /db/ping`
- `POST /auth/session`
- `GET /billing/state`
- `POST /billing/checkout-session`
- `POST /billing/customer-portal`
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
