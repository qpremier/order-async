# OrderRelay Engineering Architecture Guide

OrderRelay is best understood as a **modular monolith deployed as two processes**, using an **event-driven transactional-outbox architecture**.

Its central rule is:

> PostgreSQL records what must happen. Redis and BullMQ transport when it should happen. Workers perform it. Shopify is the remote system.

```text
Merchant / Shopify webhook
           |
           v
   React Router web process
           |
           | PostgreSQL transaction
           v
 Business records + OutboxEvent
           |
           v
    Outbox dispatcher
           |
           v
 Redis-backed BullMQ queues
           |
           v
    Separate worker process
           |
           +-- Shopify Admin GraphQL
           +-- PostgreSQL state updates
```

## 1. What kind of architecture is this?

This is not a collection of microservices. It is one codebase with two independently runnable processes:

- `web`: authentication, pages, HTTP actions, CSV parsing, webhook acceptance, and PostgreSQL writes.
- `worker`: outbox dispatching, BullMQ consumers, catalog synchronization, order creation, reconciliation, and lifecycle cleanup.

Both use the same Prisma schema, PostgreSQL database, and Redis instance. The worker entry point is [`worker/index.js`](../worker/index.js), while the Shopify web configuration starts in [`app/shopify.server.js`](../app/shopify.server.js).

This separation means a slow Shopify API request does not keep an upload or webhook HTTP request open.

## 2. PostgreSQL versus Redis

The most important distinction is:

> Redis does not contain the application's catalog cache. The catalog cache is stored in PostgreSQL.

PostgreSQL stores:

- Shopify sessions
- Shop installation and scope state
- Cached catalog variants
- SKU mappings
- Imports and order intents
- Order lines
- Outbox events
- Webhook deduplication receipts
- Dead-letter history
- Catalog synchronization checkpoints

These models and constraints are in [`prisma/schema.prisma`](../prisma/schema.prisma).

Redis stores transient infrastructure state:

- BullMQ waiting, active, delayed, completed, and failed jobs
- BullMQ job locks
- Per-shop Shopify GraphQL cost-budget state
- The optional five-orders-per-minute rolling gate

Redis persistence is configured with AOF in [`docker-compose.yml`](../docker-compose.yml), but PostgreSQL remains the business source of truth.

## 3. Transactional outbox

The application wants to avoid this unsafe sequence:

1. Commit an order as queued in PostgreSQL.
2. Try publishing to Redis.
3. Redis fails.
4. The order is permanently forgotten.

Instead, confirmation performs one PostgreSQL transaction containing:

- `OrderIntent: READY -> QUEUED`
- A deterministic `sourceIdentifier`
- A new `OutboxEvent` of type `order.create`

See [`confirmImportBatch`](../app/services/orders/order-state.server.js).

The worker process runs an `OutboxDispatcher` every two seconds by default. It reads unpublished events, converts them to safe BullMQ jobs, publishes them, and only then sets `publishedAt`. See [`dispatcher.server.js`](../app/services/outbox/dispatcher.server.js).

If Redis is unavailable during publication:

- The business transaction remains committed.
- `publishedAt` stays `null`.
- The publication error is sanitized and recorded.
- A later dispatcher iteration tries again.

If publication succeeds but the dispatcher crashes before setting `publishedAt`, it republishes the event. A deterministic BullMQ job ID normally collapses that duplicate.

One limitation is that there is no outbox claim or `FOR UPDATE SKIP LOCKED`. Multiple dispatcher replicas may read the same rows. This is safe in common cases because of deterministic job IDs and the conditional `publishedAt` update, but it is less efficient than a leased outbox implementation.

## 4. BullMQ queues and jobs

Three queues are defined in [`queue-names.js`](../app/queues/queue-names.js):

| Queue | Responsibility | Default concurrency |
| --- | --- | ---: |
| `order-write` | Order creation, replay, and ambiguity reconciliation | 5 |
| `catalog-sync` | Full catalog sync and product refresh | 2 |
| `maintenance` | Lifecycle webhooks and diagnostics | 1 |

The routing table is in [`jobs.js`](../app/queues/jobs.js).

Jobs have:

- Five attempts by default
- Exponential BullMQ backoff starting at one second
- 25% jitter
- Completed retention of one day or 1,000 jobs
- Failed retention of seven days or 1,000 jobs

