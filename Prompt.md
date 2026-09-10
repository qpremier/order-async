You are the senior software engineer responsible for evolving an existing Shopify embedded application into a production-style portfolio project.

Do not create a new Shopify app and do not replace the current repository with a new scaffold. Inspect the existing codebase first and extend it incrementally.

The repository root is the current working directory. The original local path may be:

C:\Users\m.qasim\Desktop\order sync\order-sync

Never hardcode that absolute path in application code, scripts, configuration, or documentation.

======================================================================
1. PROJECT OBJECTIVE
======================================================================

Build a focused Shopify application called, provisionally:

OrderRelay — Reliable External Order Importer for Shopify

The application solves one business problem:

Merchants receive orders from external systems such as an ERP, wholesale desk, marketplace, phone-sales process, or legacy application. They need to import those orders into Shopify reliably without manually creating each order, accidentally creating duplicates, or losing work when Shopify throttles requests or a worker crashes.

The application must allow a merchant to:

1. Upload a CSV file from inside Shopify Admin.
2. Validate the orders against a locally cached Shopify product/variant catalog.
3. Resolve missing or ambiguous SKU mappings.
4. Preview the import.
5. Confirm the import.
6. Create Shopify orders asynchronously.
7. View progress without repeatedly reading from Shopify.
8. See individual errors.
9. Retry recoverable failures.
10. Resolve permanently failed jobs through a “Needs Attention” workflow.
11. Avoid duplicate Shopify orders when requests, jobs, webhooks, or workers are retried.

This must remain a focused external-order ingestion application. It is not a general Shopify operations platform.

======================================================================
2. CURRENT APPLICATION
======================================================================

This repository is currently a Shopify embedded app created from Shopify’s React Router application template.

Existing capabilities:

1. Shopify OAuth and merchant authentication inside Shopify Admin.
2. Embedded application shell.
3. Session persistence through Prisma and SQLite.
4. Home and Additional page navigation.
5. Demo Shopify product creation through the Admin GraphQL API.
6. Demo product variant price updates.
7. Demo metaobject creation and updates.
8. APP_UNINSTALLED webhook handling.
9. APP_SCOPES_UPDATE webhook handling.
10. No real Shopify extensions. The extensions directory only contains a .gitkeep file.

Inspect these files before making architectural decisions:

- package.json
- package-lock.json
- shopify.app.toml
- shopify.web.toml, if present
- prisma/schema.prisma
- vite.config.js
- app/shopify.server.js
- all route files under app/routes
- existing webhook route files
- Dockerfile
- .env.example or equivalent
- eslint and TypeScript configuration files
- README files

Do not assume the exact directory structure beyond what actually exists.

======================================================================
3. CURRENT TECH STACK
======================================================================

Preserve compatibility with the current stack unless a change is required for the new architecture.

Runtime:
- Node.js
- Required version: >=20.19 <22 or >=22.12

Frontend:
- React 18.3.1

Framework:
- React Router 7.12.0
- Shopify React Router app template

Build/dev server:
- Vite 6.3.6

Shopify:
- Shopify CLI
- Embedded Shopify app configuration
- Shopify App Bridge
- Shopify Admin GraphQL API
- Shopify React Router authentication helpers
- Shopify Polaris Web Components and Polaris types

Backend:
- React Router server routes running on Node.js

Database and ORM:
- Prisma 6.16.3
- Currently SQLite using file:dev.sqlite

Session storage:
- @shopify/shopify-app-session-storage-prisma

Language:
- Mostly JavaScript and JSX
- TypeScript tooling is already enabled

Package manager:
- npm
- package-lock.json is authoritative
- Docker currently uses npm ci
- Do not convert the project to pnpm
- pnpm-workspace.yaml may remain for extension workspaces

Deployment:
- Docker
- Current base image: node:20-alpine

Do not upgrade React, React Router, Vite, Prisma, or the Shopify packages merely because newer versions exist. Upgrade only when required, and explain the reason.

======================================================================
4. TARGET TECHNOLOGY STACK
======================================================================

Evolve the application toward this stack:

Application:
- Existing React Router Shopify app
- React 18
- Shopify App Bridge
- Shopify Polaris Web Components

Backend:
- React Router server loaders/actions/resource routes
- TypeScript for all substantial new backend modules
- Existing JavaScript files may remain JavaScript
- Do not perform a large unrelated JavaScript-to-TypeScript rewrite

Database:
- PostgreSQL for development, testing, and production
- Prisma ORM
- Preserve the Shopify Session model required by the existing session adapter
- Use checked-in Prisma migrations
- Use prisma migrate deploy in production
- Do not rely on prisma db push for production deployment

Queue and workers:
- Redis
- BullMQ
- A separate worker process
- A transactional outbox between PostgreSQL and BullMQ
- Deterministic queue job IDs
- Explicit dead-letter persistence

Validation and parsing:
- Zod or an equivalent typed validation library
- A maintained streaming CSV parser such as csv-parse
- Do not implement a CSV parser manually

Testing:
- Vitest for unit and integration tests, unless the repository already uses another compatible runner
- Playwright for a small number of end-to-end tests, if it can be integrated without destabilizing the Shopify setup
- Shopify API calls must be mockable

Containerization:
- One reusable application image where possible
- Separate web and worker service commands
- Docker Compose for local PostgreSQL and Redis
- The local stack should include:
  - web
  - worker
  - postgres
  - redis

Observability:
- Structured server and worker logs
- Include shop, import batch ID, order intent ID, job ID, and operation name where appropriate
- Never log customer email, address, phone, raw CSV contents, Shopify access tokens, or other secrets

Potential supporting libraries may be added when justified, but avoid dependency bloat.

======================================================================
5. PRODUCT SCOPE
======================================================================

