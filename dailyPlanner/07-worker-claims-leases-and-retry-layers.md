# Day 7 — Worker Claims, Leases, and Retry Layers

## Goal

Understand the worker control flow and distinguish manual delay, business retry state, BullMQ retry, and an expired processing lease.

## Read in this order

1. [`worker/index.js`](../worker/index.js).
2. [`worker/queue-workers.js`](../worker/queue-workers.js).
3. `processOrderJob()` and `processOrderCreate()` in [`worker/processors/order.processor.js`](../worker/processors/order.processor.js).
4. Claim/retry functions in [`app/services/orders/order-state.server.js`](../app/services/orders/order-state.server.js).
5. Queue defaults in [`app/queues/queues.server.js`](../app/queues/queues.server.js).
6. The order pipeline tests named “only one of two workers,” “stale processing claim,” “throttling,” and “Admin client fails.”

## Worker boot and shutdown

`worker/index.js` validates environment, constructs shared dependencies, starts the outbox dispatcher and catalog scheduler, and creates three workers:

- `order-write`, configurable concurrency;
- `catalog-sync`, configurable concurrency;
- `maintenance`, concurrency 1.

On shutdown it stops new scheduler work, stops the dispatcher, closes workers/queues, quits the rate-gate connection, and disconnects Prisma.

## Generic worker wrapper

`createWorker()` supplies logging around a queue-specific processor. It logs safe IDs when a job starts, completes, fails, or the worker connection errors.

The special behavior is:

```text
OrderWorkDeferredError or ShopifyRateLimitDeferredError
    -> job.moveToDelayed(now + retryAfterMs)
    -> throw BullMQ DelayedError
```

This intentionally delays the same job without busy-waiting inside a worker slot.

## Order create control flow

Read `processOrderCreate()` as guarded stages:

1. Reload intent and shop by trusted `shopId`.
2. No-op if missing or already succeeded.
3. If another worker owns a live `PROCESSING` lease, delay until the lease expires.
4. If a processing lease is expired, do **not** create again; mark the result ambiguous and schedule reconciliation.
5. Respect future `nextAttemptAt`.
6. Cancel if uninstalled; delay if scope is missing.
7. Reserve the per-store order-create resource gate.
8. Atomically claim eligible database state.
9. Obtain offline Admin client.
10. Wrap client with a last-moment capability guard and Shopify cost gate.
11. Classify the result into success, retry, ambiguous, or permanent failure.
12. Persist the matching state transition.

The worker never trusts job payload as the full order. The payload contains an intent ID; the worker reloads current lines, shop, mappings, and status from PostgreSQL.

## Claim and lease

The database claim changes an eligible row to `PROCESSING`, stores `processingStartedAt`, and increments `attemptCount`. Network work happens after the transaction, so a permanent lock is not held.

`ORDER_PROCESSING_LEASE_MS` answers: “How long should another delivery assume this worker may still be active?”

- lease alive: delay duplicate job;
- lease expired during an order write: outcome is uncertain, so enter `AMBIGUOUS_RESULT`;
- lease expired during read-only reconciliation: safe to release and repeat the read.

The write/read distinction is fundamental. Retrying a read is safe; blindly retrying an uncertain create may duplicate a Shopify order.

## Four retry mechanisms

### 1. Outbox publication retry

Dispatcher keeps scanning `publishedAt: null`. This retries PostgreSQL-to-Redis delivery.

### 2. Manual BullMQ delay

Expected temporary conditions throw `OrderWorkDeferredError`. The wrapper moves the existing job to delayed state. Examples: future `nextAttemptAt`, missing scope, rate capacity, Admin client unavailable.

### 3. Business retry state

The intent becomes `RETRY_WAIT` and stores category, safe message, and `nextAttemptAt`. This makes retry status visible and durable even if Redis is restarted.

`retryDelay()` uses exponential growth capped at 60 seconds plus small jitter.

### 4. BullMQ automatic attempts

Unexpected thrown errors use the queue’s `attempts` and exponential backoff. These are transport/process retries. They do not automatically write `DeadLetterRecord`.

An unexpected exception after a create claim can leave the intent `PROCESSING`. A later delivery first waits for the lease; once expired it conservatively enters ambiguity/reconciliation instead of issuing another create.

## Important correction: this app has no separate BullMQ dead-letter queue

“Dead letter” here is a **business database state** (`OrderIntent.DEAD_LETTER`) plus a `DeadLetterRecord`. It is written when `createShopifyOrder()` returns a classified permanent error and `markOrderIntentPermanentFailure()` runs.

BullMQ failed jobs are retained by `removeOnFail`, but exhaustion alone is not the code path that creates the business dead-letter record. This distinction is worth stating clearly in any project defense.

## Exercise: classify failures

| Failure | Retry behavior |
|---|---|
| Redis unavailable during publication | Outbox remains unpublished |
| Shopify cost gate lacks points | Durable retry time + manual delayed job |
| Offline Admin client temporarily unavailable | `RETRY_WAIT` + delayed job |
| Shopify validation/user error | Business `DEAD_LETTER` immediately |
| Network drops after mutation dispatch | `AMBIGUOUS_RESULT`, never blind create retry |
| Unknown processor bug | BullMQ automatic attempt; lease protects write |

## Defend-it questions

1. How do two workers avoid creating the same intent simultaneously?
2. Why is there a lease instead of holding a transaction during Shopify I/O?
3. What is the difference between `job.attemptsMade` and `OrderIntent.attemptCount`?
4. Which errors use manual delay, and which use BullMQ automatic attempts?
5. Does BullMQ move an exhausted job into `DeadLetterRecord` automatically?

