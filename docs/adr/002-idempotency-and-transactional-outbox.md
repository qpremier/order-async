# ADR 002: Idempotency And Transactional Outbox

## Status

Accepted. Phase 1 added schema foundation for idempotent imports, order intents, webhook receipts, dead-letter records, and outbox events. Outbox dispatching and queue publication remain Phase 2 work.

## Context

OrderRelay must handle duplicate uploads, retries, duplicate queue delivery, Shopify throttling, worker crashes, and ambiguous network outcomes without creating duplicate Shopify orders when avoidable. BullMQ can deduplicate some jobs, but Redis is not the durable business source of truth and queue delivery must be treated as at-least-once.

## Decision

Use database-backed idempotency and a transactional outbox.

- `ImportBatch` will have a unique `(shopId, idempotencyKey)`.
- `OrderIntent` will have a unique `(shopId, sourceSystem, externalOrderId)`.
- Order payloads will be normalized and hashed so the same external order with different content can be detected as a conflict.
- Shopify order creation will use a deterministic source identifier.
- State changes will go through domain functions and atomic conditional updates.
- HTTP actions and webhook routes will write business records and `OutboxEvent` rows in the same database transaction.
- An outbox dispatcher will publish events to BullMQ with deterministic job IDs and mark rows published only after publication succeeds.
- Workers will reload state from PostgreSQL, no-op terminal records, and reconcile ambiguous write outcomes before retrying creates.

## Consequences

Positive:

- Database commits remain durable even if Redis is temporarily unavailable.
- Duplicate HTTP submissions and duplicate jobs become harmless in the common cases.
- Worker restarts can resume from durable state.
- Dead-letter and replay workflows preserve the original business identity.

Tradeoffs:

- More tables and domain code than direct queue publication.
- Dispatcher logic needs tests for duplicate publication and Redis recovery.
- Ambiguous Shopify write results require reconciliation logic and merchant-safe status handling.

## Explicit Non-Claim

The system should not claim mathematically guaranteed exactly-once processing. The goal is effectively-once business behavior through durable idempotency records, deterministic identifiers, guarded transitions, retries, and reconciliation.