The MVP is a CSV-to-Shopify order ingestion pipeline.

The embedded application should contain these primary areas:

1. Dashboard
   - Recent imports
   - Current catalog cache status
   - Counts for active imports and items requiring attention
   - Button to start a new import

2. New Import
   - Source system name
   - CSV upload
   - File validation
   - Import preview
   - SKU mapping resolution
   - Confirm import action

3. Import Details
   - Overall status
   - Local progress counts
   - Cursor-paginated order intents
   - Individual order status
   - Error details
   - Link to the created Shopify order when available

4. Needs Attention
   - Permanently failed or ambiguous orders
   - Sanitized error information
   - Correctable fields or SKU mappings
   - Controlled replay action

5. Catalog Cache Status
   - Last successful synchronization time
   - Current synchronization state
   - Cache staleness warning
   - Manual synchronization trigger
   - This may be part of the dashboard instead of a separate page

Uploading and confirming the file from the embedded application satisfies the “order creation from the embedded UI” requirement.

Do not build a separate direct-order editor in the MVP. A manual single-order form may be added later only if it reuses the exact same ImportBatch, OrderIntent, outbox, queue, worker, and idempotency pipeline.

======================================================================
6. CSV IMPORT CONTRACT
======================================================================

Use a clear documented CSV format.

The initial contract should include these required columns:

- external_order_id
- processed_at
- email
- currency
- sku
- quantity
- unit_price

Support these optional columns:

- shipping_first_name
- shipping_last_name
- shipping_address1
- shipping_address2
- shipping_city
- shipping_province
- shipping_province_code
- shipping_country_code
- shipping_zip
- shipping_phone
- note

The source system should be entered once in the import form, not repeated in every row.

Rules:

1. Rows with the same external_order_id form one Shopify order.
2. Order-level values must be consistent across rows belonging to the same order.
3. quantity must be a positive integer.
4. unit_price must be parsed with decimal-safe handling.
5. Currency must be consistent within an order.
6. SKU comparison may use a normalized value for lookup, but the original SKU must also be retained.
7. Duplicate SKUs can exist in Shopify. Never assume a SKU uniquely identifies a variant.
8. Missing SKUs must produce a NEEDS_MAPPING state.
9. Multiple Shopify variants matching the same SKU must produce an AMBIGUOUS_MAPPING state.
10. Invalid rows must not be silently skipped.
11. Do not store the raw uploaded CSV longer than required.
12. Do not log raw rows.
13. Use configurable file and row limits.
14. Provide sensible defaults, for example:
    - Maximum file size: 5 MB
    - Maximum rows: 10,000
15. Validate actual content. Do not trust only the filename or MIME type.

Include sample files in the repository:

- examples/orders-valid.csv
- examples/orders-missing-sku.csv
- examples/orders-invalid.csv
- examples/orders-duplicate-external-id.csv

======================================================================
7. TARGET ARCHITECTURE
======================================================================

Use the following logical architecture:

Embedded Shopify Admin UI
        |
        v
React Router web process
- Authentication
- UI loaders and actions
- CSV ingestion
- Local database queries
- Webhook reception
        |
        v
PostgreSQL through Prisma
- Shopify sessions
- Shop state
- Catalog read model
- Imports
- Order intents
- Order lines
- Outbox events
- Webhook receipts
- Dead-letter records
        |
        v
Transactional outbox dispatcher
        |
        v
Redis and BullMQ
- order-write queue
- catalog-sync queue
- maintenance queue
- dead-letter destination or replay workflow
        |
        v
Worker process
- Shopify mutations
- Shopify queries
- Retry handling
- Rate limiting
- Reconciliation
- Status updates
        |
        v
Shopify Admin GraphQL API

Important architectural rules:

1. HTTP routes must not create dozens of Shopify orders synchronously.
2. Progress polling must read PostgreSQL, not Shopify.
3. Redis is transport and coordination infrastructure, not the source of truth.
4. PostgreSQL is the source of truth for business state.
5. BullMQ job deduplication is an extra safeguard, not the primary idempotency guarantee.
6. Workers must be restart-safe.
7. Queue delivery should be treated as at-least-once.
8. The system should provide effectively-once business behavior through idempotency and reconciliation.
9. Do not describe this architecture as mathematically guaranteed exactly-once processing.
10. Do not serialize Shopify access tokens into BullMQ payloads.
11. Workers must obtain an authenticated offline Shopify Admin client using the supported APIs from the installed Shopify React Router package.

======================================================================
8. DATABASE MODEL
======================================================================

Keep the existing Shopify Session model working.

Design Prisma models equivalent to the following concepts. Names may be adjusted to match repository conventions.

Shop

Fields:
- id
- domain, unique
- status
- grantedScopes
- installedAt
- uninstalledAt
- lastCatalogSyncAt
- catalogSyncStatus
- createdAt
- updatedAt

Suggested status values:
- ACTIVE
- NEEDS_REAUTH
- UNINSTALLED

CatalogVariant

Fields:
- id
- shopId
- shopifyVariantGid
- shopifyProductGid
- sku
- normalizedSku
- variantTitle
- productTitle
- price using Prisma Decimal
- currency if applicable
- productStatus
- shopifyUpdatedAt
- cachedAt
- deletedAt
- lastSeenSyncRunId
- createdAt
- updatedAt

Constraints:
- unique(shopId, shopifyVariantGid)
- index(shopId, normalizedSku)
- index(shopId, deletedAt)

Do not add a unique constraint on normalizedSku.

SkuMapping

Fields:
- id
- shopId
- sourceSystem
- externalSku
- normalizedExternalSku
- shopifyVariantGid
- createdAt
- updatedAt

Constraint:
- unique(shopId, sourceSystem, normalizedExternalSku)