Those defaults are in [`queues.server.js`](../app/queues/queues.server.js).

Lower priority numbers run first. For example, order creation has priority `1`, reconciliation `2`, replay `3`, catalog refresh `5`, bootstrap `10`, and diagnostics `50`.

### Job payload security

The entire outbox JSON payload is not blindly copied into Redis. Each event type has a Zod allowlist. Unknown fields are stripped.

An order job therefore contains an `orderIntentId`, not the customer email, shipping address, CSV row, or Shopify token. The worker reloads sensitive business data from PostgreSQL.

## 5. How workers are made

[`createQueueWorkers`](../worker/queue-workers.js) constructs three BullMQ `Worker` objects.

Each worker:

1. Watches one Redis queue.
2. Receives a job.
3. Logs safe correlation information.
4. Validates its payload.
5. Reloads current state from PostgreSQL.
6. Runs its processor.
7. Logs completion or failure.

Concurrency is per worker process. With two worker replicas and `ORDER_WORKER_CONCURRENCY=5`, the deployment could process up to ten order jobs concurrently.

Maintenance concurrency is `1` per process, not globally one across all replicas.

The worker also owns:

- The outbox polling loop
- The catalog reconciliation scheduler
- The Redis rate-gate connection
- Graceful `SIGTERM` and `SIGINT` shutdown

## 6. CSV-to-order flow

The complete order path is described below.

### Upload

[`app.imports.new.jsx`](../app/routes/app.imports.new.jsx) authenticates the merchant and parses the CSV synchronously during the HTTP request.

[`parseImportCsv`](../app/services/imports/import-parser.server.js):

- Enforces byte and row limits
- Validates headers
- Validates each field with Zod
- Groups rows by `external_order_id`
- Requires order-level fields to be consistent
- Normalizes email, currency, timestamps, price, and SKU
- Sorts lines into a canonical order
- Hashes the canonical payload

The raw uploaded CSV is not stored. However, parsed customer and order data is stored in PostgreSQL.

### Draft creation

[`createDraftImport`](../app/services/imports/import-domain.server.js) creates:

- One `ImportBatch`
- One `OrderIntent` per external order
- Associated `OrderLine` rows
- Batch-to-intent links

SKU matching uses PostgreSQL `CatalogVariant` and `SkuMapping` records. A unique SKU becomes `VALID`; no match becomes `NEEDS_MAPPING`; multiple matches become `AMBIGUOUS_MAPPING`.

### Confirmation

Confirmation changes only `READY` orders to `QUEUED` and writes an outbox event. No Shopify API call occurs in the HTTP request.

### Worker claim

The order worker conditionally updates:

```text
QUEUED or due RETRY_WAIT -> PROCESSING
```

The update also requires `shopifyOrderGid` to be null. Only the worker whose `updateMany()` count is one owns the order. See [`claimOrderIntentForProcessing`](../app/services/orders/order-state.server.js).

### Shopify creation

[`processOrderCreate`](../worker/processors/order.processor.js) verifies:

- The order is not already successful
- No live worker lease exists
- The shop is installed
- `write_orders` is present
- The per-store resource gate allows the request
- The GraphQL cost gate allows the request

It then calls `orderCreate` through [`createShopifyOrder`](../app/services/orders/order-create.server.js).

The input contains:

- Email and optional shipping address
- Imported currency and processing time
- Variant GIDs
- Imported quantities and prices
- A deterministic source identifier
- OrderRelay tags
- No payment transactions

## 7. Idempotency layers

The project does not depend on a single idempotency mechanism. It uses several layers:

| Layer | Protection |
| --- | --- |
| Upload request | Unique `(shopId, idempotencyKey)` |
| External business order | Unique `(shopId, sourceSystem, externalOrderId)` |
| Changed duplicate detection | Canonical `payloadHash` |
| Shopify identity | Unique `(shopId, sourceIdentifier)` |
| Webhook delivery | Unique `(shopId, webhookId)` |
| Queue publication | Deterministic BullMQ job ID |
| Worker concurrency | Conditional database state transition |
| Duplicate completed delivery | `SUCCEEDED` or `shopifyOrderGid` no-op |
| Uncertain Shopify write | Read-only reconciliation before another create |

