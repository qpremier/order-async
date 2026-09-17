# Day 10 — Testing, Operations, and Project Defense

## Goal

Turn code knowledge into evidence: reproduce the system locally, use tests to validate failure behavior, diagnose incidents, and explain design tradeoffs clearly.

## Read in this order

1. [`docs/operations.md`](../docs/operations.md).
2. [`docker-compose.yml`](../docker-compose.yml) and [`Dockerfile`](../Dockerfile).
3. [`app/services/security/environment.server.js`](../app/services/security/environment.server.js) and [`.env.example`](../.env.example).
4. Test files in phase order: session, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6, Phase 7.
5. [`tests/helpers/failure-injection.js`](../tests/helpers/failure-injection.js).
6. [`docs/adr/001-postgresql-and-bullmq.md`](../docs/adr/001-postgresql-and-bullmq.md).
7. [`docs/interview.md`](../docs/interview.md) only after you can answer independently.

## Local process model

Default Compose starts infrastructure:

```text
postgres container  <--- host web process and host worker process
redis container     <--- host web process and host worker process
```

The optional `app` profile runs migration, web, and worker containers from the same image. The web and worker remain separate services even though they share source and image.

Environment validation occurs centrally. Important tuning groups are:

- import limits;
- worker concurrency;
- queue attempts;
- catalog page/freshness settings;
- Shopify estimated costs and safety margin;
- reconciliation delay/attempt bound;
- processing lease;
- outbox poll interval/batch size.

Do not change one without explaining its relationship to another. Example: increasing order concurrency does not safely increase Shopify capacity; the per-shop gate still controls requests.

## Tests as executable architecture

Use each test name as a claim the project makes:

- Phase 2: Redis failure does not lose durable events; republish does not duplicate job identity.
- Phase 3: sync pagination resumes; failed sync preserves good cache; duplicate SKU is ambiguous.
- Phase 4: parsing is bounded; canonical hashes are stable; tenant isolation and external-order conflicts hold.
- Phase 5: one atomic claimant; concurrent batch counters; stale leases reconcile; throttles delay; lost responses become ambiguous.
- Phase 6: local ETags; dead-letter replay; ambiguous read-only recovery; scope/uninstall safety.
- Phase 7: redaction, correlation, safe queue projection, and an end-to-end mocked pipeline.

When reading a test, identify:

1. initial database state;
2. injected failure/race;
3. function under test;
4. expected state and prohibited side effect;
5. what production risk the test represents.

## Suggested study commands

With PostgreSQL and Redis running and environment configured:

```text
npm run prisma:generate
npm run migrate:deploy
npm run check
npm test
npm run build
```

For learning, run one file at a time through Vitest, then temporarily add a breakpoint or safe ID-only log locally. Do not weaken assertions merely to make a test green.

## Incident drills

### “An import says queued forever”

Check in this order:

1. `OrderIntent.status`, `nextAttemptAt`, `processingStartedAt`, last error category;
2. corresponding `OutboxEvent.publishedAt`, attempt count, publish error;
3. worker/dispatcher liveness and correlated logs;
4. BullMQ job state and attempts;
5. shop install/scope status;
6. Redis and PostgreSQL readiness;
7. whether a live/expired lease explains the wait.

### “Merchant fears a duplicate Shopify order”

Check:

1. local `shopifyOrderGid` and status;
2. source identifier;
3. whether the last state is `AMBIGUOUS_RESULT`;
4. reconciliation attempts/results;
5. do not manually issue another create until ambiguity is resolved.

### “Catalog mapping looks wrong”

Check:

1. cache freshness/status and latest `CatalogSyncRun`;
2. active variants for normalized SKU;
3. duplicate SKU candidates;
4. explicit source-system `SkuMapping`;
5. product webhook receipt and refresh event;
6. run/observe full reconciliation if drift is suspected.

## Final end-to-end whiteboard

Without looking at code, explain this sequence:

1. Shopify-authenticated merchant uploads CSV with idempotency key.
2. Parser validates limits and builds canonical order hashes.
3. Transaction creates/reuses intents and resolves lines from local catalog.
4. Merchant fixes mappings and confirms.
5. Transaction changes ready intents to queued and writes outbox rows.
6. Dispatcher publishes minimal deterministic jobs.
7. Worker reloads state, capability-checks, rate-reserves, and atomically claims.
8. Shopify mutation is classified.
9. Success, retry, permanent failure, or ambiguity is persisted.
10. Ambiguity uses read-only source-identifier reconciliation.
11. Batch counters/version update; local UI polling observes progress.

## Project tradeoffs to state honestly

- It offers effectively-once safeguards, not mathematical exactly-once Shopify creation.
- Redis loss delays transport but PostgreSQL preserves business intent.
- A basic polling outbox favors simplicity; high scale may need stronger claiming/partitioning.
- The catalog is eventually consistent; full reconciliation repairs webhook drift.
- Business dead-letter handling is explicit, but BullMQ exhaustion is not automatically converted into a `DeadLetterRecord`.
- Automated tests mock Shopify; real OAuth/browser and production network behavior still need separate verification.
- Current scope excludes payment capture, fulfillment, inventory reservation, and automated PII-retention purge.

## Final defense questions

1. Why PostgreSQL plus Redis instead of only one of them?
2. Walk through every idempotency layer and what failure it covers.
3. Show where concurrency is controlled at queue, database, and Shopify-rate levels.
4. Explain safe retry versus ambiguous write using one example of each.
5. Explain the difference between mapping ambiguity and write ambiguity.
6. Explain dead-letter creation and replay in exact code terms.
7. How does uninstall stop work already sitting in Redis?
8. How can a catalog sync resume after a crash without corrupting deletions?
9. What sensitive data is excluded from Redis and logs?
10. Name one limitation you would improve next and the tradeoff involved.

## Two-minute project explanation

“OrderRelay imports external CSV orders into Shopify through a durable, asynchronous pipeline. The web process authenticates the merchant, validates and canonicalizes the file, and stores tenant-scoped batches, durable order identities, lines, and mappings in PostgreSQL. Confirmation changes eligible intents and inserts outbox events atomically. A separate worker publishes those events to deterministic BullMQ jobs, reloads authoritative state, claims work conditionally, checks current shop capabilities, and coordinates Shopify cost limits per shop in Redis. Clear transient failures are delayed, permanent failures create local dead-letter history, and uncertain writes enter read-only reconciliation by a deterministic source identifier. Product webhooks update a local catalog cache, while scheduled full reconciliation repairs drift. The design provides effectively-once business behavior under at-least-once delivery and keeps progress, recovery, and audit state in PostgreSQL.”