ImportBatch

Fields:
- id
- shopId
- sourceSystem
- originalFileName
- idempotencyKey
- status
- totalOrders
- readyOrders
- queuedOrders
- processingOrders
- succeededOrders
- failedOrders
- needsAttentionOrders
- version
- confirmedAt
- completedAt
- createdAt
- updatedAt

Constraint:
- unique(shopId, idempotencyKey)
- index(shopId, createdAt, id)

Suggested status values:
- DRAFT
- VALIDATING
- READY
- QUEUED
- PROCESSING
- PARTIALLY_COMPLETED
- COMPLETED
- FAILED
- CANCELLED

OrderIntent

Fields:
- id
- shopId
- importBatchId
- sourceSystem
- externalOrderId
- payloadHash
- sourceIdentifier
- status
- shopifyOrderGid
- shopifyOrderName
- attemptCount
- lastErrorCategory
- lastErrorCode
- sanitizedLastError
- nextAttemptAt
- processingStartedAt
- succeededAt
- version
- createdAt
- updatedAt

Constraint:
- unique(shopId, sourceSystem, externalOrderId)
- index(shopId, status, createdAt, id)
- index(importBatchId, createdAt, id)
- index(shopId, sourceIdentifier)

Suggested status values:
- DRAFT
- VALIDATING
- NEEDS_MAPPING
- AMBIGUOUS_MAPPING
- INVALID
- READY
- QUEUED
- PROCESSING
- RETRY_WAIT
- AMBIGUOUS_RESULT
- SUCCEEDED
- DEAD_LETTER
- CANCELLED

OrderLine

Fields:
- id
- orderIntentId
- originalSku
- normalizedSku
- shopifyVariantGid
- quantity
- unitPrice using Prisma Decimal
- validationStatus
- validationMessage
- createdAt
- updatedAt

OutboxEvent

Fields:
- id
- shopId
- aggregateType
- aggregateId
- eventType
- payload
- publishedAt
- attemptCount
- lastPublishError
- createdAt
- updatedAt

Indexes:
- index(publishedAt, createdAt)
- index(eventType, publishedAt)

The outbox payload should contain IDs and operational metadata, not duplicated customer PII.

WebhookReceipt

Fields:
- id
- shopId or shop domain
- webhookId
- topic
- payloadHash
- receivedAt
- processedAt
- processingError

Constraint:
- unique(shop/domain, webhookId)

DeadLetterRecord

Fields:
- id
- shopId
- orderIntentId
- jobType
- errorCategory
- errorCode
- sanitizedMessage
- attempts
- firstFailedAt
- lastFailedAt
- replayedAt
- replayedBy
- createdAt
- updatedAt

Do not duplicate the complete order payload in the dead-letter record. Reference OrderIntent.

CatalogSyncRun or CatalogSyncCheckpoint may also be added if needed for safe resumable cursor pagination.

Use explicit relations and useful indexes. Every tenant-owned model must be scoped by shop.

======================================================================
9. DOMAIN STATE TRANSITIONS
======================================================================

Do not allow routes and workers to write arbitrary status strings.

Create domain/service functions for controlled transitions, for example:

- beginBatchValidation
- markBatchReady
- confirmBatch
- queueOrderIntent
- claimOrderIntentForProcessing
- scheduleOrderIntentRetry
- markOrderIntentAmbiguous
- markOrderIntentSucceeded
- deadLetterOrderIntent
- cancelOrderIntent
- completeImportBatch

Use atomic conditional updates or transactions so that only one worker can move an order from QUEUED or RETRY_WAIT to PROCESSING.

Use optimistic version fields where useful.

Invalid state transitions should fail loudly and be covered by unit tests.

======================================================================
10. CURSOR PAGINATION
======================================================================

Implement cursor pagination in two separate areas.

A. Shopify catalog synchronization

Use Shopify Admin GraphQL connection pagination.

Requirements:

- Use first and after.
- Read pageInfo.hasNextPage and pageInfo.endCursor.
- Use a page size supported by the configured Shopify API version.
- Save a checkpoint after successfully processing each page.
- Resume safely after interruption.
- Do not erase the previous valid cache before the full replacement sync completes.
- Prefer upserts.
- Mark variants not seen in a completed full sync as deleted only after the full sync succeeds.
- Keep the last successful cache available when synchronization fails.

B. Local application pagination

Use keyset/cursor pagination for:

- Import history
- Order intents inside an import
- Needs Attention records

Do not use large OFFSET queries.

Use a stable compound sort such as:

- createdAt descending
- id descending

Create opaque base64url cursors containing the sorted values.

The cursor parser must:

- validate structure
- reject malformed cursors
- avoid exposing arbitrary SQL or Prisma filters
- be unit tested

Return hasNextPage and endCursor in local API responses.

======================================================================
11. LOCAL CATALOG CACHE
======================================================================

The catalog cache is a local read model, not the system of record.

Implement:

1. Initial full cursor-based product variant synchronization.
2. Incremental updates triggered by relevant product webhooks.
3. Scheduled reconciliation.
4. Manual synchronization from the embedded application.
5. Cache freshness information.
6. Stale-cache fallback.

The UI must continue to show cached results if Shopify is temporarily unavailable.

When synchronization fails:

- Preserve the last successful data.
- Mark the cache as stale.
- Show the last successful sync time.
- Record a sanitized operational error.
- Retry through the queue.

Product webhook routes should not execute a complete Shopify synchronization during the HTTP request. Authenticate, deduplicate, persist a receipt/outbox event, and return quickly.

Use product-related webhook topics only as needed to maintain the cache. Keep the application focused.

======================================================================
12. IMPORT WORKFLOW
======================================================================

The import workflow should be:

