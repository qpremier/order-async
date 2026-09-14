# OrderRelay Usage Guide

OrderRelay is an embedded Shopify Admin app for importing external orders from CSV files into Shopify. It is designed for merchants or operators who receive orders from another system, such as an ERP, marketplace, wholesale portal, or custom sales channel, and need to create matching Shopify orders without losing track of progress or accidentally creating duplicates.

The app focuses on one job: reliable external order ingestion. It validates uploaded orders, matches line-item SKUs to Shopify variants, lets the user resolve missing or ambiguous mappings, queues eligible orders, and creates Shopify orders asynchronously through a worker process.

## What The App Does

- Imports external orders from CSV files.
- Validates file structure, required fields, timestamps, email addresses, currencies, quantities, prices, and order consistency.
- Groups CSV rows into orders by `external_order_id`.
- Uses a local Shopify catalog cache to match imported SKUs to Shopify product variants.
- Lets users explicitly map external SKUs when a SKU is missing from the catalog cache or matches multiple variants.
- Prevents duplicate business order creation by preserving one durable order identity per shop, source system, and external order ID.
- Detects when a repeated external order has changed content and rejects it as a conflict instead of overwriting the existing order intent.
- Queues Shopify order creation after the user confirms an import.
- Shows local progress while orders are being created.
- Links successfully created orders back to Shopify Admin.
- Shows orders that need manual attention, including mapping problems, permanent failures, and ambiguous Shopify write results.
- Allows safe replay of dead-lettered failures.
- Allows read-only Shopify rechecks for ambiguous writes.
- Tracks catalog freshness and supports manual catalog sync.

## Main User Screens

### Home

The Home page is the OrderRelay dashboard.

Users can:

- Start a new external order import.
- Run `Sync catalog` to refresh the local Shopify variant cache.
- See catalog cache status.
- See when the catalog was last synced.
- See whether a sync is currently running.
- See active cached variant count.
- See ambiguous SKU count.
- Browse cached variants with cursor-based pagination.
- See recent imports with status and summary counts.

Catalog statuses shown by the app include:

- `NEVER_SYNCED`
- `SYNCING`
- `FRESH`
- `STALE`
- `FAILED`

### New Import

The New Import page lets the user upload external orders.

Users provide:

- A source system name, such as `demo-erp`, `netsuite`, `amazon`, or another stable identifier.
- A CSV file containing external order rows.

The app stores normalized order data, not the raw uploaded CSV file.

### Import Details

The Import Details page shows the preview and processing state for a specific uploaded batch.

Users can:

- Review total, ready, queued, processing, succeeded, failed, and needs-attention order counts.
- Search cached catalog variants.
- Resolve missing or ambiguous SKU mappings.
- Confirm all ready orders.
- View each external order in the batch.
- See whether an order reused an existing durable intent.
- Open successful Shopify orders from embedded Admin links.
- Continue through paginated order results.

The app polls local status data while an import is active. Polling slows down when nothing changes, pauses when the browser tab is hidden, and stops when the batch reaches a terminal state.

### Needs Attention

The Needs Attention page lists orders that require a user decision or manual recovery.

Users can:

- View mapping failures.
- View permanent order creation failures with safe error details.
- Replay dead-lettered work safely.
- Recheck Shopify for ambiguous write results.
- Open the related import batch.

Ambiguous Shopify writes cannot be blindly recreated from this screen. They can only be checked through read-only reconciliation.

## CSV File Specification

Each CSV must include a header row and at least one data row.

Required columns:

```text
external_order_id,processed_at,email,currency,sku,quantity,unit_price
```

Optional columns:

```text
shipping_first_name
shipping_last_name
shipping_address1
shipping_address2
shipping_city
shipping_province
shipping_province_code
shipping_country_code
shipping_zip
shipping_phone
note
```

Rules:

- Headers must not be duplicated.
- Unknown columns are rejected.
- Empty files are rejected.
- `external_order_id` is required and can be up to 128 characters.
- `processed_at` must be an ISO 8601 timestamp with a timezone.
- `email` must be a valid email address and can be up to 320 characters.
- `currency` must be a three-letter currency code such as `USD`.
- `sku` is required and can be up to 255 characters.
- `quantity` must be a positive whole number no greater than `1,000,000`.
- `unit_price` must be a non-negative decimal with at most two decimal places.
- `shipping_country_code` must be a two-letter country code when provided.
- `note` can be up to 5,000 characters.
- Rows with the same `external_order_id` become one Shopify order.
- Rows for the same order must have consistent order-level fields, including email, currency, processed time, shipping fields, and note.

Default import limits:

- Maximum file size: `5 MB`
- Maximum rows: `10,000`
- Maximum validation issues returned at once: `50`

These limits can be changed through environment configuration.

## SKU Matching And Mapping

Before imports can be confirmed, OrderRelay needs a local catalog cache.

The catalog cache stores Shopify variants with:

- Shopify variant ID
- Shopify product ID
- SKU
- Normalized SKU
- Product title
- Variant title
- Price
- Currency
- Product status
- Shopify update time
- Cache time

When a CSV is uploaded:

- If an imported SKU matches exactly one active cached variant, the line is valid.
- If an imported SKU has no active cached match, the affected order needs mapping.
- If an imported SKU matches multiple active variants, the affected order needs an explicit selection.
- Saved mappings are scoped to the current shop and source system.
- Mapping choices must point to active variants in the same shop.

## Import And Order Statuses

Import batch statuses:

- `DRAFT`
- `VALIDATING`
- `READY`
- `QUEUED`
- `PROCESSING`
- `PARTIALLY_COMPLETED`
- `COMPLETED`
- `FAILED`
- `CANCELLED`

