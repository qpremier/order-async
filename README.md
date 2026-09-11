# OrderRelay

OrderRelay is a Shopify embedded app for reliable external order imports. The app is being evolved incrementally from the Shopify React Router template.

Phase 4 adds streaming CSV validation, canonical external-order identity and hashing, draft import previews, explicit SKU mapping, tenant-safe import details, and local keyset pagination. Shopify order creation and dead-letter replay remain later phases.

## Stack

- React Router 7 and React 18
- Shopify App Bridge and Shopify React Router authentication helpers
- Prisma with PostgreSQL
- Redis-backed BullMQ queues
- Docker and Docker Compose for local infrastructure
- Vitest for foundation and queue/outbox tests

## Local Setup

Install dependencies with npm so `package-lock.json` stays authoritative:

```sh
npm install
```

Start local infrastructure:

```sh
docker compose up -d postgres redis
```

Copy `.env.example` to `.env` for non-Shopify-CLI commands and fill the Shopify values supplied by your app configuration. The default local database URL is:

```sh
postgresql://orderrelay:orderrelay@localhost:5432/orderrelay_development?schema=public
```

`WEB_DATABASE_URL` and `WEB_REDIS_URL` use Compose service hostnames for the optional web container. Keep `DATABASE_URL` and `REDIS_URL` pointed at `localhost` for commands run from the host.

Generate the Prisma client and apply migrations:

```sh
npm run setup
```

Run the Shopify development server:

```sh
npm run dev
```

Run the worker in a separate terminal:

```sh
npm run worker:dev
```

## Useful Commands

```sh
npm run prisma:generate
npm run migrate:deploy
npm run migrate:dev
npm run worker:dev
npm run worker:build
npm run worker:start
npm run lint
npm run typecheck
npm test
npm run build
```

## Health Checks

- `GET /health` returns process liveness without checking dependencies.
- `GET /ready` validates required environment, PostgreSQL connectivity, and Redis connectivity.

Health responses never include secrets or raw connection strings.

## Catalog Cache

The app dashboard shows catalog cache freshness, active cached variants, ambiguous SKU counts, and a cursor-paginated list of cached variants. The `Sync catalog` action creates a durable `CatalogSyncRun` and `catalog.bootstrap` outbox event; the worker performs Shopify Admin GraphQL pagination asynchronously.

Product create, update, and delete webhooks are authenticated, deduplicated in PostgreSQL, converted into catalog refresh outbox events, and returned quickly. Webhook routes do not run Shopify GraphQL calls inline.

The catalog query requires the `read_products` scope.

## Draft CSV Imports

Open **New import** in the embedded app, enter a stable source-system identifier, and upload a CSV. Required columns are:

```text
external_order_id,processed_at,email,currency,sku,quantity,unit_price
```

The parser enforces `IMPORT_MAX_BYTES` and `IMPORT_MAX_ROWS`, groups lines by external order ID, validates order-level consistency, and stores normalized draft records without retaining the uploaded file. Preview and mapping reads use the local PostgreSQL catalog only; Phase 4 makes no Shopify order API calls.

Repeated batch keys return the original batch. A repeated source/external order with the same canonical payload reuses its durable intent; changed content returns a conflict instead of overwriting it.

## Phase 2 Diagnostic Flow

The authenticated `POST /app/phase2-diagnostic` route creates a harmless `phase2.diagnostic` `OutboxEvent` in PostgreSQL. The worker-side dispatcher publishes it to the BullMQ `maintenance` queue with a deterministic job ID, and the maintenance worker verifies the event still exists before logging a safe handled message.

The diagnostic payload contains operational IDs only. It does not call Shopify and does not include tokens, customer data, or raw import data.

## Docker Compose

Default Compose startup runs only infrastructure:

```sh
docker compose up -d postgres redis
```

To run the web container as well, provide Shopify credentials in the environment and use the app profile:

```sh
docker compose --profile app up --build
```

The app profile includes a one-shot `migrate` service, plus separate `web` and `worker` services built from the same image.

## Documentation

- `docs/implementation-plan.md`
- `docs/architecture.md`
- `docs/adr/001-postgresql-and-bullmq.md`
- `docs/adr/002-idempotency-and-transactional-outbox.md`