1. Merchant opens New Import.
2. Merchant enters a source system identifier.
3. Browser generates an idempotency key.
4. Merchant uploads a CSV file.
5. Server validates file size and format.
6. Server parses rows using a maintained parser.
7. Rows are grouped by external_order_id.
8. A canonical normalized payload is produced for each external order.
9. A stable payload hash is calculated.
10. ImportBatch, OrderIntent, and OrderLine records are stored.
11. Validation runs against the local CatalogVariant and SkuMapping tables.
12. UI shows a preview.
13. Merchant resolves missing or ambiguous SKU mappings.
14. Merchant confirms the batch.
15. In one PostgreSQL transaction:
    - mark eligible intents as QUEUED
    - update the batch
    - insert one outbox event for each eligible order intent
16. The outbox dispatcher publishes deterministic BullMQ jobs.
17. Workers process the jobs.
18. Workers update local status.
19. UI polls only the local status API.
20. Failed jobs are retried or moved to Needs Attention based on classification.

Do not call Shopify for every preview or polling request.

======================================================================
13. IDEMPOTENCY
======================================================================

Idempotency is a core feature and must be implemented in layers.

A. Batch request idempotency

The browser provides an Idempotency-Key.

Database constraint:

unique(shopId, idempotencyKey)

Submitting the same request again should return the existing ImportBatch.

B. External business order identity

Database constraint:

unique(shopId, sourceSystem, externalOrderId)

Behavior:

- Same external ID and same payload hash:
  return or reference the existing OrderIntent.
- Same external ID and a different payload hash:
  create a conflict requiring merchant review.
- Never silently overwrite an existing imported order.

C. Queue job identity

Use a deterministic BullMQ job ID based on OrderIntent ID, such as:

order-create:<orderIntentId>

Do not rely on the BullMQ job ID as the only duplicate protection.

D. Worker claim protection

Before calling Shopify:

- Load the OrderIntent.
- Confirm the shop is ACTIVE.
- Confirm required scopes are present.
- Return success immediately if shopifyOrderGid already exists.
- Atomically claim QUEUED or RETRY_WAIT work.
- Do nothing if another worker already owns or completed the intent.

E. Shopify source identity

Create a deterministic sourceIdentifier, for example:

orderrelay:<sourceSystem>:<externalOrderId>

Use this identifier in the Shopify order creation input when supported by the configured API version.

F. Ambiguous response recovery

Handle the dangerous case:

1. Shopify may have created the order.
2. The worker does not receive a conclusive response.
3. Blind retrying might create a duplicate.

For network timeouts, connection resets, or inconclusive server failures after the mutation may have been sent:

- Do not immediately call orderCreate again.
- Set OrderIntent to AMBIGUOUS_RESULT.
- Enqueue a delayed reconciliation job.
- Search Shopify using the deterministic source identifier or another supported deterministic reference.
- If exactly one order is found, persist its Shopify GID and mark success.
- If no order is found after bounded delayed reconciliation attempts, move it to Needs Attention unless the error can be proven safe to retry.
- If multiple matching orders are found, move it to Needs Attention.
- Never hide the ambiguity.

Document this behavior as “effectively-once order creation with ambiguity reconciliation,” not “exactly once.”

======================================================================
14. TRANSACTIONAL OUTBOX
======================================================================

Do not perform this unsafe dual write:

1. Commit database records.
2. Independently call queue.add.
3. Hope both operations succeed.

Instead:

- Persist business state and OutboxEvent records in the same PostgreSQL transaction.
- Run an outbox dispatcher.
- The dispatcher finds unpublished events.
- It adds deterministic BullMQ jobs.
- It marks events published after successful queue publication.
- Publishing is at-least-once.
- Duplicate publication must be safe.

The dispatcher must:

- Handle Redis downtime.
- Retry with backoff.
- Avoid unbounded tight loops.
- Support graceful shutdown.
- Be safe if more than one dispatcher process runs.
- Use database claiming/locking or rely on deterministic publication combined with safe event claiming.
- Keep database state as the source of truth.

Add tests for:

- Database commit while Redis is unavailable.
- Event published more than once.
- Worker receiving duplicate jobs.
- Dispatcher restart.

======================================================================
15. JOBS, QUEUES, AND WORKERS
======================================================================

Use three primary queues:

1. order-write
2. catalog-sync
3. maintenance

Suggested job types:

- order.create
- order.reconcile-ambiguous
- catalog.bootstrap
- catalog.refresh-product
- catalog.reconcile
- import.validate
- webhook.process
- dead-letter.replay

Order creation must have higher operational priority than a large catalog reconciliation.

Worker requirements:

- Separate process from the web server.
- Configurable concurrency.
- Graceful SIGTERM and SIGINT handling.
- Stop accepting new jobs during shutdown.
- Finish or safely release active work.
- Close BullMQ, Redis, and Prisma connections.
- Include correlation data in structured logs.
- Do not place access tokens in job payloads.
- Load the shop and supported offline Shopify Admin client at execution time.
- Check shop status and required scopes immediately before Shopify API calls.

Use exponential backoff and jitter for transient failures.

Do not busy-wait inside a worker for long periods. Reschedule or delay work when throttled.

Retain completed and failed BullMQ jobs for a bounded period useful for diagnostics, while keeping PostgreSQL as the authoritative state.

======================================================================
16. SHOPIFY ORDER CREATION
======================================================================

Use the Shopify Admin GraphQL API.

Use orderCreate for the MVP unless inspection of the configured Shopify API version proves another mutation is required.

Before implementation:

- Inspect the currently configured Shopify API version.
- Confirm the exact current orderCreate input fields.
- Confirm the exact current response shape.
- Confirm how sourceIdentifier is supported.
- Confirm required scopes.
- Confirm the supported query for reconciliation.
- Use official Shopify documentation and the installed package APIs.
- Do not guess deprecated input fields.

