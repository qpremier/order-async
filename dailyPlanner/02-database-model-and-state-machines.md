# Day 2 — Database Model and State Machines

## Goal

Understand why the schema contains more than “orders” and how state transitions make concurrent work safe.

## Read in this order

1. [`prisma/schema.prisma`](../prisma/schema.prisma), enums first, models second.
2. [`prisma/migrations/20260910000000_postgresql_foundation/migration.sql`](../prisma/migrations/20260910000000_postgresql_foundation/migration.sql).
3. The later migrations in timestamp order.
4. [`app/services/orders/order-state.server.js`](../app/services/orders/order-state.server.js), reading only function names on the first pass.
5. [`tests/phase5-order-pipeline.test.js`](../tests/phase5-order-pipeline.test.js), especially concurrent claim and batch-counter tests.

## Domain groups

### Tenant and authentication

- `Session` is owned by Shopify’s Prisma session adapter and contains tokens.
- `Shop` is the app’s durable merchant/capability record.
- Every business record belongs to a `shopId`.

`Session` answers “can the SDK obtain Shopify access?” `Shop` answers “should our business logic allow this work?” These are related but not interchangeable.

### Catalog

- `CatalogSyncRun` stores resumable full-sync progress.
- `CatalogVariant` is the local read model.
- `SkuMapping` remembers a source-system SKU decision.

SKU is indexed but deliberately not unique: two Shopify variants can share one SKU, which creates an ambiguous mapping.

### Import and orders

- `ImportBatch` represents one upload attempt and stores aggregate counters.
- `OrderIntent` is the durable identity of one external order.
- `ImportBatchOrderIntent` permits later batches to reference the same intent.
- `OrderLine` stores normalized lines and their resolution state.

The unique key `(shopId, sourceSystem, externalOrderId)` prevents two local identities for the same external business order. `payloadHash` detects whether a later upload is identical or conflicting.

### Reliability records

- `OutboxEvent` means “durable work still needs publication.”
- `WebhookReceipt` deduplicates webhook delivery IDs.
- `DeadLetterRecord` keeps sanitized permanent-failure history.

## Order intent state machine

```text
DRAFT
  +--> NEEDS_MAPPING / AMBIGUOUS_MAPPING / INVALID
  +--> READY -> QUEUED -> PROCESSING -> SUCCEEDED
                              |  |
                              |  +--> DEAD_LETTER
                              |  +--> AMBIGUOUS_RESULT -> reconciliation -> SUCCEEDED
                              +--> RETRY_WAIT -> PROCESSING

Any active state may become CANCELLED after uninstall.
```

Do not treat statuses as display labels. They are a concurrency protocol. For example, `claimOrderIntentForProcessing()` uses `updateMany()` with a restrictive `where` clause. Only a row in `QUEUED`, or a due row in `RETRY_WAIT`, can become `PROCESSING`. Two workers can race, but only one update returns `count === 1`.

## Why `updateMany()` is used for a single row

Prisma `update()` throws or updates by a unique identifier; it does not express a compare-and-set condition as conveniently. `updateMany({ where: { id, status: ... }})` acts like:

```text
UPDATE ... WHERE id = ? AND status is eligible
```

The returned count is the claim result. This is optimistic concurrency without holding a database lock during a Shopify network call.

## Batch counters are derived state

An import can link to many intents, and one intent can appear in later identical batches. After an intent changes, `refreshLinkedBatches()` refreshes every linked batch.

`refreshBatch()` first locks the batch row with `SELECT ... FOR UPDATE`. This prevents two finishing workers from computing counters at the same time and letting an older snapshot overwrite a newer one. It then re-reads intent statuses, derives counts, derives the batch status, and increments `version` for polling/ETags.

## Three different counters

- `OrderIntent.attemptCount`: business create claims; incremented when a create worker successfully claims the intent.
- `OrderIntent.reconciliationAttemptCount`: read-only reconciliation claims.
- `OutboxEvent.attemptCount`: attempts to publish the event to Redis.

BullMQ also has `job.attemptsMade`. Never confuse these counters in an incident.

## Exercise: prove tenant isolation

Choose these three functions and find every `shopId` predicate:

- `claimOrderIntentForProcessing()`
- `getImportDetails()`
- `listNeedsAttentionPage()`

Then answer: could knowing another shop’s order intent ID authorize access? The intended answer is no; identity and tenant must match.

## Exercise: state transition table

Fill this in from `order-state.server.js`:

| Function | Required old state | New state | Side effect |
|---|---|---|---|
| `confirmImportBatch` | `READY` | `QUEUED` | Creates `order.create` outbox row |
| `claimOrderIntentForProcessing` | `QUEUED` or due `RETRY_WAIT` | `PROCESSING` | Increments `attemptCount` |
| `scheduleOrderIntentRetry` | `PROCESSING` | `RETRY_WAIT` | Sets `nextAttemptAt` |
| `markOrderIntentAmbiguous` | `PROCESSING` | `AMBIGUOUS_RESULT` | Creates reconciliation outbox row |
| `markOrderIntentPermanentFailure` | `PROCESSING` | `DEAD_LETTER` | Creates `DeadLetterRecord` |
| `markOrderIntentSucceeded` | allowed processing state | `SUCCEEDED` | Stores Shopify GID/name |

## Defend-it questions

1. Why are `ImportBatch` and `OrderIntent` separate?
2. Why is SKU not unique in `CatalogVariant`?
3. What prevents two workers from both owning one intent?
4. Why are batch counters recalculated inside a row lock?
5. What is the difference between a session and a shop capability record?

