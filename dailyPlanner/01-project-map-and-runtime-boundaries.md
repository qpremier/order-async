# Day 1 — Build the Project Map

## Goal

By the end of today, you should be able to explain which process owns each responsibility and where to begin tracing any merchant action.

Do not begin by reading every file. First learn the boundaries:

```text
Browser / Shopify Admin
        |
        v
React Router web process ----> PostgreSQL
        |                         ^
        | creates OutboxEvent     |
        v                         |
worker dispatcher -> Redis/BullMQ -> queue workers -> Shopify Admin GraphQL
```

The most important architectural sentence is: **PostgreSQL owns business truth; Redis transports work.** If Redis is emptied, durable imports and order state still exist. If PostgreSQL is lost, Redis cannot reconstruct the business state.

## Read in this order

1. [`README.md`](../README.md) — current behavior and terminology.
2. [`package.json`](../package.json) — scripts, runtime versions, and dependencies.
3. [`docker-compose.yml`](../docker-compose.yml) — process and network topology.
4. [`app/routes.js`](../app/routes.js) and the names under `app/routes/` — filesystem routing.
5. [`app/shopify.server.js`](../app/shopify.server.js) — Shopify app/auth configuration.
6. [`app/db.server.js`](../app/db.server.js) — Prisma client lifetime.
7. [`worker/index.js`](../worker/index.js) — worker composition root.
8. [`docs/architecture.md`](../docs/architecture.md) — use the “Current Architecture” section after reading the code above.

## What the top-level folders mean

| Path | Responsibility |
|---|---|
| `app/routes/` | HTTP boundary: loaders read, actions mutate, webhook routes ingest events. |
| `app/services/` | Domain and infrastructure logic kept outside UI routes. |
| `app/queues/` | Queue names, event-to-job routing, Redis connection, and queue defaults. |
| `worker/` | Separate long-running process: dispatcher, schedulers, and processors. |
| `prisma/` | Database schema and ordered migrations. |
| `tests/` | Executable documentation organized by implementation phase. |
| `examples/` | CSV fixtures that exercise real parser behavior. |
| `docs/` | Architecture decisions, operations, and interview explanations. |

## Two processes, one codebase

The web and worker use the same service modules but start differently.

### Web process

`npm run dev` runs Shopify CLI and the React Router application. The web process:

- authenticates embedded requests;
- parses CSV uploads;
- writes imports, mappings, and outbox rows;
- serves local status and catalog data;
- authenticates and acknowledges webhooks quickly.

It should not create many Shopify orders inside an HTTP request.

### Worker process

`npm run worker:dev` runs `worker/index.js`. `main()` creates:

- one registry containing three BullMQ queues;
- a Redis-backed Shopify rate gate;
- three BullMQ workers;
- an outbox polling dispatcher;
- a catalog reconciliation scheduler;
- graceful `SIGTERM` and `SIGINT` shutdown.

This is called a **composition root**: it constructs dependencies and wires modules together, but business rules live elsewhere.

## Follow one merchant action

Trace “Confirm import” without reading implementation details yet:

1. UI and action: `app/routes/app.imports.$batchId.jsx`.
2. Domain command: `confirmImportBatch()` in `app/services/orders/order-state.server.js`.
3. Durable event: `createOutboxEvent()` in `app/services/outbox/outbox.server.js`.
4. Event routing: `describeOutboxJob()` in `app/queues/jobs.js`.
5. Publication: `OutboxDispatcher` in `app/services/outbox/dispatcher.server.js`.
6. Worker selection: `createQueueWorkers()` in `worker/queue-workers.js`.
7. Processor: `processOrderJob()` in `worker/processors/order.processor.js`.
8. Shopify adapter: `createShopifyOrder()` in `app/services/orders/order-create.server.js`.
9. Final database transition: `markOrderIntentSucceeded()` in `order-state.server.js`.

Write this chain from memory. It is the backbone of the project.

## Exercise

For each component below, label it `durable state`, `temporary coordination`, or `external system`:

- `OrderIntent`
- a BullMQ job
- `OutboxEvent`
- Redis rate-budget hash
- Shopify order
- `DeadLetterRecord`

Expected answer: `OrderIntent`, `OutboxEvent`, and `DeadLetterRecord` are durable local state; BullMQ jobs and rate-budget hashes are temporary coordination; the Shopify order is external state.

## Defend-it questions

1. Why is the worker a separate process from the web server?
2. What is lost if Redis restarts? What is not lost?
3. Why does confirming a batch write an outbox row rather than call Shopify immediately?
4. Where would you start tracing an unfamiliar merchant button?
5. Which file is the worker’s composition root?

## One-minute explanation

“OrderRelay is a React Router Shopify embedded app with a separate worker process. HTTP requests persist tenant-scoped business state in PostgreSQL. Asynchronous intent is written as an outbox row in the same transaction. A worker publishes that row to deterministic BullMQ jobs in Redis, reloads authoritative state from PostgreSQL, and then calls Shopify. Redis coordinates delivery and delays; it is not the permanent record.”

