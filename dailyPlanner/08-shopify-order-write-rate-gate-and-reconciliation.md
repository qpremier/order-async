# Day 8 — Shopify Order Writes, Rate Gates, and Ambiguous Results

## Goal

Be able to defend the hardest correctness claim in the project: effectively-once business behavior on top of at-least-once job delivery.

## Read in this order

1. [`app/services/orders/order-create.server.js`](../app/services/orders/order-create.server.js).
2. [`app/services/shopify/shopify-rate-gate.server.js`](../app/services/shopify/shopify-rate-gate.server.js).
3. `processOrderCreate()` again in [`worker/processors/order.processor.js`](../worker/processors/order.processor.js).
4. [`app/services/orders/order-reconcile.server.js`](../app/services/orders/order-reconcile.server.js).
5. `processOrderReconciliation()` in the processor.
6. Reconciliation and rate-gate tests in [`tests/phase5-order-pipeline.test.js`](../tests/phase5-order-pipeline.test.js).

Shopify’s Admin GraphQL response includes calculated cost and throttle status. This app observes `maximumAvailable`, `currentlyAvailable`, and `restoreRate`, then coordinates workers per shop through Redis.

## Building the order mutation input

`buildOrderCreateInput()` maps durable intent state into Shopify input:

- email, currency, processed time, note, and optional shipping address;
- deterministic `sourceIdentifier`;
- tags identifying the app/source;
- line items with resolved variant GIDs, quantity, and imported decimal unit price;
- no payment transactions and no artificial captured state.

Before calling Shopify, `createShopifyOrder()` rejects missing source identifier, missing lines, or unresolved variant GIDs as internal invariant failures.

The response is parsed with Zod rather than assumed to be valid. GraphQL HTTP `200` does not imply business success; top-level `errors` and mutation `userErrors` are separately classified.

## Result classification

- conclusive order with `id` and `name` -> `succeeded`;
- Shopify user error -> `permanent-error`;
- access denied -> missing-scope handling;
- GraphQL/resource throttle -> `retry`;
- internal server response, thrown network error after dispatch, malformed/missing response -> `ambiguous`.

Why classify a network exception as ambiguous? The request may have reached Shopify and created the order even though the response never reached the worker.

## Deterministic source identity

`buildOrderSourceIdentifier()` hashes the external order ID and combines it with the normalized source system. The database has a unique `(shopId, sourceIdentifier)` constraint.

This identifier is:

- stable across replay/reconciliation;
- non-PII compared with putting the raw external order ID everywhere;
- searchable from Shopify for read-only reconciliation.

It is a reconciliation key, not a promise that Shopify will reject every duplicate create automatically. Database claims and cautious recovery remain necessary.

## Two rate limits are modeled

### GraphQL cost budget

The Redis Lua reservation script atomically:

1. loads last known maximum, available points, restore rate, and observation time;
2. restores points based on elapsed time;
3. pads estimated cost by the safety margin;
4. reserves headroom for order work when the caller is background catalog work;
5. either deducts estimated cost or returns a calculated wait.

After a response, `withShopifyRateGate()` extracts actual throttle metadata and overwrites the estimate with Shopify’s observed state.

Lua is used so concurrent worker processes cannot read the same budget and both overspend it.

### Order-create resource window

The app also detects Shopify’s “too many attempts, try later” user error. Once observed, it activates a shared rolling-window guard of five order creates per minute for that shop. Redis sorted-set reservations coordinate all workers. Before the limit has ever been observed, the gate allows creates rather than applying this conservative cap universally.

## Ambiguous-write sequence

```text
worker sends orderCreate
        |
        +-- clear success ----------> SUCCEEDED
        +-- clear permanent error --> DEAD_LETTER
        +-- safe transient ---------> RETRY_WAIT
        +-- outcome uncertain ------> AMBIGUOUS_RESULT
                                         |
                                         v
                         delayed read by source_identifier
                            |          |           |
                         1 match     0 match     >1 matches
                            |          |           |
                        SUCCEEDED   bounded retry   merchant review
```

Reconciliation requests at most two nodes so it can distinguish zero, exactly one, and more than one match without loading a large result set.

`reconciliationAttemptCount` is bounded by `ORDER_RECONCILIATION_MAX_ATTEMPTS`. After repeated zero matches, or immediately on multiple matches, the intent remains `AMBIGUOUS_RESULT`, clears automatic scheduling, and appears in Needs Attention. It is not blindly recreated.

## “Effectively once,” stated honestly

The project does not promise mathematical exactly-once execution across PostgreSQL, Redis, the network, and Shopify. It combines:

- unique durable order identity;
- transactional outbox;
- deterministic queue job IDs;
- atomic database claims;
- processing leases;
- deterministic Shopify source identifiers;
- read-only reconciliation after uncertain writes.

Together these prevent ordinary duplicate paths and prefer human review over unsafe re-creation when proof is impossible.

## Exercise: the lost response

Explain every step when Shopify creates order `#1005`, but the TCP connection drops before the response reaches the worker. Your answer must include:

1. ambiguous classification;
2. database transition and reconciliation outbox event;
3. delayed job;
4. exact source-identifier search;
5. one result becoming local `SUCCEEDED` without another mutation.

## Defend-it questions

1. Why is an internal-server or malformed mutation response not safely retryable?
2. How does the rate gate coordinate multiple processes?
3. Why do catalog requests preserve headroom for order requests?
4. What happens after bounded reconciliation finds zero orders?
5. Why does the project say “effectively once” instead of “exactly once”?