This provides **effectively-once business behavior over at-least-once delivery**, not mathematical exactly-once execution.

## 8. Processing leases and ambiguous writes

A worker records `processingStartedAt` when it claims an order. The default lease is five minutes.

If another delivery finds `PROCESSING`:

- With a live lease, it delays itself until the lease expires.
- With an expired lease, it assumes the previous worker may have sent `orderCreate`.

The second case becomes `AMBIGUOUS_RESULT`. The app deliberately does not retry the mutation.

A delayed reconciliation job searches Shopify using:

```text
source_identifier:"orderrelay:<source>:<hash>"
```

See [`order-reconcile.server.js`](../app/services/orders/order-reconcile.server.js).

Results are handled as follows:

- Exactly one order: mark the intent `SUCCEEDED`.
- Zero orders: retry the read a bounded number of times.
- Multiple orders: stop for merchant review.
- Bounded zero-result exhaustion: remain ambiguous for review.
- Never automatically issue another create.

That conservative behavior is one of the project's strongest architectural decisions.

## 9. Retry behavior

There are two separate retry mechanisms.

### Controlled deferrals

Expected temporary conditions explicitly move the job into BullMQ's delayed set:

- Rate budget unavailable
- Development-store order limit
- Missing scope
- Future `nextAttemptAt`
- Active processing lease
- Reconciliation delay
- Temporary authentication failure

The worker calls `job.moveToDelayed()` and throws BullMQ's `DelayedError`. It does not sleep or occupy a concurrency slot.

### BullMQ failure attempts

Unexpected thrown errors use BullMQ's five-attempt exponential backoff.

This distinction means `JOB_MAX_ATTEMPTS=5` is not a universal business retry limit. Controlled deferrals can continue without being treated as five permanent failures.

## 10. Shopify throttling

[`ShopifyRateGate`](../app/services/shopify/shopify-rate-gate.server.js) implements two per-shop Redis gates.

### GraphQL cost gate

A Lua script atomically:

1. Loads the shop's last known capacity.
2. Restores estimated capacity based on elapsed time.
3. Pads the estimated request cost using the safety margin.
4. Reserves capacity or calculates a wait.
5. Saves the new state with a one-hour TTL.

Lua is used so concurrent workers cannot both read the same available budget and overspend it.

After a GraphQL response, the wrapper reads Shopify's `extensions.cost.throttleStatus` and updates:

- `maximumAvailable`
- `currentlyAvailable`
- `restoreRate`

Order and catalog calls share the same shop key. Catalog calls are marked `background`, so they preserve 20% headroom under the default `0.8` safety margin.

### Five-order rolling window

If Shopify returns the recognized "too many attempts" order-create user error, the app activates a second Redis gate:

- Five order creations
- Per rolling 60-second window
- Plus a safety delay
- Shared across worker concurrency for that shop

It is not active unless Shopify first reports that resource limit.

## 11. Webhooks

Subscriptions are declared in [`shopify.app.toml`](../shopify.app.toml):

- `app/uninstalled`
- `app/scopes_update`
- `products/create`
- `products/update`
- `products/delete`

Routes call `authenticate.webhook(request)`, which delegates signature and authentication handling to Shopify's React Router integration.

### Product webhooks

[`ingestProductWebhook`](../app/services/catalog/product-webhooks.server.js):

1. Extracts the product GID.
2. Hashes the payload.
3. Creates a unique `WebhookReceipt`.
4. Creates `catalog.refresh-product` outbox work.
5. Returns `202`.

The catalog worker later queries Shopify and updates only that product's variants.

### Lifecycle webhooks

[`ingestAppLifecycleWebhook`](../app/services/webhooks/app-lifecycle.server.js) immediately commits critical security state.

Uninstall immediately:

- Marks the shop `UNINSTALLED`
- Records the timestamp
- Deletes Shopify sessions
- Stores the receipt
- Queues maintenance cleanup

The maintenance worker later cancels unfinished orders, imports, and catalog runs.

Scope updates immediately update durable scope state. Maintenance then pauses or resumes eligible order work.

Workers also recheck shop status and scope immediately before GraphQL through [`withShopCapabilityGuard`](../app/services/shops/shop-capabilities.server.js). This reduces the uninstall and scope race, although an already in-flight request cannot be recalled.