Order creation rules:

1. Use variant GIDs resolved from the local cache/mapping.
2. Use decimal-safe price conversion.
3. Add a deterministic source identifier.
4. Add an application/source tag or equivalent non-sensitive marker when supported.
5. Do not create payment transactions in the MVP.
6. Do not pretend to capture payment.
7. Use a conservative unpaid/pending financial state only if supported and appropriate.
8. Store Shopify GraphQL userErrors.
9. Sanitize errors before presenting or logging.
10. Store the resulting Shopify order GID and order name.
11. Link to the order inside Shopify Admin when possible.
12. Do not implement discounts, taxes, refunds, fulfillment, returns, or inventory adjustments in the MVP.

Use the minimum necessary Shopify scopes.

Likely capabilities will include:

- read_products
- write_orders
- read_orders if required for reconciliation

Verify exact scope requirements before modifying shopify.app.toml.

Remove obsolete demo scopes only after confirming they are no longer used.

======================================================================
17. SHOPIFY RATE LIMITING
======================================================================

Implement Shopify GraphQL cost-aware throttling.

Do not use a fixed delay as the main rate-limiting strategy.

Read and use the GraphQL response extensions, including the cost and throttle status information supported by the configured API version.

Implement a Redis-backed rate gate keyed per Shopify shop.

The gate should track information such as:

- maximum available budget
- currently available budget
- restore rate
- last observation time
- conservative estimated operation cost
- safety margin

Requirements:

1. Rate limiting must be per shop.
2. A busy shop must not block unrelated shops.
3. order-write and catalog-sync workers must share the same per-shop budget.
4. Order creation should take priority over background catalog synchronization.
5. Update the stored budget from actual Shopify response metadata.
6. Use conservative estimates before an operation.
7. Reschedule work when capacity is insufficient.
8. Add jitter to avoid synchronized retries.
9. Do not rely solely on a global BullMQ limiter.
10. Do not hardcode plan-specific limits as universal values.
11. Make safety margins and fallback costs configurable.
12. Handle Shopify throttle errors as recoverable, not dead-letter failures.

Use an atomic Redis operation, Lua script, or equivalent distributed coordination mechanism so multiple worker processes do not spend the same budget concurrently.

Unit test:

- budget restoration over time
- insufficient capacity
- concurrent claims
- response metadata updates
- separate shops
- safety margin behavior

======================================================================
18. CACHED STATUS POLLING
======================================================================

Create a local status resource route such as:

GET /app/api/imports/:batchId/status

Adapt the path to existing route conventions.

The status route must:

- Authenticate the embedded merchant.
- Derive the shop from the authenticated session.
- Never trust a shop identifier supplied by the browser.
- Query PostgreSQL only.
- Never call Shopify.
- Return batch status and progress counts.
- Include a version or updatedAt value.
- Support ETag and If-None-Match.
- Return 304 Not Modified when applicable.
- Return no PII.

Example response:

{
  "id": "batch-id",
  "status": "PROCESSING",
  "version": 27,
  "counts": {
    "total": 100,
    "queued": 8,
    "processing": 4,
    "succeeded": 83,
    "needsAttention": 5
  },
  "updatedAt": "ISO timestamp"
}

Frontend polling behavior:

- Poll relatively quickly while progress is changing.
- Slow down after repeated unchanged responses.
- Stop after terminal states.
- Pause while the browser tab is hidden.
- Resume when visible.
- Do not create overlapping polling requests.
- Display local progress even when Shopify is temporarily unavailable.

Add a test proving that the status route does not call Shopify.

======================================================================
19. WEBHOOK HANDLING
======================================================================

Preserve and strengthen existing webhook handling.

A. APP_UNINSTALLED

On a valid uninstall webhook:

- Deduplicate by Shopify webhook delivery ID.
- Set Shop.status to UNINSTALLED.
- Record uninstalledAt.
- Delete or deactivate stored Shopify sessions according to the template/session adapter’s supported behavior.
- Prevent workers from making additional Shopify calls.
- Mark active imports as cancelled or blocked.
- Cancel waiting jobs where practical.
- Make already-running workers check Shop.status before every Shopify call.
- Persist the receipt quickly.
- Return a successful HTTP response quickly.
- Perform extended cleanup asynchronously.

B. APP_SCOPES_UPDATE

On a valid scopes update webhook:

- Deduplicate the delivery.
- Persist the latest granted scopes.
- Recalculate capabilities.
- If write_orders is absent, set the shop to NEEDS_REAUTH or an equivalent blocked capability state.
- Prevent order jobs from continuing.
- Show a reauthorization state in the embedded UI.
- Resume eligible work only after the required scope is restored.

C. Relevant product webhooks

Use product webhooks only to support the catalog cache.

The webhook request should:

1. Authenticate using the existing Shopify framework.
2. Read the webhook delivery ID and topic.
3. Insert WebhookReceipt and an OutboxEvent transactionally.
4. Return quickly.
5. Let a worker process catalog updates.

Do not perform long Shopify GraphQL operations in the webhook HTTP request.

Duplicate webhook deliveries must be no-ops after the first accepted receipt.

======================================================================
20. ERROR CLASSIFICATION AND DEAD LETTER
======================================================================

Create typed error categories.

Suggested categories:

- VALIDATION
- MISSING_MAPPING
- AMBIGUOUS_MAPPING
- SHOPIFY_USER_ERROR
- AUTHENTICATION
- MISSING_SCOPE
- SHOP_UNINSTALLED
- THROTTLED
- NETWORK_TRANSIENT
- SHOPIFY_SERVER_TRANSIENT
- AMBIGUOUS_WRITE_RESULT
- INTERNAL_BUG
- UNKNOWN

