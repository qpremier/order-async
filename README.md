# OrderRelay

OrderRelay is a Shopify embedded app for reliable CSV-based external order imports. It validates orders against a local catalog cache, persists durable order intent, and creates Shopify orders asynchronously through a transactional outbox and BullMQ workers.

The system targets effectively-once business behavior under at-least-once delivery. It does not claim mathematically guaranteed exactly-once order creation: inconclusive Shopify writes enter read-only reconciliation before any further create attempt.

## Architecture

```mermaid
flowchart LR
  Merchant[Merchant in Shopify Admin] --> Web[React Router web]
  Web --> DB[(PostgreSQL source of truth)]
  Webhooks[Shopify webhooks] --> Web
  DB --> Dispatcher[Transactional outbox dispatcher]
  Dispatcher --> Redis[(Redis and BullMQ)]
  Redis --> Worker[Worker process]
  Worker --> DB
  Worker --> Shopify[Shopify Admin GraphQL]
  Shopify --> Webhooks
```

HTTP actions persist local state and outbox rows; they do not create batches of Shopify orders inline. Redis transports work, while PostgreSQL remains authoritative for imports, order identities, progress, webhook receipts, and dead-letter history. See [the architecture guide](docs/architecture.md) for the detailed workflows and idempotency sequence.

## Stack

- React Router 7 and React 18
- Shopify App Bridge and Shopify React Router authentication helpers
- Prisma with PostgreSQL
- Redis-backed BullMQ queues
- Docker and Docker Compose for local infrastructure
- Vitest for foundation and queue/outbox tests

## Local Setup

Prerequisites:

- Node.js `>=20.19 <22` or `>=22.12`
- npm, using the checked-in `package-lock.json`
- Docker with Compose
- Shopify CLI and a Shopify development store for embedded-app verification

Install the exact locked dependencies:

```sh
npm ci
```

Start local infrastructure:

```sh
docker compose up -d postgres redis
```

Copy `.env.example` to `.env`. Prisma and Docker Compose read this file; commands launched directly in a separate shell, including `npm run worker:dev`, must also receive these variables in their process environment. Fill the Shopify values supplied by your app configuration. The default host database URL is:

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

The worker requires the same `DATABASE_URL`, `REDIS_URL`, Shopify credentials, app URL, and scopes as the web process. For an all-container deployment-style run, configure a publicly reachable Shopify app URL and use:

```sh
docker compose --profile app up --build
```

That profile runs migrations once, then starts separate `web` and `worker` services from the same image.

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

### Sample files

- `examples/orders-valid.csv` contains two orders and three order lines. Its `SKU-RED` and `SKU-BLUE` values must exist in the connected store cache or be explicitly mapped.
- `examples/orders-missing-sku.csv` demonstrates the `NEEDS_MAPPING` workflow.
- `examples/orders-invalid.csv` demonstrates safe validation errors for invalid timestamp, email, currency, quantity, and price values.
- `examples/orders-duplicate-external-id.csv` reuses `ERP-1001` with changed content. Upload `orders-valid.csv` first, then this file with the same `demo-erp` source system to demonstrate external-order conflict protection.

## Order Creation Pipeline

Confirming an import changes eligible intents to `QUEUED` and writes one `order.create` outbox event per intent in the same PostgreSQL transaction. The HTTP request never calls Shopify. The dispatcher publishes deterministic BullMQ jobs, and the worker reloads tenant and order state before atomically claiming work.

Order creation uses Shopify Admin GraphQL `orderCreate`, resolved variant GIDs, the imported decimal unit prices, and a deterministic non-PII `sourceIdentifier`. Orders are created without payment transactions or a captured financial state. Successful results persist the Shopify order GID and name and expose an embedded Admin link.

Order and catalog GraphQL calls share an atomic Redis rate gate keyed by shop. It restores capacity from Shopify's cost metadata, reserves background headroom for order work, and delays jobs rather than busy-waiting or treating throttling as permanent failure.

An inconclusive mutation response or an expired worker claim becomes `AMBIGUOUS_RESULT`. A delayed read-only reconciliation searches by `source_identifier`; exactly one result is recorded as success, while zero or multiple bounded results remain visible in Needs Attention. This provides effectively-once behavior under at-least-once delivery, not a mathematical exactly-once guarantee.

## Status And Needs Attention

Import Details polls `/app/api/imports/:batchId/status`, which authenticates the embedded merchant and reads only PostgreSQL. Responses contain aggregate progress and version data without customer fields, support ETags and `304 Not Modified`, and stop being polled after a terminal batch state. Polling slows down when nothing changes and pauses while the browser tab is hidden.

Permanent order failures create sanitized `DeadLetterRecord` history and appear under **Needs attention**. A replay reuses the existing `OrderIntent`, rechecks the shop's scopes and active catalog mappings, records who initiated it, and creates new outbox work. Ambiguous write results expose only a read-only Shopify reconciliation action; they cannot be blindly recreated.

## Lifecycle Webhook Safety

`APP_UNINSTALLED` and `APP_SCOPES_UPDATE` deliveries are authenticated and deduplicated in PostgreSQL. The webhook request commits the immediate shop capability state plus minimal asynchronous cleanup work. Uninstall removes stored sessions and cancels active local work; removal of `write_orders` pauses queued creation without consuming attempts, and restored scopes enqueue eligible work again.

Order and catalog workers check durable shop status and the operation-specific scope immediately before every Shopify GraphQL request. An uninstalled shop receives no new worker API calls, and missing scopes surface as a reauthorization warning in the embedded app.

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

## Verification

For the full test suite, start PostgreSQL and Redis, set `DATABASE_URL` and `REDIS_URL`, and deploy the migrations before running the checks. Tests that require infrastructure skip when those variables are absent.

```sh
npm ci
npm run prisma:generate
npm run migrate:deploy
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs this sequence on a supported Node.js version with isolated PostgreSQL and Redis services. Shopify network calls in automated tests are mocked; the CI workflow does not deploy the app or require production Shopify credentials.

## Operations And Limitations

Structured JSON logs carry a correlation ID, operation name, and the applicable shop, batch, intent, outbox, queue, and job identifiers. Known sensitive context keys and sensitive-looking text are redacted, and queue publication reduces each event to an event-specific operational payload before writing to Redis.

The [operations guide](docs/operations.md) covers health checks, queue recovery, cache consistency, error categories, log safety, incident checks, and manual verification. Current limitations include no automated browser test through real Shopify OAuth, no automated PII retention purge, no inventory/fulfillment/payment workflows, and no guarantee that Shopify can never create a duplicate after an irreducibly ambiguous remote write.

## Documentation

- `docs/implementation-plan.md`
- `docs/architecture.md`
- `docs/operations.md`
- `docs/adr/001-postgresql-and-bullmq.md`
- `docs/adr/002-idempotency-and-transactional-outbox.md`
