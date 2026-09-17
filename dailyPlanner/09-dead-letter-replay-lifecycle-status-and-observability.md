# Day 9 — Dead Letters, Replay, Lifecycle, Status, and Observability

## Goal

Understand operator and merchant recovery: how permanent failures are recorded, which actions are safe, how uninstall/scope changes stop work, and how progress remains local.

## Read in this order

1. `markOrderIntentPermanentFailure()` in [`app/services/orders/order-state.server.js`](../app/services/orders/order-state.server.js).
2. [`app/services/orders/order-attention.server.js`](../app/services/orders/order-attention.server.js).
3. [`app/routes/app.needs-attention.jsx`](../app/routes/app.needs-attention.jsx).
4. [`app/services/webhooks/app-lifecycle.server.js`](../app/services/webhooks/app-lifecycle.server.js).
5. [`worker/processors/maintenance.processor.js`](../worker/processors/maintenance.processor.js).
6. [`app/services/imports/import-status.server.js`](../app/services/imports/import-status.server.js) and [`app/services/imports/import-polling.js`](../app/services/imports/import-polling.js).
7. [`app/services/logging/logger.server.js`](../app/services/logging/logger.server.js).
8. [`tests/phase6-reliability.test.js`](../tests/phase6-reliability.test.js) and [`tests/phase7-hardening.test.js`](../tests/phase7-hardening.test.js).

## Business dead-letter transition

For a classified permanent order failure, one PostgreSQL transaction:

1. verifies the intent is still `PROCESSING` and has no Shopify order GID;
2. changes it to `DEAD_LETTER`;
3. stores category, code, and bounded sanitized message;
4. creates `DeadLetterRecord` with attempts and timestamps;
5. refreshes linked batch aggregates.

`DeadLetterRecord` contains operational history, not the entire failed order payload. The order data remains on `OrderIntent`/`OrderLine`.

Typical permanent failures include Shopify mutation `userErrors` or violated internal invariants. Throttling, missing scopes, and ambiguous writes must not be dead-lettered as though they were ordinary permanent validation failures.

## Controlled replay

`replayDeadLetterOrder()` is not “clone and retry.” It runs a guarded transaction:

1. load intent, shop, lines, and latest unreplayed dead-letter record;
2. no-op/close history if already succeeded;
3. require current status `DEAD_LETTER`;
4. require installed shop and `write_orders`;
5. require every mapping to be valid and every selected variant still active;
6. conditionally transition the same intent to `QUEUED`;
7. mark the failure history with `replayedAt` and `replayedBy`;
8. create `dead-letter.replay` outbox work;
9. refresh batches.

The same `OrderIntent` and `sourceIdentifier` are reused. `attemptCount` is not erased, preserving cumulative history.

## Ambiguous results get a different action

`requestAmbiguousReconciliation()` requires `read_orders`, claims scheduling fields, and creates `order.reconcile-ambiguous`. It never queues `order.create`.

This UI/API separation is a safety boundary: merchants can replay known permanent failures, but uncertain writes can only be checked with a read.

## App lifecycle webhooks

Lifecycle ingestion authenticates/deduplicates the webhook and commits immediate capability state before asynchronous cleanup.

### App uninstall

The ingest transaction marks the shop `UNINSTALLED`, records the time, deletes stored sessions, and creates maintenance work. The maintenance processor then cancels eligible unsucceeded intents and batches and cancels running catalog syncs.

Every worker also checks durable shop status just before Shopify calls. Queue jobs are not trusted to become harmless merely because uninstall cleanup was requested.

### Scope update

If `write_orders` disappears, queued/retry work becomes scope-blocked `RETRY_WAIT` without consuming a Shopify attempt. When scope returns, maintenance creates new outbox work for eligible creates. Ambiguous reconciliation resumes only if read access is present.

The distinction between immediate state update and asynchronous bulk cleanup keeps the webhook response quick while closing the authorization window early.

## Local status polling

Import status is computed from PostgreSQL and includes a version/update-based ETag. The resource route returns `304 Not Modified` when the client’s ETag matches.

Client behavior:

- poll while state is nonterminal;
- increase delay after unchanged responses;
- pause when the document is hidden;
- stop on `PARTIALLY_COMPLETED`, `COMPLETED`, `FAILED`, or `CANCELLED`.

No Shopify API call is needed to refresh progress. Worker state transitions update batch counters/version locally.

## Correlated, redacted logs

The outbox event ID becomes the async correlation root. Logs can join:

```text
HTTP/outbox -> publication -> BullMQ job -> processor -> result
```

Useful safe fields include operation, shop ID, batch ID, intent ID, outbox ID, queue, and job ID. The logger redacts known sensitive keys and sensitive-looking values. Queue payload Zod schemas are the stronger first defense; log redaction is defense in depth.

Never debug by adding access tokens, raw webhook payloads, CSV rows, email, address, or phone to logs.

## Exercise: choose the recovery action

| Visible state | Safe merchant/operator action |
|---|---|
| `NEEDS_MAPPING` | select active variant mapping |
| `AMBIGUOUS_MAPPING` | explicitly choose one variant |
| `DEAD_LETTER` | fix cause/mapping/scope, then controlled replay |
| `AMBIGUOUS_RESULT` | read-only reconciliation only |
| `RETRY_WAIT` due to scope | reauthorize; lifecycle flow resumes |
| `CANCELLED` after uninstall | reinstall/reauthorize; do not trust old queue job |

## Defend-it questions

1. Is the dead-letter record a BullMQ feature in this project?
2. What checks run before replay?
3. Why can an ambiguous result not use the replay action?
4. How does uninstall prevent a queued job from making a later API call?
5. Why are status polls served from PostgreSQL and guarded with ETags?

