## Leadpulse backend

Minimal backend for phase 2:

- `GET /health`
- `GET /db/ping`
- `POST /auth/session`

Required env vars:

- `LEADPULSE_DB_HOST`
- `LEADPULSE_DB_PORT`
- `LEADPULSE_DB_NAME`
- `LEADPULSE_DB_USER`
- `LEADPULSE_DB_PASSWORD`
- `FIREBASE_PROJECT_ID`

Optional:

- `LEADPULSE_DB_SSLMODE=require`
- `CORS_ORIGIN=https://leadpulse.email`
- `HOST=127.0.0.1`
- `PORT=8787`
