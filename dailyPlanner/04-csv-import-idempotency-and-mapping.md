# Day 4 — CSV Parsing, Idempotency, and SKU Mapping

## Goal

Understand how untrusted CSV bytes become stable, deduplicated order intent without storing the raw upload.

## Read in this order

1. [`examples/orders-valid.csv`](../examples/orders-valid.csv) and the three failure examples.
2. [`app/services/imports/import-parser.server.js`](../app/services/imports/import-parser.server.js).
3. [`tests/phase4-import-parser.test.js`](../tests/phase4-import-parser.test.js).
4. [`app/services/imports/import-domain.server.js`](../app/services/imports/import-domain.server.js).
5. [`app/services/imports/sku-mapping.server.js`](../app/services/imports/sku-mapping.server.js).
6. [`tests/phase4-import-domain.test.js`](../tests/phase4-import-domain.test.js).

## Parser pipeline

`parseImportCsv(file, limits)` does more than split commas:

1. rejects a file larger than `IMPORT_MAX_BYTES`;
2. streams through `csv-parse`;
3. validates required headers;
4. enforces `IMPORT_MAX_ROWS`;
5. normalizes and validates fields;
6. groups rows by `external_order_id`;
7. checks that order-level fields agree across every line;
8. sorts normalized lines deterministically;
9. hashes the canonical order payload.

Deterministic sorting matters. If the same line items appear in a different CSV row order, the canonical payload should still represent the same business order.

Validation errors are bounded, field-oriented messages. Raw rows, email-rich dumps, and file contents are not logged or placed in Redis.

## Two layers of idempotency

### Request idempotency

`ImportBatch` has unique `(shopId, idempotencyKey)`. A browser-generated UUID identifies one upload submission. Repeating or concurrently submitting the same key returns the original batch.

### Business idempotency

`OrderIntent` has unique `(shopId, sourceSystem, externalOrderId)`.

- Same identity + same `payloadHash`: reuse the existing intent via `ImportBatchOrderIntent`.
- Same identity + different hash: throw `ExternalOrderConflictError`.

The app never silently overwrites an already-known external order with changed customer, price, or line content.

## Why `ImportBatchOrderIntent` exists

Without the link table, an order intent could belong to only its original upload. With it, a later identical upload can show the reused order in that batch while preserving a single business identity and a single Shopify result.

`OrderIntent.importBatchId` still records the originating batch; the join table records all appearances.

## SKU resolution precedence

Read `loadSkuResolution()`, `resolveLine()`, and `resolveSku()` together. The effective idea is:

1. prefer an explicit `SkuMapping` for this shop + source system + normalized external SKU;
2. otherwise examine active cached variants with matching normalized SKU;
3. one candidate means `VALID`;
4. zero candidates means `NEEDS_MAPPING`;
5. multiple candidates mean `AMBIGUOUS_MAPPING`.

Mapping is source-system-specific because two external systems can use the same textual SKU differently.

`applySkuMapping()` verifies that the selected variant is active and belongs to the same shop, upserts the remembered mapping, updates affected lines, and recalculates affected intent/batch states transactionally.

## Important distinction: mapping ambiguity vs write ambiguity

- `AMBIGUOUS_MAPPING`: before Shopify creation, multiple local variants match a SKU. Merchant selection can resolve it.
- `AMBIGUOUS_RESULT`: after an attempted Shopify write, the app cannot prove whether an order was created. Only read-only reconciliation can resolve it safely.

These states must never share a recovery button.

## Exercise: follow `ERP-1001`

Using `examples/orders-valid.csv`:

1. identify every row with `ERP-1001`;
2. list its order-level fields and line-level fields;
3. explain how those rows become one `OrderIntent` plus multiple `OrderLine` rows;
4. explain what changes if line order is reversed;
5. then inspect `orders-duplicate-external-id.csv` and explain why it conflicts after the first import.

## Exercise: failure matrix

Predict the result before running tests:

| Situation | Expected result |
|---|---|
| Missing required column | Import validation error; no batch |
| Too many rows | `ImportLimitError`; no batch |
| Duplicate submission key | Original batch returned |
| Same external order, same canonical hash | Existing intent linked as reused |
| Same external order, changed hash | Conflict; existing intent unchanged |
| No cached SKU | `NEEDS_MAPPING` |
| Two active variants with SKU | `AMBIGUOUS_MAPPING` |

## Defend-it questions

1. Why does the parser canonicalize and hash orders?
2. What is the difference between idempotency key and external order identity?
3. Why is raw CSV not persisted?
4. Why must mapping validate `shopId` and `deletedAt`?
5. How can a later upload show an order without creating a second `OrderIntent`?