## 12. Catalog cache architecture

The catalog is a PostgreSQL read model populated from Shopify.

A full sync:

1. Loads the previous cursor.
2. Fetches one GraphQL page.
3. Upserts that page.
4. Saves `lastProcessedCursor` in the same page transaction.
5. Repeats.
6. Only after complete success marks unseen variants deleted.

See [`runFullCatalogSync`](../app/services/catalog/catalog-sync.server.js).

This means a failed sync:

- Preserves the previously usable cache
- Can resume from its checkpoint
- Does not prematurely delete products not yet seen

The worker also runs a catalog scheduler. With the default 60-minute stale threshold, it runs hourly and schedules stale shops. Its `running` boolean prevents overlap within one process, but it is not a distributed leader lock across multiple worker replicas.

## 13. Dead letters and replay

Permanent Shopify user errors move the intent to `DEAD_LETTER`, while the same transaction creates a `DeadLetterRecord` and refreshes batch counters.

Replay:

- Keeps the same `OrderIntent`
- Keeps the same `sourceIdentifier`
- Checks installation and scopes
- Confirms mapped variants still exist
- Marks the previous dead-letter record as replayed
- Creates a new outbox event

Ambiguous writes cannot use replay-by-create. They expose only reconciliation.

## 14. Progress, pagination, and observability

The browser polls PostgreSQL, never Shopify, through the status endpoint.

It uses:

- A version counter
- ETags and `304 Not Modified`
- Increasing poll delay when unchanged
- No polling when the tab is hidden
- Stopping at terminal status

See [`import-status.server.js`](../app/services/imports/import-status.server.js).

Pagination uses opaque keyset cursors based on `(createdAt, id)`, avoiding expensive offset pagination.

Logs are structured JSON with correlation, shop, batch, intent, outbox, and job IDs. Known sensitive fields and sensitive-looking strings are redacted in [`logger.server.js`](../app/services/logging/logger.server.js).

## 15. Important limitations

These limitations should be explained honestly:

- Exactly-once behavior is not guaranteed after an irreducibly uncertain remote write.
- CSV validation happens synchronously in the upload request and retains normalized rows in memory.
- The outbox lacks leased claims or `SKIP LOCKED`.
- Catastrophic Redis job loss after `publishedAt` is recorded would require operational repair; there is no general queued-intent rehydration scanner.
- The catalog scheduler has no distributed leader election.
- A catalog job blocked by missing `read_products` completes without clearly failing or cancelling its `RUNNING` sync run, which can leave the run stuck.
- `catalog.reconcile` currently logs a no-op.
- `import.validate` is defined in routing, but the maintenance processor does not implement it; current CSV validation is synchronous.
- There is no worker HTTP health endpoint, automated retention purge, or full queue metrics dashboard.
- Dead-letter replay checks broken mappings, but the UI cannot currently repair mappings on a non-draft dead-lettered intent.
- Product and lifecycle receipts do not consistently record final worker failure details in `processingError`.

## 16. Recommended reading order

Read the project in this order:

1. [`README.md`](../README.md)
2. [`docs/architecture.md`](architecture.md)
3. [`prisma/schema.prisma`](../prisma/schema.prisma)
4. [`app/queues/jobs.js`](../app/queues/jobs.js)
5. [`app/services/outbox/dispatcher.server.js`](../app/services/outbox/dispatcher.server.js)
6. [`worker/index.js`](../worker/index.js)
7. [`worker/processors/order.processor.js`](../worker/processors/order.processor.js)
8. [`app/services/orders/order-state.server.js`](../app/services/orders/order-state.server.js)
9. [`app/services/shopify/shopify-rate-gate.server.js`](../app/services/shopify/shopify-rate-gate.server.js)
10. [`docs/interview.md`](interview.md), which contains hundreds of focused engineering questions and answers

## Verification notes

At the time this guide was written:

- JavaScript linting and syntax checks passed.
- The complete serial test run passed all 68 tests.
- A default parallel run initially produced a shared-test-database deadlock. The affected test passed independently, and the complete suite passed when run serially. This indicates test isolation interference rather than a reproducible order-pipeline failure.
