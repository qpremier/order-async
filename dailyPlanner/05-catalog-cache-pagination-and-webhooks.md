# Day 5 — Catalog Cache, Pagination, and Product Webhooks

## Goal

Understand why the app copies Shopify variant data locally, how a full sync resumes, and how webhooks keep the cache current.

## Read in this order

1. [`app/services/catalog/catalog-cache.server.js`](../app/services/catalog/catalog-cache.server.js).
2. [`app/services/catalog/catalog-sync-request.server.js`](../app/services/catalog/catalog-sync-request.server.js).
3. [`worker/processors/catalog.processor.js`](../worker/processors/catalog.processor.js).
4. [`app/services/catalog/catalog-sync.server.js`](../app/services/catalog/catalog-sync.server.js).
5. [`app/services/catalog/product-webhooks.server.js`](../app/services/catalog/product-webhooks.server.js).
6. Product create/update/delete route modules.
7. [`worker/catalog-reconciliation-scheduler.js`](../worker/catalog-reconciliation-scheduler.js).
8. [`tests/phase3-catalog-sync.test.js`](../tests/phase3-catalog-sync.test.js).

## Why cache Shopify variants?

The import preview and SKU search need predictable local reads. Querying Shopify for every CSV line would be slow, rate-limited, difficult to search, and coupled to network availability. `CatalogVariant` is therefore a local read model optimized by `(shopId, normalizedSku)`.

This cache is not the authoritative Shopify catalog. Its freshness fields make that limitation explicit.

## Full sync flow

```text
merchant/scheduler
  -> CatalogSyncRun + catalog.bootstrap OutboxEvent
  -> catalog-sync BullMQ job
  -> productVariants(first, after)
  -> upsert page in PostgreSQL
  -> save lastProcessedCursor
  -> repeat
  -> mark unseen variants deleted only after successful completion
```

`CatalogSyncRun.lastProcessedCursor` is a durable checkpoint. If the worker crashes after a committed page, a retry resumes after that cursor rather than starting from page one.

The sync uses Shopify’s connection cursor for the remote API. The UI’s local lists use the project’s own opaque keyset cursor. Those are two separate pagination systems.

## Safe deletion strategy

During a successful full run, each seen variant receives the current sync run ID. Only after the entire traversal succeeds can older unseen variants be soft-deleted with `deletedAt`.

Why wait? If page 3 fails and the app immediately deletes “not yet seen” rows, it would corrupt a previously good cache. A failed sync keeps earlier cache data and marks freshness/status as failed or stale.

## Targeted product webhook flow

For `products/create`, `products/update`, or `products/delete`:

1. route authenticates the Shopify webhook;
2. `ingestProductWebhook()` normalizes topic and product GID;
3. a unique `(shopId, webhookId)` receipt is inserted;
4. a minimal `catalog.refresh-product` outbox event is inserted atomically;
5. duplicate receipt constraint means duplicate delivery is a no-op;
6. worker reloads trusted shop state and refreshes or soft-deletes that product’s variants;
7. receipt is marked processed.

The queue payload is projected through an allowlist before entering Redis, so unrelated webhook fields do not leak into transport storage.

## Webhooks are not a complete synchronization guarantee

Deliveries can be delayed or missed, and code can fail. `CatalogReconciliationScheduler` periodically asks PostgreSQL for active shops whose cache is stale, failed, missing, or never synced, then creates durable sync work. Full reconciliation repairs drift that targeted webhooks did not.

## Local keyset pagination

Read [`app/services/pagination/cursor.server.js`](../app/services/pagination/cursor.server.js).

The cursor encodes `(createdAt, id)` and the query orders by those same values. Fetching `first + 1` rows reveals `hasNextPage`. This avoids the increasing cost and shifting-page problems of large `OFFSET` values.

For descending order, the next page means records where:

```text
createdAt < cursor.createdAt
OR (createdAt == cursor.createdAt AND id < cursor.id)
```

The `id` tie-breaker prevents duplicates/skips when multiple rows share a timestamp.

## Exercise: crash points

For a full sync, predict recovery if the worker crashes:

- before a page is fetched;
- after Shopify returns a page but before the DB transaction commits;
- after the page commits but before the next fetch;
- after the final page but before marking unseen variants deleted.

Use the test “resumes an interrupted catalog sync from the saved checkpoint” to verify your reasoning.

## Defend-it questions

1. Why is catalog search local instead of live against Shopify?
2. Why is `lastProcessedCursor` stored in PostgreSQL?
3. Why are unseen variants deleted only after a successful full run?
4. How are duplicate webhook deliveries handled?
5. Why are webhooks combined with scheduled reconciliation?

