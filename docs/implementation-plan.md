# OrderRelay Implementation Plan

Phase 0 audit completed for the existing Shopify React Router app. This phase is documentation-only: no application behavior, schema, dependency, package-lock, or runtime configuration changes are included.

Phase 1 established the PostgreSQL foundation, environment validation, local Postgres/Redis Compose services, and health/readiness checks.

Phase 2 adds BullMQ queue infrastructure, the separate worker process, transactional outbox dispatching, and a harmless diagnostic path. It intentionally does not implement catalog synchronization, CSV ingestion, Shopify order creation, rate limiting, or dead-letter replay behavior.

Phase 3 established the local catalog cache, resumable Shopify pagination, product webhook ingestion, manual synchronization, and local keyset pagination.

Phase 4 adds the draft import domain and embedded merchant workflow. It intentionally stops before batch confirmation, outbox creation for orders, Shopify order writes, retry/reconciliation behavior, and dead-letter handling.

Phase 5 established asynchronous order creation, controlled order state transitions, a shared per-shop Shopify rate gate, and ambiguity reconciliation. It intentionally stops before Phase 6 status polling, dead-letter records, Needs Attention UI, controlled replay, and strengthened uninstall/scope webhook behavior.

## Current Baseline

The repository is still close to the Shopify React Router template:

- App shell: React Router file routes via `app/routes.js` and `flatRoutes()`.
- Embedded admin layout: `app/routes/app.jsx` authenticates with `authenticate.admin(request)` and renders the app navigation.
- Main app page: `app/routes/app._index.jsx` still contains template demo actions that synchronously call Shopify Admin GraphQL to create a product, update a variant price, and upsert a demo metaobject.
- Secondary page: `app/routes/app.additional.jsx` is the template additional-page demo.
- Webhooks: only `app/uninstalled` and `app/scopes_update` are configured and routed.
- Database: Prisma uses SQLite with only the Shopify `Session` model.
- Extensions: `extensions/` only contains `.gitkeep`.
- Documentation: no existing `docs/` directory and no `.env.example` were present before this phase.

Route conventions:

- Route modules are colocated under `app/routes`.
- Nested embedded app pages use the `app.*.jsx` convention.
- Webhook routes are top-level route modules, not nested under the embedded app layout.
- Auth callback/login routes are generated from `auth.$.jsx` and `auth.login/route.jsx`.

Template demo code to remove in later phases:

- The product generation action and UI in `app/routes/app._index.jsx`.
- The Additional page content in `app/routes/app.additional.jsx`.
- Demo product metafield and metaobject definitions in `shopify.app.toml` once replacement product scope needs are defined.

Exact package versions from `package-lock.json`:

| Package                                       | Version  |
| --------------------------------------------- | -------- |
| `@shopify/shopify-app-react-router`           | `1.2.1`  |
| `@shopify/app-bridge-react`                   | `4.2.13` |
| `@shopify/shopify-app-session-storage-prisma` | `9.0.1`  |
| `@prisma/client`                              | `6.19.3` |
| `prisma`                                      | `6.19.3` |
| `react`                                       | `18.3.1` |
| `react-dom`                                   | `18.3.1` |
| `react-router`                                | `7.18.3` |
| `@react-router/dev`                           | `7.18.3` |
| `@react-router/node`                          | `7.18.3` |
| `@react-router/serve`                         | `7.18.3` |
| `vite`                                        | `6.4.3`  |
| `typescript`                                  | `5.9.3`  |
| `eslint`                                      | `8.57.1` |

Local tooling observed during the audit:

- Node.js: `v24.14.1`
- npm: `11.12.1`
- Shopify CLI: `4.7.1`
- Prisma CLI/client: `6.19.3`

Important risk: the local Node.js version is outside the declared engine range in `package.json` (`>=20.19 <22 || >=22.12`). The baseline checks passed in this environment, but Phase 1 should use a supported Node version for repeatable local and CI verification.

Existing TypeScript configuration:

- `tsconfig.json` is configured for React Router/browser/server type checking with `noEmit: true`, `allowJs: true`, DOM libs, and generated `.react-router/types`.
- It is suitable for current type-checking, but not sufficient by itself to emit runnable worker JavaScript.
- Phase 2 should add a dedicated worker TypeScript build config rather than changing the app type-check config into a general compiler.

Docker entry points:

