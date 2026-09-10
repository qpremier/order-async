# OrderRelay Implementation Plan

Phase 0 audit completed for the existing Shopify React Router app. This phase is documentation-only: no application behavior, schema, dependency, package-lock, or runtime configuration changes are included.

Phase 1 establishes the PostgreSQL foundation, environment validation, local Postgres/Redis Compose services, and health/readiness checks. It intentionally does not implement BullMQ queues, a worker process, CSV ingestion, catalog synchronization, Shopify order creation, or dead-letter replay behavior.

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
- Current scopes: `write_products,write_metaobjects,write_metaobject_definitions`
- Existing declarative custom data is template demo configuration for a product metafield and an example metaobject.

The webhook API version and code API constant should be aligned in a later phase after confirming the supported enum in the installed Shopify package and the intended Shopify API release. Do not change this during Phase 0.

The future MVP will need scopes for reading products/variants and writing orders. The exact minimum scope set should be confirmed in Phase 5 against the active Shopify Admin GraphQL `orderCreate` schema and app review requirements before changing `shopify.app.toml`.

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

Phase 2 should add a separate worker without rewriting the web app:

- Keep the React Router web process built with `react-router build`.
- Add TypeScript worker modules under `worker/` or an equivalent server-only directory.
- Add a dedicated `tsconfig.worker.json` that compiles worker code for Node.js and excludes browser-only React routes.
- Emit worker build output to a deterministic directory such as `build/worker`.
- Add scripts for `worker:dev`, `worker:build`, and `worker:start`.
- Use one reusable Docker image with separate service commands for `web` and `worker`.
- Ensure both processes run `prisma migrate deploy` only through a controlled startup/migration step, not racing from every worker replica.

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

## Phased Roadmap

Phase 1 - PostgreSQL foundation:

- Move Prisma to PostgreSQL with checked-in migrations.
- Add `Shop` and initial domain enums.
- Add Docker Compose for PostgreSQL and Redis.
- Add environment validation and `.env.example`.
- Update Docker/startup flow and health checks.

Phase 2 - Queue, worker, and outbox:

- Add BullMQ/Redis connection management.
- Add web-to-database-to-outbox-to-queue-to-worker diagnostic flow.
- Implement deterministic job IDs, duplicate-safe publication, and graceful shutdown.

Phase 3 - Catalog cache and pagination:

- Add catalog read models and Shopify cursor pagination.
- Add resumable sync checkpoints, product webhook ingestion, manual sync, staleness state, and local keyset cursors.

Phase 4 - Import domain and embedded UI:

- Add import batches, order intents, lines, SKU mappings, streaming CSV validation, preview, mapping resolution, import details, and batch idempotency.

Phase 5 - Order creation pipeline:

- Confirm `orderCreate` schema and scopes.
- Add confirm-batch transaction, order worker, state transitions, retries, reconciliation, rate gating, and Shopify order links.

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
