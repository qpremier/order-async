# Day 6 — Transactional Outbox and Job Routing

## Goal

Explain exactly how committed database intent becomes queue work, including failures between PostgreSQL and Redis.

This is the first deep reliability day.

## Read in this order

1. [`docs/adr/002-idempotency-and-transactional-outbox.md`](../docs/adr/002-idempotency-and-transactional-outbox.md).
2. [`app/services/outbox/outbox.server.js`](../app/services/outbox/outbox.server.js).
3. `confirmImportBatch()` in [`app/services/orders/order-state.server.js`](../app/services/orders/order-state.server.js).
4. [`app/queues/jobs.js`](../app/queues/jobs.js).
5. [`app/services/outbox/dispatcher.server.js`](../app/services/outbox/dispatcher.server.js).
6. [`app/queues/queues.server.js`](../app/queues/queues.server.js).
7. [`tests/phase2-outbox.test.js`](../tests/phase2-outbox.test.js).

## The dual-write problem

Suppose an HTTP action does these two independent operations:

1. update order to `QUEUED` in PostgreSQL;
2. add a job to Redis.

There is no transaction spanning both systems.

- Database commit succeeds, Redis add fails: order says queued but no work exists.
- Redis add succeeds, database commit fails: worker receives work for state that does not exist or is not ready.

The transactional outbox changes the write path:

```text
ONE PostgreSQL transaction:
  OrderIntent READY -> QUEUED
  INSERT OutboxEvent(order.create)

Later, independent dispatcher:
  SELECT unpublished OutboxEvent
  ADD deterministic BullMQ job
  UPDATE OutboxEvent.publishedAt
```

The business mutation and its promise of future work either commit together or roll back together.

## Outbox creation

`createOutboxEvent(client, input)` is deliberately small so it can accept a Prisma transaction client. Callers must create the row inside the same transaction as their state change.

An outbox row contains:

- tenant (`shopId`);
- aggregate identity/type;
- event type;
- durable payload;
- publication state and error metadata.

The durable payload may contain more fields than Redis is allowed to receive. Publication uses an event-specific safe projector.

## Event-to-job routing

`jobs.js` centralizes four contracts:

1. `OUTBOX_EVENT_TYPES`: durable domain event names.
2. `JOB_NAMES`: processor-visible BullMQ names.
3. `EVENT_ROUTING`: queue, job, priority, dedupe source.
4. `SAFE_PAYLOAD_SCHEMAS`: Zod allowlists for Redis data.

`describeOutboxJob()` converts an event into queue name, job name, deterministic ID, safe data, priority, and optional delay.

Example identity concept:

```text
OutboxEvent.id E123
  -> correlationId E123
  -> BullMQ job ID order-create__E123
```

The queue receives operational identifiers, not order email, address, raw CSV, access token, or full webhook body.

## Publication failure cases

### Redis add fails

`publishedAt` stays null, `attemptCount` increments, and `lastPublishError` is sanitized. The polling loop sees the row again after `OUTBOX_POLL_INTERVAL_MS`.

### Redis add succeeds, then process crashes before database update

The row remains unpublished and is added again later. Because the job ID is deterministic, BullMQ deduplicates the common duplicate publication.

### Two dispatchers publish the same row

Both can attempt queue publication. The conditional database update includes `publishedAt: null`, so only one records the publication transition. Deterministic job ID prevents duplicate queue identities.

### Database update succeeds

The dispatcher stops selecting that row because `publishedAt` is no longer null.

This produces **at-least-once delivery**, not exactly-once execution. Worker handlers still must be idempotent.

## Queue defaults

`createDefaultJobOptions()` configures:

- `attempts`: default `JOB_MAX_ATTEMPTS` (5);
- exponential backoff starting at one second with jitter;
- completed job retention by age/count;
- failed job retention by age/count.

These are transport defaults. They do not replace database state transitions. In particular, the app’s `DeadLetterRecord` is not created merely because BullMQ exhausts `attempts`.

## Dispatcher loop

`OutboxDispatcher.start()` begins a polling loop. Each iteration loads a bounded batch in creation order and publishes serially. Errors are logged, then the loop sleeps. `stop()` interrupts the sleep and waits for the loop to exit, enabling graceful shutdown.

The present design can republish safely, but it is a simple poller rather than a high-throughput claimed outbox. Be prepared to say that its correctness comes from idempotency; horizontal dispatcher scale may cause extra duplicate attempts.

## Exercise: draw the crash matrix

Create a table with crash moments:

| Crash moment | Durable DB state | Redis state | Recovery |
|---|---|---|---|
| Before transaction commit | no queue transition/outbox | none | merchant can retry |
| After DB commit, before dispatch | queued + unpublished event | none | poller publishes |
| After Redis add, before `publishedAt` | queued + unpublished event | job exists | republish same job ID |
| After `publishedAt` | queued + published event | job exists | worker processes |

Verify each row against the Phase 2 tests.

## Defend-it questions

1. What problem does the transactional outbox solve?
2. Why does publication happen only after the database transaction?
3. Why is deterministic `jobId` necessary but insufficient for business idempotency?
4. What data is stripped before entering Redis?
5. What happens when Redis is unavailable for ten minutes?