Order statuses:

- `DRAFT`
- `VALIDATING`
- `NEEDS_MAPPING`
- `AMBIGUOUS_MAPPING`
- `INVALID`
- `READY`
- `QUEUED`
- `PROCESSING`
- `RETRY_WAIT`
- `AMBIGUOUS_RESULT`
- `SUCCEEDED`
- `DEAD_LETTER`
- `CANCELLED`

Line validation statuses:

- `UNVALIDATED`
- `VALID`
- `NEEDS_MAPPING`
- `AMBIGUOUS_MAPPING`
- `INVALID`

## Order Creation Behavior

Confirming an import does not create Shopify orders inside the browser request. Instead, OrderRelay:

1. Finds eligible ready orders.
2. Assigns deterministic Shopify source identifiers.
3. Marks those order intents as queued.
4. Writes durable outbox events in PostgreSQL.
5. Lets a worker publish jobs to Redis/BullMQ.
6. Lets order workers create Shopify orders through Shopify Admin GraphQL.
7. Updates local progress as each order succeeds, retries, fails, or needs attention.

Created Shopify orders use:

- Resolved Shopify variant IDs.
- Imported quantities.
- Imported decimal unit prices.
- Imported customer email.
- Optional imported shipping fields.
- Optional imported note.
- A deterministic non-PII source identifier.

The app does not create payment transactions, capture payment, fulfill orders, or run inventory synchronization.

## Duplicate Protection

OrderRelay is designed for effectively-once business behavior under at-least-once queue delivery.

User-facing duplicate protections include:

- Duplicate upload submissions with the same idempotency key return the original batch.
- One external order identity is preserved per shop, source system, and external order ID.
- Re-uploading the same external order with the same normalized payload reuses the existing order intent.
- Re-uploading the same external order with changed content is rejected as a conflict.
- Queue jobs use deterministic IDs.
- Workers re-read PostgreSQL before acting.
- Already completed orders are ignored on duplicate delivery.
- Ambiguous Shopify writes go to reconciliation instead of blind retry.

The app does not claim mathematically guaranteed exactly-once processing. If Shopify completes a mutation and the response is irretrievably lost, OrderRelay uses deterministic source identifiers and read-only reconciliation to reduce duplicate risk.

## Error And Recovery Behavior

The app classifies failures into merchant-safe categories:

- `VALIDATION`
- `MISSING_MAPPING`
- `AMBIGUOUS_MAPPING`
- `SHOPIFY_USER_ERROR`
- `AUTHENTICATION`
- `MISSING_SCOPE`
- `SHOP_UNINSTALLED`
- `THROTTLED`
- `NETWORK_TRANSIENT`
- `SHOPIFY_SERVER_TRANSIENT`
- `AMBIGUOUS_WRITE_RESULT`
- `INTERNAL_BUG`
- `UNKNOWN`

Permanent failures create dead-letter history and appear in Needs Attention. Replay keeps the same order intent and source identifier, checks current shop permissions and variant mappings, records who initiated the replay, and queues new work.

Throttled work is delayed and retried. Missing `write_orders` pauses order creation without exhausting attempts. Uninstalled shops are blocked from further Shopify API calls.

## Shopify Permissions And Webhooks

Minimum Shopify scopes used by the app:

- `read_products`
- `read_orders`
- `write_orders`

The app uses Shopify webhooks for:

- Product create
- Product update
- Product delete
- App uninstall
- App scopes update

Webhook requests are authenticated, deduplicated, stored as receipts, and processed asynchronously when work is needed.

## Operational Specifications

Runtime components:

- React Router embedded Shopify web app
- PostgreSQL database
- Redis
- BullMQ queues
- Separate worker process
- Prisma ORM
- Shopify Admin GraphQL

Queues:

- `order-write`
- `catalog-sync`
- `maintenance`

Health endpoints:

- `GET /health` checks web process liveness.
- `GET /ready` checks required environment, PostgreSQL connectivity, and Redis connectivity.

Logging:

- Logs are structured JSON.
- Logs include operational IDs such as correlation ID, shop ID, import batch ID, order intent ID, outbox event ID, queue name, and job ID.
- Logs redact sensitive fields and sensitive-looking text.
- Queue payloads are reduced to minimal operational data before being written to Redis.

## Configuration Defaults

Important environment-backed defaults include:

- Order worker concurrency: `5`
- Catalog worker concurrency: `2`
- Catalog sync page size: `100`
- Catalog stale-after time: `60` minutes
- Import max bytes: `5 MB`
- Import max rows: `10,000`
- Job max attempts: `5`
- Outbox poll interval: `2,000 ms`
- Outbox batch size: `50`
- Order reconciliation delay: `5,000 ms`
- Order reconciliation max attempts: `3`
- Order processing lease: `5 minutes`

## What The App Does Not Do

OrderRelay does not currently provide:

- Inventory synchronization.
- Fulfillment creation.
- Payment capture.
- Payment transaction import.
- Discounts.
- Tax calculation workflows.
- Refunds.
- Returns.
- Order editing.
- Product creation.
- A direct connector to a specific external system.
- Automated retention or purge of normalized customer order data.
- A separate authenticated worker-health HTTP endpoint.
- Automated browser testing through live Shopify OAuth.
- Deployment automation.

## Sample Files

The repository includes sample CSV files:

- `examples/orders-valid.csv`
- `examples/orders-missing-sku.csv`
- `examples/orders-invalid.csv`
- `examples/orders-duplicate-external-id.csv`

Use these to test valid imports, missing SKU mapping, validation errors, and duplicate external order conflict protection.