Suggested behavior:

Validation:
- Do not automatically retry.
- Show merchant-correctable information.

Missing or ambiguous mapping:
- Do not automatically retry.
- Require merchant action.

Shopify userErrors:
- Usually permanent.
- Store field path, safe code, and sanitized message.
- Move to Needs Attention where appropriate.

Missing scope:
- Pause or block.
- Do not consume all retry attempts.

Shop uninstalled:
- Cancel permanently.

Throttle:
- Delay and retry.
- Do not classify as dead-letter failure.

Temporary network failure before request dispatch:
- Retry with backoff.

Potentially dispatched write with no conclusive response:
- Mark ambiguous and reconcile.

Shopify server transient error:
- Retry with exponential backoff and jitter.

Internal invariant failure:
- Record safely.
- Move to dead letter after limited retries.

When retry limits are exhausted:

- Set OrderIntent.status to DEAD_LETTER.
- Create a DeadLetterRecord.
- Update ImportBatch counts.
- Show it in Needs Attention.

Replay behavior:

- Replay the same OrderIntent.
- Do not create a new business identity.
- Revalidate current mappings and shop capabilities.
- Record who or what initiated the replay.
- Insert a new outbox event.
- Preserve previous failure history.
- Continue to enforce idempotency.

======================================================================
21. SECURITY AND MULTI-TENANCY
======================================================================

Apply these rules everywhere:

1. The authenticated Shopify session determines the current shop.
2. Never trust a shop ID or domain supplied by the browser.
3. Every tenant-owned database query must filter by shop.
4. A merchant must never access another merchant’s imports, catalog, jobs, or failures.
5. BullMQ jobs should use internal IDs and reload authorized records.
6. Do not put access tokens, customer emails, addresses, phones, or raw CSV rows in Redis job payloads.
7. Do not log PII.
8. Sanitize Shopify and parser errors.
9. Avoid returning stack traces to the browser.
10. Validate upload size and row count.
11. Validate all route params, cursors, and form data.
12. Use environment variables for secrets.
13. Add an environment validation module.
14. Do not commit .env files or credentials.
15. Health endpoints must not expose secrets.
16. Use secure defaults for production cookies and session handling already provided by the Shopify template.
17. Preserve webhook authentication from the Shopify framework.
18. Do not create custom authentication alongside the existing Shopify authentication.

Consider PII retention:

- Keep only order data required for retries and merchant support.
- Document a future retention/purge policy.
- Never include full customer details in dead-letter or log records.

======================================================================
22. NON-GOALS
======================================================================

Do not implement the following as part of the MVP:

- Inventory synchronization
- Fulfillment creation
- Shipping label creation
- Returns
- Refunds
- Order editing after import
- Bidirectional ERP integrations
- Marketplace API connectors
- General analytics dashboards
- AI SKU matching
- Automatic product creation
- Customer account management
- Discounts engine
- Tax calculation engine
- Payment processing
- Payment capture
- Multiple currencies within one order
- Draft order mode
- Shopify theme extensions
- Checkout extensions
- POS extensions
- A separate microservice for every job type
- Kubernetes
- Kafka
- Event sourcing
- A large rewrite of the Shopify starter template
- A broad migration of all existing JavaScript to TypeScript

The project should demonstrate strong engineering through reliability, not through excessive product breadth.

======================================================================
23. SUGGESTED MODULE STRUCTURE
======================================================================

Adapt this to the existing repository rather than forcing it blindly.

Possible structure:

app/
  components/
  routes/
  services/
    imports/
      import-parser.server.ts
      import-validation.server.ts
      import-state.server.ts
      payload-hash.server.ts
    catalog/
      catalog-sync.server.ts
      catalog-cache.server.ts
      sku-mapping.server.ts
    orders/
      order-create.server.ts
      order-reconcile.server.ts
      order-state.server.ts
    shopify/
      admin-client.server.ts
      graphql-cost.server.ts
      shop-capabilities.server.ts
    outbox/
      outbox.server.ts
    pagination/
      cursor.server.ts
    logging/
      logger.server.ts
    security/
      environment.server.ts
  queues/
    connection.server.ts
    queue-names.ts
    jobs.ts

worker/
  index.ts
  processors/
    order-create.processor.ts
    order-reconcile.processor.ts
    catalog-sync.processor.ts
    webhook.processor.ts
  rate-limit/
    shopify-rate-gate.ts
  outbox/
    dispatcher.ts

prisma/
  schema.prisma
  migrations/

docs/
  implementation-plan.md
  architecture.md
  adr/
  operations.md

examples/
  orders-valid.csv
  orders-invalid.csv
  orders-missing-sku.csv

The exact location of worker code depends on the build setup. Ensure the worker is compiled and runnable in development and production.

======================================================================
24. ENVIRONMENT VARIABLES
======================================================================

Preserve existing Shopify environment variables.

Add and validate variables such as:

- DATABASE_URL
- REDIS_URL
- LOG_LEVEL
- ORDER_WORKER_CONCURRENCY
- CATALOG_WORKER_CONCURRENCY
- CATALOG_SYNC_PAGE_SIZE
- CATALOG_STALE_AFTER_MINUTES
- IMPORT_MAX_BYTES
- IMPORT_MAX_ROWS
- JOB_MAX_ATTEMPTS
- RATE_LIMIT_SAFETY_MARGIN
- OUTBOX_POLL_INTERVAL_MS
- OUTBOX_BATCH_SIZE

Use sensible defaults only for non-secret local development values.

Document all variables in .env.example without real secrets.

======================================================================
25. IMPLEMENTATION PHASES
======================================================================