- `Dockerfile` uses `node:20-alpine`, installs `openssl`, runs `npm ci --omit=dev`, copies the app, runs `npm run build`, exposes port `3000`, and starts with `npm run docker-start`.
- `npm run docker-start` runs `npm run setup && npm run start`.
- `npm run setup` runs `prisma generate && prisma migrate deploy`.
- `npm run start` runs `react-router-serve ./build/server/index.js`.

## Shopify Configuration

- `shopify.app.toml` app name: `Order Sync`
- Embedded app: `true`
- Application URL: placeholder `https://example.com`
- Redirect URL: placeholder `https://example.com/api/auth`
- Configured app-specific webhook API version: `2026-10`
- App/codegen API constant: `ApiVersion.July26` in `app/shopify.server.js` and `.graphqlrc.js`
- Current scopes: `read_products,read_orders,write_orders`
- The template demo product/metaobject scopes and declarative custom data were removed in Phase 5 because the OrderRelay UI no longer uses them.

The webhook API version and code API constant should be aligned in a later phase after confirming the supported enum in the installed Shopify package and the intended Shopify API release. Do not change this during Phase 0.

Phase 5 validated [`orderCreate(OrderCreateOrderInput!)`](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/orderCreate) and the [`orders`](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders) `source_identifier` reconciliation filter against the configured 2026-07 Admin GraphQL schema. The minimum app capabilities used by this implementation are `read_products`, `write_orders`, and `read_orders`. The shared gate consumes the documented [GraphQL cost and throttle status extensions](https://shopify.dev/docs/api/admin-graphql/2026-07#rate-limits).

## Current Verification Results

Baseline commands run before creating these docs:

| Command                | Result        | Notes                                                                              |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `npm run lint`         | Passed        | No output other than script banner.                                                |
| `npm run typecheck`    | Passed        | Ran `react-router typegen && tsc --noEmit`. npm printed an update notice.          |
| `npm run build`        | Passed        | Build completed; React Router printed v8 future-flag warnings.                     |
| `npm test`             | Not available | No `test` script exists in `package.json`.                                         |
| `npm run prisma -- -v` | Passed        | Prisma and client both report `6.19.3`; schema loaded from `prisma/schema.prisma`. |

Post-documentation verification should rerun:

- `npm run lint`
- `npm run typecheck`
- `npm run build`

Record those final command results in the Phase 0 handoff response.

## Proposed Dependency Changes

No dependencies are installed in Phase 0. Future phases should add dependencies only when the corresponding implementation starts.

Planned runtime dependencies:

- `bullmq`: Redis-backed queue processing.
- `ioredis`: Redis client used by BullMQ and health checks.
- `zod`: environment, form, cursor, and parsed-domain validation.
- `csv-parse`: maintained streaming CSV parser.

Planned development/test dependencies:

- `vitest`: unit and integration tests.
- `@vitest/coverage-v8`: coverage reporting.
- `tsx`: development-time TypeScript runner for worker scripts and one-off diagnostics.
- `@playwright/test`: defer until the E2E phase to avoid destabilizing the embedded Shopify setup before core domain behavior exists.

## Prisma Migration Approach

Current state:

- `prisma/schema.prisma` uses `provider = "sqlite"` and `url = "file:dev.sqlite"`.
- The existing checked-in migration SQL is SQLite-specific.
- No local `prisma/dev.sqlite` database file was present during the audit.
- The `Session` model includes refresh token fields required by the current Shopify session adapter.

Phase 1 should establish PostgreSQL as a new baseline:

- Change the datasource provider to `postgresql` and use `DATABASE_URL`.
- Preserve all current `Session` fields and semantics for `@shopify/shopify-app-session-storage-prisma`.
- Generate a checked-in PostgreSQL migration that creates `Session` plus the new `Shop` foundation model and core enums.
- Do not rely on `prisma db push` for deployable schema state.
- Keep the old SQLite migration history documented or archived; do not attempt to apply the SQLite SQL to PostgreSQL.
- If real merchant/session data must be preserved later, add an explicit one-time export/import path before switching environments. No such data was present in this audit.

Migration risks:

- PostgreSQL requires explicit handling for text length, indexes, timestamps, and decimal fields that SQLite did not enforce.
- Session continuity depends on preserving the adapter-required `Session` columns exactly enough for the installed adapter.
- Existing local development commands assume `prisma migrate deploy`; Phase 1 must provide Docker Compose PostgreSQL and clear setup instructions before removing SQLite behavior.

## Worker Build Approach

Phase 2 adds a separate worker without rewriting the web app:

- Keep the React Router web process built with `react-router build`.
- Add TypeScript worker modules under `worker/` or an equivalent server-only directory.
- Use `tsconfig.worker.json` to compile worker code for Node.js and exclude browser-only React routes.
- Emit worker build output to `build/worker`.
- Use `worker:dev`, `worker:build`, and `worker:start` scripts.
- Use one reusable Docker image with separate Compose service commands for `web` and `worker`.
- Use the Compose `migrate` service as the controlled migration step before web and worker start.

Workers should obtain Shopify Admin access by reloading trusted shop state from PostgreSQL and calling the exported `unauthenticated.admin(shop)` helper. Queue payloads must contain internal IDs and operational metadata only, never Shopify access tokens or raw customer data.

## Phase 1 Implementation Notes

Completed foundation changes:

- Prisma datasource now uses PostgreSQL through `DATABASE_URL`.
- The Shopify adapter-owned `Session` model is preserved and indexed by `shop`.
- Tenant/domain foundation models now exist for shops, catalog variants, SKU mappings, import batches, order intents, order lines, outbox events, webhook receipts, catalog sync runs, and dead-letter records.
- Status and error enums are checked into the Prisma schema for later controlled state-transition work.
- The active migration path contains a PostgreSQL baseline migration at `prisma/migrations/20260910000000_postgresql_foundation/migration.sql`.
- The previous SQLite migration is removed from the active Prisma migration path because it cannot be deployed to PostgreSQL.
- `.env.example` documents Shopify, PostgreSQL, Redis, import limit, worker-concurrency, and outbox tuning variables without real secrets.
- `docker-compose.yml` starts PostgreSQL and Redis by default; the web service is available behind the `app` profile and no worker service is included yet.
- `/health` reports process liveness and `/ready` validates environment, PostgreSQL, and Redis readiness without returning secrets.
- `vitest` is configured for foundation tests.

Phase 1 dependency additions:

- Runtime: `zod`, `ioredis`.
- Development/test: `vitest`, `@vitest/coverage-v8`.

Phase 1 limitations:

- BullMQ and worker processing remain Phase 2 work.
- Catalog sync, CSV import, and order creation behavior remain future phases.
- The Postgres-backed session-storage smoke test requires a reachable PostgreSQL database and skips automatically when `DATABASE_URL` is not provided.

## Phase 2 Implementation Notes

Completed queue and outbox changes:

- Added BullMQ and a shared Redis connection helper for queues and workers.
- Added the `order-write`, `catalog-sync`, and `maintenance` queues.
- Added queue job descriptors that map known outbox event types to queues, job names, priorities, and deterministic BullMQ job IDs.
- Used `__` as the deterministic job ID separator because BullMQ 6 rejects most custom job IDs containing `:`.
- Added transactional outbox helper functions that create `OutboxEvent` rows inside caller-owned Prisma transactions.
- Added an outbox dispatcher that reads unpublished events, publishes to BullMQ, and marks events published only after queue publication succeeds.
- Kept duplicate publication safe through deterministic job IDs and conditional `publishedAt: null` database updates.
- Left unpublished outbox events in PostgreSQL when Redis publication fails, with `attemptCount` and a sanitized `lastPublishError` recorded for later retry.
- Added a separate TypeScript worker process with graceful SIGTERM/SIGINT shutdown.
- Added a harmless `phase2.diagnostic` flow through `POST /app/phase2-diagnostic`.
- Added maintenance worker handling for the diagnostic job that reloads the outbox event from PostgreSQL and logs safe operational metadata only.
- Added Docker Compose `migrate`, `web`, and `worker` services under the `app` profile.

Phase 2 dependency additions:

- Runtime: `bullmq`.
- Development: `tsx`.

Phase 2 limitations before Phase 3:

- Order-write and catalog-sync workers intentionally failed unsupported jobs until their future phase processors existed. Phase 3 replaced the catalog-sync placeholder with catalog processors; order-write remains future Phase 5 work.
- The diagnostic worker is read-only; real business-state transitions begin in later phases.
- There is no database-level outbox claim column yet. Phase 2 relies on deterministic BullMQ job IDs, conditional publish marking, bounded job retention, and idempotent workers.
- Catalog cache, Shopify cursor pagination, product webhooks, and manual catalog sync remain Phase 3 work.
- CSV import and merchant-facing import UI remain Phase 4 work.
- Shopify order creation, rate limiting, and reconciliation remain Phase 5 work.

## Phase 3 Implementation Notes

Completed catalog cache and pagination changes:

- Added reusable opaque keyset cursor helpers for local descending `createdAt, id` pagination.
- Replaced the template home product mutation with an OrderRelay dashboard that shows cache status, cache age, active variant count, ambiguous SKU count, running sync state, and a keyset-paginated cached variant list.
- Added manual catalog sync from the embedded UI. The action creates or reuses a running `CatalogSyncRun` and inserts a `catalog.bootstrap` outbox event instead of calling Shopify inline.
- Implemented Shopify Admin GraphQL `productVariants(first, after)` full sync pagination with checkpoint persistence after each page.
- Implemented safe sync resume from `CatalogSyncRun.lastProcessedCursor`.
- Preserved the previous active cache on sync failure and marked the shop `STALE` when a previous sync existed or `FAILED` when no successful sync existed.
- Marked variants not seen in a completed full sync as deleted only after the full sync succeeds.
- Added targeted product refresh behavior for product create/update webhooks and deletion marking for product delete webhooks.
- Added product webhook routes for `products/create`, `products/update`, and `products/delete`; the routes authenticate, deduplicate by Shopify webhook ID, persist a receipt, insert a catalog refresh outbox event, and return quickly.
- Added worker-side catalog queue processing for full sync and product refresh jobs.
- Added scheduled stale-cache reconciliation in the worker. It scans active shops and creates sync outbox work without calling Shopify inline.
- Retained duplicate SKUs as separate catalog rows and added SKU resolution that reports duplicate active matches as ambiguous.
- Added Phase 3 tests for cursor validation, keyset args, multi-page sync, sync resume, failed-sync cache preservation, and duplicate SKU ambiguity.

Phase 3 dependency changes:

- No new dependencies were added.

Phase 3 scope boundaries:

- Import batches, order intents, order lines, CSV parsing, mapping UI, and import preview remain Phase 4 work.
- Shopify order creation, write scopes, rate limiting, retry classification, and reconciliation remain Phase 5 work.
- Dead-letter records and Needs Attention replay remain Phase 6 work.

## Phase 4 Implementation Notes

Completed import-domain and embedded UI changes:

- Added maintained `csv-parse` streaming ingestion with actual byte counting, row limits, strict headers, ISO timestamp, email, currency, quantity, decimal-money, and order-level consistency validation.
- Grouped CSV rows by `external_order_id`, normalized line values, and generated stable SHA-256 hashes from canonical payloads whose line ordering is deterministic.
- Persisted normalized order-level data and order lines without retaining raw CSV files.
- Created draft batches transactionally and resolved each line against tenant-scoped `SkuMapping` and active `CatalogVariant` records.
- Kept missing and ambiguous mappings local to affected orders while leaving independently valid orders `READY`.
- Added explicit mapping persistence and draft revalidation. The selected variant is verified as an active variant owned by the authenticated shop.
- Added database-backed batch idempotency, including concurrent duplicate handling.
- Reused the one durable `OrderIntent` when the same source/external order and payload hash is uploaded again. Added `ImportBatchOrderIntent` membership so later draft batches can reference that identity without copying it.
- Rejected a reused external identity with a different payload hash atomically as a conflict; existing intent data is never overwritten.
- Added tenant-scoped New Import and Import Details pages, safe validation feedback, preview counts, mapping controls, and cursor-paginated order intents.
- Added recent draft imports to the dashboard with keyset pagination.
- Kept `sourceIdentifier` nullable in Phase 4 because its exact Shopify order-creation contract and backfill belong to Phase 5.

Phase 4 dependency changes:

- Runtime: added `csv-parse` `^6.1.0`.

Phase 4 scope boundaries:

- Draft confirmation, order outbox events, `orderCreate`, write-order scopes, worker claims, rate gating, error classification, and ambiguity reconciliation remain Phase 5 work.
- Status polling, dead-letter records, Needs Attention replay, and strengthened uninstall/scope behavior remain Phase 6 work.
- Sample CSV artifacts and broader operational/portfolio documentation remain Phase 7 work.

## Phase 5 Implementation Notes

Completed order-pipeline changes:

- Added an idempotent confirm-batch transaction that marks only `READY` intents as `QUEUED`, assigns a deterministic hashed `sourceIdentifier`, updates batch aggregates, and creates one minimal `order.create` outbox event per claimed intent.
- Replaced the order queue placeholder with `order.create` and `order.reconcile-ambiguous` processors that reload trusted shop/order state and use atomic conditional claims.
- Added controlled transitions for retries, success, permanent Shopify user errors, ambiguous results, reconciliation leases, and linked batch aggregate/status updates.
- Added Shopify Admin GraphQL `orderCreate` using resolved variant GIDs, imported decimal prices, source tags, optional shipping data, and no payment transactions or captured financial state.
- Persisted successful Shopify order GIDs/names and added embedded Shopify Admin order links to Import Details.
- Added a Redis/Lua per-shop GraphQL cost gate shared by catalog and order workers. The gate uses Shopify response cost metadata, configurable fallback estimates, safety margin, jittered delays, and extra background headroom for catalog work.
- Added conservative ambiguity handling for lost mutation responses and expired create-worker leases. These cases never issue a blind create; they queue delayed reconciliation by `source_identifier`.
- Added bounded reconciliation attempts. One match records success, while zero or multiple final matches remain `AMBIGUOUS_RESULT` for the Phase 6 Needs Attention workflow.
- Added Phase 5 tests for confirmation/outbox atomicity, duplicate delivery, concurrent claims, worker restart ambiguity, Shopify user errors, throttling, pre-dispatch failures, lost responses, reconciliation outcomes, order input construction, and Redis rate-gate behavior.

Phase 5 dependency changes:

- No dependencies were added or removed.

Phase 5 scope boundaries:

- Local status APIs, ETags, adaptive polling, `DeadLetterRecord` creation, Needs Attention UI, and controlled replay remain Phase 6 work.
- APP_UNINSTALLED and APP_SCOPES_UPDATE webhook behavior is not strengthened in this phase; workers do perform an immediate capability check before Shopify calls.
- Final sample CSVs, failure-injection helpers, expanded operations docs, and CI remain Phase 7 work.

## Phased Roadmap

Phase 1 - PostgreSQL foundation:

- Move Prisma to PostgreSQL with checked-in migrations.
- Add `Shop` and initial domain enums.
- Add Docker Compose for PostgreSQL and Redis.
- Add environment validation and `.env.example`.
- Update Docker/startup flow and health checks.

Phase 2 - Queue, worker, and outbox:

- Completed in Phase 2: BullMQ/Redis connection management, separate worker process, outbox dispatcher, deterministic job IDs, duplicate-safe publication, graceful shutdown, and the web-to-database-to-outbox-to-queue-to-worker diagnostic flow.

Phase 3 - Catalog cache and pagination:

- Completed in Phase 3: catalog cache dashboard, manual sync, Shopify cursor pagination, resumable checkpoints, product webhook ingestion, targeted refresh, stale-cache reconciliation, duplicate SKU ambiguity detection, and local keyset cursors.

Phase 4 - Import domain and embedded UI:

- Completed in Phase 4: draft import batches, reusable order intents, order lines, SKU mappings, streaming CSV validation, canonical hashes, preview and mapping UI, tenant isolation, order-intent cursors, and batch idempotency.

Phase 5 - Order creation pipeline:

- Completed in Phase 5: validated `orderCreate`/reconciliation operations and scopes, confirm-batch outbox transactions, guarded order workers, controlled retries, shared per-shop cost gating, ambiguity reconciliation, and Shopify order links.

Phase 6 - Status polling, webhook safety, and dead letter:

- Add local status APIs, adaptive polling, webhook receipts, uninstall/scope handling, dead-letter records, Needs Attention, and controlled replay.

Phase 7 - Hardening and portfolio documentation:

- Add structured logs, failure-injection tests, sample CSVs, README updates, diagrams, operational docs, and CI if hosting supports it.

## Risks And Assumptions

- Phase 0 intentionally makes documentation changes only.
- `package-lock.json` is authoritative for exact dependency versions.
- Existing template demo code remains in place until a later implementation phase removes or replaces it.
- Shopify platform details should continue to be checked through the repo-configured Shopify developer tooling before API-affecting changes.
- PostgreSQL is the target database for development, testing, and production.
- Redis/BullMQ are transport and coordination infrastructure, not the durable source of truth.
- The project should provide effectively-once business behavior through idempotency, transactional persistence, retries, and reconciliation, without claiming mathematically exact-once processing.
