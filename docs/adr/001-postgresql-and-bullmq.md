# ADR 001: PostgreSQL And BullMQ

## Status

Accepted. PostgreSQL foundation and Redis Compose configuration were implemented in Phase 1. BullMQ queues and the separate worker process were implemented in Phase 2.

## Context

The current app uses the Shopify React Router template with Prisma and SQLite. SQLite is adequate for a single local template process, but OrderRelay needs durable multi-record state transitions, concurrent workers, retries, progress queries, catalog cache reads, webhook dedupe, and dead-letter records.

Order creation and catalog synchronization must not run as long synchronous HTTP requests. The app needs a queue so web requests can commit durable intent quickly while workers process Shopify API calls with retries and rate control.

## Decision

Use PostgreSQL as the durable source of truth and Redis/BullMQ for job transport and coordination.

- PostgreSQL will store Shopify sessions, shops, catalog cache records, import batches, order intents, order lines, outbox events, webhook receipts, and dead-letter records.
- Prisma remains the ORM.
- Redis will back BullMQ queues for order writes, catalog sync, maintenance, and reconciliation.
- A separate worker process will process jobs and update PostgreSQL.
- Docker Compose will provide local PostgreSQL and Redis services.

## Consequences

Positive:

- Stronger transactional behavior for idempotency and state transitions.
- Better fit for multiple web/worker processes.
- Durable progress reporting from local data.
- Operationally familiar stack for a production-style portfolio project.

Tradeoffs:

- Local setup becomes more complex than SQLite.
- CI and deployment need PostgreSQL and Redis services.
- Phase 1 must replace the SQLite migration baseline with checked-in PostgreSQL migrations.
- Startup must avoid multiple replicas racing to run migrations.

## Alternatives Considered

SQLite plus in-process jobs:

- Rejected because it does not fit multi-process workers, durable retries, or production-style concurrency.

Direct BullMQ jobs from HTTP routes without PostgreSQL outbox:

- Rejected because a Redis outage after database commit could lose work.

One process running web and workers together:

- Rejected for production architecture, although a local development convenience command may still be useful later.