Do not implement the whole project in one uncontrolled patch.

Complete one phase at a time. At the end of each phase:

1. Run formatting.
2. Run linting.
3. Run TypeScript checking.
4. Run relevant tests.
5. Run the production build.
6. Report all commands and results.
7. List changed files.
8. List remaining known limitations.
9. Do not claim success for commands that were not run.

------------------------------
PHASE 0 — REPOSITORY AUDIT
------------------------------

Tasks:

- Inspect the current project.
- Identify exact package versions.
- Identify exact Shopify API version.
- Identify existing scopes.
- Identify route conventions.
- Identify current webhook implementation.
- Identify how offline sessions can be loaded for workers.
- Run the current lint, type-check, test, and build commands that exist.
- Record existing failures separately from new failures.
- Find template demo code that will eventually be removed.
- Identify Docker entry points.
- Identify whether existing TypeScript configuration can compile worker code.
- Identify migration risks when changing SQLite to PostgreSQL.

Create:

- docs/implementation-plan.md
- docs/architecture.md
- docs/adr/001-postgresql-and-bullmq.md
- docs/adr/002-idempotency-and-transactional-outbox.md

Do not modify application behavior during Phase 0.

Phase 0 acceptance criteria:

- Current architecture is documented.
- Target architecture is documented.
- Exact dependency changes are proposed.
- Exact Prisma migration approach is proposed.
- Exact worker build approach is proposed.
- Existing baseline command results are documented.
- Risks and assumptions are listed.

------------------------------
PHASE 1 — POSTGRESQL FOUNDATION
------------------------------

Tasks:

- Change Prisma provider from SQLite to PostgreSQL.
- Preserve and test Shopify session storage.
- Add Shop model.
- Add initial domain models and enums.
- Create checked-in migrations.
- Add Docker Compose for PostgreSQL and Redis.
- Update environment validation.
- Update .env.example.
- Update Docker build and startup flow.
- Add health/readiness checks for PostgreSQL and Redis where appropriate.
- Add scripts for migrations.
- Prove the web application still authenticates and boots.

Phase 1 acceptance criteria:

- npm install uses package-lock.json.
- PostgreSQL is used successfully.
- Session model still works.
- Prisma migration succeeds on an empty database.
- Web application builds.
- Docker Compose starts PostgreSQL and Redis.
- No SQLite runtime dependency remains outside migration notes or archived development documentation.

------------------------------
PHASE 2 — QUEUE, WORKER, AND OUTBOX
------------------------------

Tasks:

- Add BullMQ and Redis connection management.
- Add separate worker process.
- Add order-write, catalog-sync, and maintenance queues.
- Add transactional OutboxEvent support.
- Add an outbox dispatcher.
- Add deterministic job IDs.
- Add graceful shutdown.
- Add a harmless diagnostic job to prove web-to-database-to-outbox-to-queue-to-worker flow.
- Add unit and integration tests for duplicate publication and Redis recovery.

Phase 2 acceptance criteria:

- Web and worker run as separate processes.
- A transaction can create an outbox event.
- Dispatcher publishes it.
- Worker handles it.
- Duplicate publication is harmless.
- Redis outage does not lose the database event.
- Worker restart does not lose business state.

------------------------------
PHASE 3 — CATALOG CACHE AND PAGINATION
------------------------------

Tasks:

- Add CatalogVariant and catalog sync models.
- Implement Shopify cursor pagination.
- Implement resumable synchronization checkpoints.
- Add full sync and targeted product refresh jobs.
- Add cache staleness state.
- Add manual sync UI.
- Add relevant product webhook ingestion.
- Add scheduled reconciliation.
- Add local keyset cursor helpers.
- Add unit tests for cursor encoding and decoding.

Phase 3 acceptance criteria:

- Full catalog sync supports multiple pages.
- Interrupted sync can resume safely.
- Previous cache remains available when sync fails.
- Duplicate SKUs are retained and recognized as ambiguous.
- Cache age is shown in the UI.
- Local cursor pagination does not use large offsets.
- Product webhook HTTP handlers return quickly.

------------------------------
PHASE 4 — IMPORT DOMAIN AND EMBEDDED UI
------------------------------

Tasks:

- Add ImportBatch, OrderIntent, OrderLine, and SkuMapping.
- Add streaming CSV parsing.
- Add file and row limits.
- Add grouping by external_order_id.
- Add canonical payload hashing.
- Add local validation.
- Add New Import page.
- Add preview UI.
- Add missing and ambiguous SKU mapping UI.
- Add Import Details page.
- Add cursor pagination for order intents.
- Add batch request idempotency.

Phase 4 acceptance criteria:

- Valid CSV creates a DRAFT import.
- Invalid rows show useful safe errors.
- Missing mappings block only affected orders.
- Duplicate SKUs require explicit mapping.
- Same idempotency key returns the original batch.
- Same external order and same hash is reused.
- Same external order and different hash produces a conflict.
- Cross-shop access tests pass.

------------------------------
PHASE 5 — ORDER CREATION PIPELINE
------------------------------

Tasks:

- Confirm exact current Shopify orderCreate schema.
- Add minimum required Shopify scopes.
- Implement confirm-batch transaction and outbox events.
- Implement order.create worker.
- Implement domain state transitions.
- Add deterministic sourceIdentifier.
- Add Shopify userError handling.
- Add atomic worker claims.
- Add per-shop Redis-backed Shopify rate gate.
- Add retry classification.
- Add AMBIGUOUS_RESULT state.
- Add order reconciliation job.
- Store Shopify order GID and name.
- Add Shopify Admin order links in the UI.

Phase 5 acceptance criteria:

- Confirming a batch does not create orders in the HTTP request.
- Workers create orders from queue jobs.
- Duplicate jobs do not create duplicate work.
- Completed intents no-op when delivered again.
- Throttling delays work without dead-lettering it.
- A potentially lost response enters reconciliation.
- A reconciled order is recorded without another blind create.
- All relevant tests pass with mocked Shopify behavior.

------------------------------
PHASE 6 — STATUS POLLING, WEBHOOK SAFETY, AND DEAD LETTER
------------------------------

Tasks:

- Add local status API.
- Add ETag support.
- Add adaptive frontend polling.
- Add DeadLetterRecord.
- Add Needs Attention page.
- Add controlled replay.
- Strengthen APP_UNINSTALLED behavior.
- Strengthen APP_SCOPES_UPDATE behavior.
- Add webhook delivery deduplication.
- Cancel or block work safely for uninstalled shops.
- Pause work safely when scopes are missing.

Phase 6 acceptance criteria:

- Status polling performs zero Shopify API calls.
- Polling stops at terminal states.
- Duplicate webhooks are ignored.
- Uninstalled shops receive no new Shopify calls.
- Missing write scope pauses order work.
- Permanent failures appear in Needs Attention.
- Replay uses the same OrderIntent identity.
- Dead-letter replay cannot bypass idempotency.

------------------------------
PHASE 7 — HARDENING AND PORTFOLIO DOCUMENTATION
------------------------------

Tasks:

- Add structured logs.
- Add correlation IDs.
- Add operational health documentation.
- Add failure-injection test helpers.
- Add representative end-to-end tests.
- Add sample CSV files.
- Update README with local setup and architecture.
- Add a Mermaid architecture diagram.
- Add an idempotency sequence diagram.
- Document error categories.
- Document queue recovery.
- Document cache consistency.
- Document known limitations.
- Add CI for lint, type-check, tests, and build if repository hosting supports it.

Phase 7 acceptance criteria:

- README allows another engineer to run the project.
- Failure tests cover duplicate submission, duplicate jobs, worker crash, throttling, lost response, missing scope, uninstall, and permanent user error.
- No PII appears in logs or queue payloads.
- Build and tests pass from a clean installation.
- Documentation accurately describes limitations and does not claim exactly-once guarantees.

======================================================================
26. REQUIRED TEST SCENARIOS
======================================================================

At minimum, implement automated tests for:

1. The same batch idempotency key submitted twice.
2. Concurrent duplicate batch submissions.
3. Same external order with the same payload.
4. Same external order with a different payload.
5. Invalid CSV format.
6. Row limit exceeded.
7. Missing SKU.
8. Ambiguous duplicate SKU.
9. Malformed local pagination cursor.
10. Catalog pagination over multiple Shopify pages.
11. Catalog synchronization interrupted between pages.
12. Redis unavailable after database transaction commits.
13. Outbox event published twice.
14. Duplicate BullMQ job delivery.
15. Two workers attempting to claim the same OrderIntent.
16. Shopify GraphQL userError.
17. Shopify throttling.
18. Shopify network error before request dispatch.
19. Shopify mutation may have succeeded but response is lost.
20. Reconciliation finds the created order.
21. Reconciliation finds no order.
22. Reconciliation finds multiple matching orders.
23. Worker restart.
24. Duplicate webhook delivery.
25. Scope removed during active import.
26. App uninstalled during active import.
27. Status endpoint makes no Shopify calls.
28. Cross-shop authorization attempt.
29. Dead-letter replay.
30. Replay after an order already succeeded.

Use deterministic clocks and mocked network behavior where practical.

======================================================================
27. CODE QUALITY RULES
======================================================================

Follow these rules:

- Keep changes focused.
- Do not reformat unrelated files.
- Prefer small cohesive modules.
- Use TypeScript for new services and worker code.
- Avoid any unless there is a documented interoperability reason.
- Avoid enormous route modules.
- Keep Shopify GraphQL operations in dedicated modules.
- Keep domain logic outside React components.
- Keep queue processing logic outside route handlers.
- Keep Prisma access server-only.
- Do not expose server modules to the client bundle.
- Use Prisma transactions for multi-record state transitions.
- Use Prisma Decimal or decimal strings for money.
- Do not use JavaScript floating-point arithmetic for monetary totals.
- Use UTC timestamps in storage.
- Validate all external input.
- Use typed error classes or discriminated error results.
- Preserve useful Shopify GraphQL userError fields.
- Do not expose raw internal errors to merchants.
- Use comments for non-obvious reliability decisions, not obvious syntax.
- Do not add abstractions without an immediate use.
- Do not use Redis as permanent business storage.
- Do not use in-memory process state for cross-worker coordination.
- Do not make tenant isolation depend only on UI behavior.
- Do not claim commands passed without running them.

======================================================================
28. WORKING MODE
======================================================================

At the beginning of each phase:

1. Read this brief.
2. Inspect the current repository state.
3. Read docs/implementation-plan.md and previous ADRs.
4. State the goal of the phase.
5. List expected files and migrations.
6. Identify any assumptions.

During implementation:

- Make reasonable decisions without repeatedly asking for confirmation.
- Ask only when a decision is truly blocking or has serious irreversible consequences.
- Do not rewrite unrelated features.
- Preserve the working Shopify authentication flow.
- Keep the application runnable after each phase.

At the end of each phase, provide:

1. Summary of what was implemented.
2. Architecture decisions made.
3. Files added or changed.
4. Prisma migrations added.
5. Dependencies added or removed.
6. Commands run.
7. Exact test/build results.
8. Manual verification steps.
9. Known limitations.
10. Next recommended phase.

For the first run, perform PHASE 0 only.

Do not implement Phase 1 or later during the first run.

Create the requested planning and architecture documentation, report your audit findings, and stop after Phase 0.