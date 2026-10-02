# AMEX UI

Standalone, self-hosted AMEX spending analytics. It includes a React web app, a Fastify API, a PostgreSQL schema, and username/password sign-up. Every new account has a separate household scope. **No household transactions, CSV files, passwords, API keys, or database backup are included.**

## Requirements

- Node.js **22.13+** (Node 21 is unsupported) and npm.
- PostgreSQL **16+** (the included Docker Compose setup uses PostgreSQL 17). Docker Compose is optional if you already run a dedicated PostgreSQL database.
- A browser and a German-language AMEX EUR activity CSV to import *privately* after setup. Never commit CSV exports.
- Optional: a DeepSeek API key for merchant classification and on-demand AI insights. Without it, import and deterministic analytics still work; merchants can be categorized manually.

## Fresh local setup

1. Clone this repository, then run `npm ci` from its root.
2. Copy `.env.example` to `.env`. Choose a **new, strong** `POSTGRES_PASSWORD`, and put the *same password* in `DATABASE_URL`. Do not reuse credentials from another project. The default Compose database is separate from other projects and binds to `127.0.0.1:5544`.
3. Start PostgreSQL: `docker compose up -d db`. Wait until `docker compose ps` reports the database healthy. If you use your own PostgreSQL server instead, create a **new empty database and user** and set `DATABASE_URL` to it. Migration intentionally refuses an existing shared database.
4. Install the schema: `npm run db:migrate`. This is safe to re-run after installation; it does not import sample data.
5. Start both servers: `npm run dev`. Visit **http://127.0.0.1:5173**. On Windows, run this from PowerShell with Node 22 on your PATH.
6. Choose **Create an account**, enter a username (3–30 lowercase letters, digits or underscores; start with a letter) and a password of at least 12 characters, and sign in. Your new account starts empty. In **Your cards**, name each card and enter only the last four digits of its CSV account identifier (you can add the second card later). Import your own CSV through the app; there is no sample household.

To stop the app, press Ctrl+C. `docker compose down` stops the database without deleting its volume. **Do not use `docker compose down -v` unless you deliberately want to erase your own data.**

### Optional AI

Add `DEEPSEEK_API_KEY` to your local `.env` and restart the API. The key stays on the server and is never sent to the browser. Classification is attempted for unknown merchant labels after confirmed import; imports are saved even when AI is unavailable. Retry classification is available in the UI. Analytics AI insights require a separate click and send computed facts, not the CSV or transaction list. DeepSeek API calls may incur charges; `AI_MAX_REQUEST_USD_CENTS` is a per-request safeguard, not a monthly cap. Review your provider's pricing and retention terms before enabling it.

### Existing PostgreSQL instead of Docker

Create a dedicated empty database, for example `amex`, with a dedicated user able to create tables in its schema. Set `DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/amex` in `.env`. Do **not** point this app at your household-finance database or another application's schema. To use a non-default Vite port, set `WEB_PORT` in the environment and match `WEB_ORIGIN` in `.env`. The API port is `API_PORT` (default 3001); the Vite dev server proxies `/api` to it.

## What is imported

This app accepts the German EUR AMEX activity export with the expected `Datum`, `Beschreibung`, `Betrag`, `Betreff` and related columns. It previews counts and totals first; commit is explicit. Purchases are positive EUR amounts; card bill payments are excluded and other credits are kept separate. An activity row without a stable source reference is held for identity review. Statement cycles run from the 7th through the following 6th, using Berlin calendar dates. Imported coverage may be partial. No bank login or payment execution is provided.

The CSV also has a `Konto #` account identifier column. The app extracts only the final four digits; it does not save full account numbers, cardholder names, or addresses. Choose either registered card or **Both cards together** above the dashboards; period totals, analytics, transaction lists and AI insights respect this selection. Rows without a recognizable account ending appear only in the combined view. Alerts, import history and merchant settings remain account-wide and are explicitly labeled as such. **Do not upload a real CSV to GitHub or an issue.** Each account's transactions and corrections are scoped by its household ID in PostgreSQL.

## Development and production

- `npm run typecheck` checks API and web types.
- `npm test` runs synthetic unit/API tests. Integration tests are skipped unless you set `TEST_DATABASE_URL` to a **disposable, already migrated** database; never use production data for tests.
- `npm run build` builds the API in `apps/api/dist` and web assets in `apps/web/dist`.
- For production, use Node 22, a dedicated PostgreSQL database, TLS/HTTPS with a reverse proxy, and serve `apps/web/dist` at your chosen `WEB_ORIGIN` with `/api` forwarded to the API. Set `NODE_ENV=production` and `WEB_ORIGIN=https://your-domain`; secure session cookies require HTTPS. Do not expose PostgreSQL to the public Internet. Configure backups of your own PostgreSQL volume separately; this repository contains no backup or transaction data.

### Privacy and safety

`.env`, `*.csv`, logs, build output and dependencies are gitignored. Never add your own exported CSV, credentials, `.env`, database volume, screenshots of private spending, or backup to a public repository. Sign-up creates independent households; accounts cannot query each other's data through the API. Use a unique password for each account. A public deployment permits new sign-ups; add external access controls/invitations before opening it to untrusted users.
