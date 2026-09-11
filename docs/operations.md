# OrderRelay Operations Guide

This guide covers the current Phase 7 application. PostgreSQL is the durable source of truth; Redis and BullMQ provide delivery, delay, and coordination. Reliability is effectively-once at the business layer and is not a mathematical exactly-once guarantee.

## Process Topology

- `web` serves the embedded React Router app, authenticates Shopify requests and webhooks, parses CSV uploads, and writes local state plus outbox events.
- `worker` dispatches the outbox and runs the `order-write`, `catalog-sync`, and `maintenance` BullMQ workers.
- `postgres` stores sessions, shops, imports, catalog state, outbox events, webhook receipts, order intents, and dead-letter history.
- `redis` stores transient queue and rate-gate state. Losing Redis must not erase durable business intent.
- `migrate` is a one-shot deployment step. Do not let every web or worker replica race to run migrations.

## Health And Readiness

| Check                | Meaning                                                  | Expected response                                                                             |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /health`        | Web-process liveness only                                | `200 {"status":"ok"}`                                                                         |
| `GET /ready`         | Environment validation, PostgreSQL query, and Redis ping | `200` with all checks `pass`; otherwise `503`                                                 |
| Worker startup log   | Queue connections and processors were created            | JSON event `worker.started`                                                                   |
| Worker job logs      | A queue is actively consuming                            | `queue.job.started` followed by `queue.job.completed`, `queue.job.failed`, or a delayed retry |
| Dashboard cache card | Per-shop catalog freshness                               | `FRESH`, `STALE`, `FAILED`, `SYNCING`, or `NEVER_SYNCED` plus last successful sync            |

The readiness response reports only dependency names and sanitized failure states. It never returns connection strings or secrets. `/ready` proves Redis reachability from the web process; use the worker startup/job logs to prove the separately deployed worker can reach its queues.

## Structured Logs And Correlation

Logs are newline-delimited JSON. Common fields are:

- `timestamp`, `level`, and stable event `message`
- `processRole` and `operationName`
- `correlationId`
- `shopId`, `importBatchId`, and `orderIntentId` where applicable
- `outboxEventId`, `queueName`, `jobId`, and `attemptsMade` for asynchronous work
- bounded status, count, duration, and sanitized error fields

For asynchronous work, the durable outbox event ID is the correlation root and is copied into the queue envelope. Older queued jobs that predate Phase 7 fall back to `eventId`. Server-rendered requests accept a safe `X-Correlation-ID` or `X-Request-ID`, otherwise generate a UUID, and return `X-Correlation-ID` in the document response.

The logger redacts context keys related to email, address, phone, raw/CSV data, payloads, authorization, credentials, and tokens. It also redacts common email, phone, bearer-token, Shopify-token, and credential patterns in free text. Queue publication uses an event-specific schema that keeps only operational IDs, booleans, and bounded delay values needed by the processor.

Never add customer email, shipping data, raw rows, access tokens, session objects, or full Shopify request/response bodies to a log context or outbox payload. Redaction is a defense in depth, not authorization to log sensitive data.

## Error Categories

| Category                   | Operational treatment                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `VALIDATION`               | No automatic retry; return bounded, merchant-correctable feedback.                               |
| `MISSING_MAPPING`          | Block only the affected intent until a valid mapping is selected.                                |
| `AMBIGUOUS_MAPPING`        | Require an explicit variant selection because SKU is not unique.                                 |
| `SHOPIFY_USER_ERROR`       | Treat as permanent, sanitize the message, create dead-letter history, and show Needs Attention.  |
| `AUTHENTICATION`           | Retry when offline Admin access is temporarily unavailable; do not expose credentials.           |
| `MISSING_SCOPE`            | Pause without exhausting attempts; resume only after lifecycle state records the restored scope. |
| `SHOP_UNINSTALLED`         | Cancel active local work and prevent further Shopify calls.                                      |
| `THROTTLED`                | Delay through the per-shop cost gate; never dead-letter solely for throttling.                   |
| `NETWORK_TRANSIENT`        | Retry only when failure is known to be before write dispatch.                                    |
| `SHOPIFY_SERVER_TRANSIENT` | Retry safe reads; treat inconclusive writes conservatively.                                      |
| `AMBIGUOUS_WRITE_RESULT`   | Never blind-retry `orderCreate`; perform bounded read-only reconciliation.                       |
| `INTERNAL_BUG`             | Record a sanitized invariant failure and dead-letter after bounded handling.                     |
| `UNKNOWN`                  | Fail conservatively and preserve visible operational state.                                      |

## Queue And Outbox Recovery

Redis outage during publication:

1. The business transaction and `OutboxEvent` remain committed in PostgreSQL.
2. `publishedAt` stays null; `attemptCount` and a sanitized `lastPublishError` are updated.
3. The dispatcher backs off according to `OUTBOX_POLL_INTERVAL_MS` and republishes after Redis recovers.
4. A deterministic BullMQ job ID makes duplicate publication of the same event harmless.

Worker crash:

1. BullMQ can redeliver an unfinished job.
2. The processor reloads PostgreSQL and atomically claims eligible state.
3. Completed intents no-op on duplicate delivery.
4. An expired `PROCESSING` lease is treated as a potentially dispatched write and becomes `AMBIGUOUS_RESULT`.
5. Read-only reconciliation searches by deterministic `sourceIdentifier`; it never issues a blind replacement create.

Throttling or missing scope:

- The job is delayed instead of busy-waiting.
- Throttling uses Shopify cost metadata and a per-shop Redis gate shared by order and catalog workers.
- Missing `write_orders` pauses create work without consuming all attempts. `APP_SCOPES_UPDATE` restoration creates fresh outbox work for eligible intents.

Permanent failure:

- The intent and `DeadLetterRecord` change in one database transaction.
- Merchant replay keeps the same `OrderIntent` and source identifier, revalidates shop capability and mappings, records the replay actor/time, and creates a new outbox event.
- Ambiguous writes expose only reconciliation, not replay-by-create.

Do not recover an incident by manually changing an order to `QUEUED`, deleting its source identifier, or deleting outbox/dead-letter history. Use the Needs Attention actions or a reviewed data-repair procedure that preserves identity.

## Catalog Cache Consistency

- A full sync pages Shopify variants using `first`/`after` and saves `lastProcessedCursor` after each committed page.
- Retry resumes the running `CatalogSyncRun` from its last checkpoint.
- Upserts update the local read model without clearing the previous successful cache first.
- Variants absent from Shopify are marked deleted only after the entire full sync succeeds.
- A failed sync leaves prior rows available and sets the shop cache state to `STALE` or `FAILED` with a sanitized error.
- Product webhooks are authenticated and deduplicated, then enqueue targeted refresh work; the HTTP webhook does not perform a full Shopify sync.
- Scheduled reconciliation and the manual Sync catalog action repair missed webhook delivery and staleness.
- Duplicate active SKUs remain separate records. Import validation reports ambiguity until the merchant chooses a mapping.

During Shopify or Redis incidents, imports can still display cached catalog data and PostgreSQL-backed progress. Do not describe the cache as Shopify's system of record.

## Incident Checks

1. Check `/health`, then `/ready` to separate web liveness from dependency readiness.
2. Confirm a current `worker.started` event exists for the deployed worker revision.
3. Search logs by `correlationId`, then follow `outboxEventId` to `jobId` and `orderIntentId`.
4. Check unpublished outbox count and oldest age. A growing backlog with Redis failing indicates transport recovery, not lost business state.
5. Check delayed/failed BullMQ counts, but use PostgreSQL intent state as the authoritative customer-facing status.
6. For `AMBIGUOUS_RESULT`, inspect reconciliation history and the Shopify order link/search result. Never force a blind create.
7. For cache problems, inspect the latest `CatalogSyncRun`, its cursor, last error, and the shop's last successful sync time before requesting a manual sync.
8. For authorization problems, confirm durable shop status and granted scopes before restarting jobs.

## Deployment And Shutdown

1. Build one image and run `npm run migrate:deploy` as a controlled one-shot step.
2. Start web and worker as separate services from that image.
3. Route traffic only after `/ready` passes.
4. On SIGTERM/SIGINT the worker stops the catalog scheduler and dispatcher, closes BullMQ workers, Redis connections, queues, and Prisma, then exits.
5. Allow enough termination grace for active work. If a create worker loses its lease, the next delivery reconciles rather than blindly creating again.

## Manual Verification

1. Start PostgreSQL and Redis and apply all migrations.
2. Run the embedded app with `npm run dev` and the worker with `npm run worker:dev` using the same environment.
3. Open the app in a development store and run Sync catalog. Verify the cache becomes fresh and the worker logs carry correlation and queue fields.
4. Ensure `SKU-RED` and `SKU-BLUE` exist or create explicit mappings, upload `examples/orders-valid.csv`, preview, and confirm it.
5. Verify progress is served locally, reaches a terminal state, and successful rows link to Shopify Admin orders.
6. Upload `orders-missing-sku.csv` and resolve its mapping.
7. Upload `orders-invalid.csv` and verify bounded safe errors.
8. With source `demo-erp`, upload the valid sample and then `orders-duplicate-external-id.csv`; verify the changed identity is rejected rather than overwritten.
9. Revoke `write_orders` in a test configuration and verify work pauses; restore it and verify eligible work is re-enqueued.
10. Uninstall only from a disposable development store and verify local active work is cancelled and workers make no later Shopify calls.

## Known Limitations

- Automated tests cover the service pipeline with real PostgreSQL and mocked Shopify GraphQL, plus real Redis/BullMQ integration. They do not automate a browser through live Shopify OAuth or a development store.
- Shopify can complete a mutation while its response is irretrievably lost. Deterministic source identifiers and reconciliation reduce duplicate risk, but cannot provide a mathematical exactly-once guarantee.
- There is no automated retention/purge job for normalized customer order data yet.
- Queue and worker readiness are observable through logs and queue metrics; there is no separate authenticated worker-health HTTP endpoint.
- No inventory synchronization, fulfillment, payments, discounts, taxes, refunds, returns, order editing, product creation, or external-system connector is included.
- Deployment automation is intentionally not included. CI validates the repository; Shopify and infrastructure deployments require environment-specific credentials and review.
