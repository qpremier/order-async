# OrderRelay Interview Questions and Answers

This guide is based on the current code, database schema, migrations, tests, and project documentation. It describes what the app does now, not only what the design documents intended.

Verification date: 15 September 2026.

Verification performed:

- The full automated suite passed: 68 tests in 11 test files.
- The orderCreate mutation, order reconciliation query, and catalog variant query were validated against the Shopify Admin GraphQL schema.
- Shopify documentation confirms that a write scope includes the matching read permission. Therefore the configured scopes read_products and write_orders are enough for this app. The extra read_orders scope listed in usage.md and CI is redundant.
- Shopify CLI configuration validation still requires an authenticated Shopify CLI session, so it must be run again before deployment.

Shopify references checked:

- [Shopify API access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
- [orderCreate mutation](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/orderCreate)
- [productVariants query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/productVariants)
- [orders query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders)

Important facts that should not be overstated:

- The app provides effectively-once business behavior, not guaranteed exactly-once delivery.
- Shopify is still the source of truth for orders and products. PostgreSQL is the source of truth for the app's workflow.
- The CSV reader streams the uploaded bytes, but it still keeps the validated rows and grouped orders in memory before the database transaction.
- Raw CSV files are not saved, but normalized customer and shipping data is saved in PostgreSQL. There is no automatic retention or purge job.
- The CatalogVariant table has a currency column, but the current catalog sync does not populate it.
- Dead-letter replay verifies that existing variant mappings are still active, but the current UI does not provide a repair form for a dead-lettered order whose mapped variant was deleted.
- Automated tests mock Shopify GraphQL. Live OAuth, real-store behavior, and the embedded browser flow require manual testing.

## Product and business purpose

### 1. What problem does OrderRelay solve?

It imports orders from an external system into Shopify from a CSV file. It reduces lost work and accidental duplicate orders by validating data first, storing durable order intent, creating orders asynchronously, and tracking the result locally.

### 2. Who is the expected user?

The expected user is a Shopify merchant or operator who receives orders from an ERP, marketplace, wholesale desk, phone-sales process, or legacy system. It is not designed as a customer-facing storefront.

### 3. What is the main user journey?

The merchant syncs the Shopify catalog, uploads a CSV, reviews validation and SKU mappings, confirms the draft, follows local progress, and handles permanent or ambiguous failures in Needs Attention.

### 4. Why is this a focused app instead of a general integration platform?

The code supports one workflow: external order ingestion. It does not contain a connector framework, workflow builder, generic event bus for customers, or modules for inventory, fulfillment, refunds, and returns.

### 5. What does the app deliberately not do?

It does not capture payments, create payment transactions, fulfill orders, synchronize inventory, calculate taxes, apply discounts, process refunds or returns, edit orders, or create products. It also does not connect directly to a named ERP.

### 6. Why does the app use CSV?

CSV is a simple interchange format that many external systems can export. It also keeps the project focused on reliable ingestion rather than vendor-specific authentication and APIs.

### 7. Does uploading a file immediately create Shopify orders?

No. Uploading creates a draft in PostgreSQL. Shopify order creation starts only after the merchant resolves every blocked order and confirms the batch.

### 8. Can the user confirm only the valid orders in a mixed batch?

Not through the current UI. Valid orders remain READY while other orders need mapping, but the confirm button is shown only when the batch has no mapping or validation problems. The service also requires every linked intent to be in an allowed state.

### 9. Why is confirmation separate from upload?

It gives the merchant a chance to review grouping, prices, quantities, and mappings. It also creates a clean boundary between reversible local validation and external Shopify writes.

### 10. How does the app report reliability honestly?

It says that it aims for effectively-once behavior under at-least-once delivery. It does not claim that a remote Shopify mutation can never produce a duplicate when the final result is irretrievably ambiguous.

## Architecture and technology choices

### 11. What are the main runtime components?

There is a React Router web process, a separate TypeScript worker process, PostgreSQL, Redis, BullMQ queues, Prisma, and the Shopify Admin GraphQL API.

### 12. What is the responsibility of the web process?

It authenticates embedded requests and webhooks, renders the UI, parses uploads, reads local status, and commits business data with outbox events. It does not create batches of Shopify orders inside HTTP requests.

### 13. What is the responsibility of the worker?

It dispatches unpublished outbox events, consumes the order-write, catalog-sync, and maintenance queues, calls Shopify, and updates durable state.

### 14. Why are the web and worker processes separate?

Long-running Shopify calls and retries should not hold open browser requests. Separate processes can scale and restart independently, and a web deployment does not have to process background work.

### 15. Why is PostgreSQL the durable source of truth?

The workflow needs transactions, unique constraints, concurrent worker claims, progress queries, webhook receipts, and recovery history. PostgreSQL is better suited to those requirements than the original SQLite template database.

### 16. What is Redis used for?

Redis stores BullMQ transport state, delayed jobs, and per-shop rate-gate state. It is not the permanent record of an import or order.

### 17. Why is BullMQ used?

BullMQ provides delayed work, priorities, retry support, concurrency, and Redis-backed delivery. The application still assumes delivery can happen more than once.

### 18. Why is Prisma used?

Prisma provides the database client, transactions, generated types, migrations, and the session-storage adapter required by the Shopify template.

### 19. Why is TypeScript used mainly in backend modules?

The project kept the existing JavaScript and JSX template files while implementing substantial domain and worker logic in TypeScript. This avoids an unrelated full rewrite.

### 20. Why is React Router used on both the client and server?

It is the framework supplied by the Shopify React Router app template. Loaders and actions handle authenticated server work, while route components render the embedded interface.

### 21. What does the high-level data flow look like?

The browser writes intent to PostgreSQL. The same transaction writes an outbox event. The worker publishes that event to BullMQ, consumes the job, reloads trusted database state, calls Shopify if allowed, and writes the result back to PostgreSQL.

### 22. Why not publish directly to Redis from the HTTP action?

A database commit followed by a failed Redis call could leave valid business data with no job. The transactional outbox closes that gap by recording the work in the same database transaction.

### 23. Why not store all business state in BullMQ?

Queue retention, retries, and Redis loss should not define merchant-visible truth. PostgreSQL provides stable identities, audit history, and local progress even when Redis is unavailable.

### 24. Can more than one web or worker instance run?

The design supports multiple instances through database uniqueness, conditional updates, deterministic job IDs, and Redis rate gates. The outbox has no database claim column, so duplicate publication can happen, but downstream guards make the common duplicate paths harmless.

### 25. What is the most important architectural tradeoff?

Reliability comes with more moving parts: PostgreSQL, Redis, an outbox dispatcher, workers, leases, status transitions, and reconciliation. Operations are more complex than a synchronous Shopify mutation.

## Shopify authentication, scopes, and API use

### 26. How are embedded requests authenticated?

Protected loaders and actions call authenticate.admin. Tenant identity comes from the authenticated Shopify session, not from a shop value submitted by the browser.

### 27. How are webhook requests authenticated?

Webhook routes call authenticate.webhook before passing the verified shop, topic, webhook ID, session scope, and payload to the domain service.

### 28. How do background workers get a Shopify client?

They load the trusted shop domain from PostgreSQL and call unauthenticated.admin for that shop. This uses the stored offline session instead of a browser session.

### 29. Why are offline tokens needed?

Order creation, catalog sync, reconciliation, and webhook follow-up can run when no merchant is in the app. Shopify's orderCreate mutation is also intended to use offline authentication for this background use case.

### 30. What scopes does the checked-in app request?

The app configuration and normal runtime defaults request read_products and write_orders.

### 31. Does reconciliation also require read_orders?

The orders query requires order-read permission, but Shopify states that a write scope includes the matching read permission. Therefore write_orders also permits reading orders. Listing read_orders as an additional minimum scope is unnecessary.

### 32. How does the app represent scope state?

Shop.grantedScopes stores the current scope string. Shop.status is ACTIVE when write_orders is available, NEEDS_REAUTH when it is missing, and UNINSTALLED after uninstall.

### 33. How are capabilities checked before Shopify calls?

Workers first inspect the shop record, then wrap the Admin client with a database-backed guard. The guard reloads the shop immediately before each GraphQL request and checks both uninstall state and the required scope.

### 34. Does the capability guard eliminate every uninstall race?

No. It greatly reduces the window, but an uninstall can still race with a request that has already passed the final guard or is already in flight. No distributed system can revoke a request that Shopify is already processing.

### 35. Which Admin GraphQL operations does the app use?

It uses productVariants for full and targeted catalog reads, orderCreate to create orders, and orders with a source_identifier search to reconcile ambiguous writes.

### 36. Are those GraphQL operations valid?

Yes. The current query and mutation documents passed Shopify schema validation during this audit.

### 37. Which Shopify API version does application code use?

The server client uses the July 2026 Admin API version through ApiVersion.July26.

### 38. Why does shopify.app.toml mention webhook API version 2026-10?

The webhook payload version is configured independently from the Admin GraphQL client version. That is not automatically an error, but both versions must be checked before deployment because payloads and fields can change.

### 39. Was the full Shopify app configuration validated in this audit?

The file was inspected, but the Shopify CLI validation command required an interactive authenticated session. Run shopify app config validate --json from the app root before deployment.

### 40. What happens if the stored offline session is unavailable?

If the Admin client cannot be created, order work moves to RETRY_WAIT with an AUTHENTICATION category and a delayed retry. Credentials are not exposed to the merchant or logs.

## Database model and tenant isolation

### 41. What is a Shop record?

It is the tenant root. It stores the shop domain, capability status, granted scopes, install and uninstall dates, and catalog freshness.

### 42. What is an ImportBatch?

It represents one upload attempt. It stores the source system, sanitized file name, idempotency key, aggregate counts, status, version, and confirmation/completion times.

### 43. What is an OrderIntent?

It is the durable business identity of one external order. It stores normalized order data, the payload hash, processing state, retry metadata, Shopify identity, and reconciliation state.

### 44. What is an OrderLine?

It stores one normalized imported line with SKU, quantity, decimal unit price, selected Shopify variant, and validation status.

### 45. Why is OrderIntent separate from ImportBatch?

The same external order can appear in a later upload without creating a second business identity. ImportBatchOrderIntent links many batches to the one durable intent.

### 46. What is the purpose of importBatchId on OrderIntent if a join table also exists?

importBatchId identifies the originating batch, while ImportBatchOrderIntent represents membership in the originating and later repeated batches.

### 47. What database constraint protects batch idempotency?

ImportBatch has a unique key on shopId and idempotencyKey.

### 48. What database constraint protects external-order identity?

OrderIntent has a unique key on shopId, sourceSystem, and externalOrderId.

### 49. What protects the deterministic Shopify source identifier?

OrderIntent has a unique key on shopId and sourceIdentifier. The field is null for drafts and assigned at confirmation.

### 50. Why is sourceIdentifier unique only within a shop?

Shopify orders and app sessions are tenant-specific. The same source system and external ID can legitimately exist in two different stores.

### 51. How is cross-shop access prevented?

Loaders derive the shop from authenticate.admin, look up its internal Shop ID, and include that ID in queries. Details, mappings, replay, and status calls all require matching shop ownership.

### 52. What happens when a user guesses another batch ID?

The query includes both batch ID and the authenticated shop ID, so it returns not found. Tests cover cross-shop detail and mapping access.

### 53. Why are foreign keys configured with cascade deletion?

They keep tenant-owned data consistent if a shop or parent record is intentionally removed. However, there is currently no merchant deletion workflow.

### 54. Is deleting an originating batch safe after its intent was reused?

Not without careful design. OrderIntent has a required cascading relation to its originating batch, so deleting that batch would also delete the shared intent and its links from later batches. A future retention job must account for this.

### 55. How are monetary values stored?

OrderLine.unitPrice uses PostgreSQL Decimal(12,2) through Prisma Decimal, avoiding binary floating-point errors.

### 56. Are all status values free-form strings?

No. Prisma enums define shop, catalog, batch, order, line-validation, and error-category states.

### 57. Are state transitions enforced by a database state machine?

Not by triggers. Domain functions use conditional updateMany statements that include the expected current status. This makes competing transitions fail safely, but application code still owns the state machine.

### 58. How are concurrent batch counter updates protected?

Batch refresh obtains a PostgreSQL row lock with SELECT FOR UPDATE, then recalculates counts from linked intents before writing the new version.

### 59. Why are counts stored instead of calculated for every page load?

Stored aggregates make status polling and dashboards cheap. The tradeoff is that every intent transition must refresh all linked batches correctly.

### 60. What is a known migration risk?

The Phase 4 migration adds required OrderIntent columns without defaults. It is safe for the project's empty early-stage table, but a production system with existing OrderIntent rows would need a staged nullable backfill before adding NOT NULL constraints.

## CSV parsing and validation scenarios

### 61. What columns are required?

external_order_id, processed_at, email, currency, sku, quantity, and unit_price are required.

### 62. Which shipping and note fields are optional?

The file can include first and last name, two address lines, city, province, province code, country code, postal code, phone, and note.

### 63. Are unknown columns accepted?

No. The header validator rejects unsupported columns.

### 64. Are duplicate headers accepted?

No. Duplicate header names cause a row-one validation error.

### 65. Are header names case-insensitive?

No. Surrounding whitespace is trimmed, but names must match the expected lowercase names exactly.

### 66. What happens with an empty file?

It is rejected before parsing. A header-only file is also rejected because at least one valid data row is required.

### 67. How are malformed CSV columns handled?

csv-parse runs with strict column counts. Malformed records are converted into a safe file-level error rather than exposing parser internals.

### 68. What are the default upload limits?

The default maximum is 5 MB and 10,000 data rows. Both values can be changed through validated environment variables.

### 69. Is the size check based only on the browser's File.size value?

No. The code first checks File.size and also counts bytes while streaming. This protects against an inaccurate or misleading declared size.

### 70. Does streaming mean memory use is constant?

No. Parsing is streamed, but every valid normalized row is kept in an array and the final grouped orders are returned together. A maximum-size import can still use meaningful memory.

### 71. Is CSV processing asynchronous after upload?

No. Parsing, validation, hashing, SKU resolution, and draft creation happen in the web request. The UI asks the user to keep the page open during this stage.

### 72. What happens if the browser closes during upload?

There is no durable import until the database transaction commits. The server might finish a request after a disconnect, but the user should not assume durability until the redirect to Import Details succeeds.

### 73. What happens if the browser closes after confirmation?

The durable intent and outbox events are already in PostgreSQL, so background processing continues without the browser.

### 74. How are CSV rows grouped?

All rows with the same exact external_order_id become lines of one order.

### 75. Which values must be consistent across rows of the same order?

Processed time, email, currency, all shipping fields, and note must match after normalization. Otherwise the whole upload is rejected with the conflicting row number.

### 76. How is processed_at validated?

It must be an ISO 8601 timestamp with a timezone offset. It is normalized to a JavaScript ISO string before hashing and storage.

### 77. Does the parser reject a future processed_at value?

No. It validates format, not business time. Under the current Shopify API behavior, future processed times may be clamped by Shopify, so stricter local validation could be added if that matters.

### 78. How is email normalized?

It is trimmed by validation and converted to lowercase.

### 79. How is currency validated?

It must be exactly three letters and is converted to uppercase. The app does not verify that it is a real or store-supported currency before confirmation.

### 80. How is quantity validated?

It must be a positive whole number from 1 through 1,000,000.

### 81. How is unit price validated?

It must be non-negative, contain at most ten whole-number digits and two decimal places, and is normalized to two decimal places.

### 82. Can an order have a zero price?

Yes. The parser accepts zero and 0.00.

### 83. How are optional values normalized?

They are trimmed. Empty optional text becomes null, country and province codes are uppercased, and country code must be two letters.

### 84. How many validation issues are returned?

At most 50 safe issues are returned to the merchant.

### 85. Is the raw CSV saved?

No. The application saves the sanitized file name and normalized order fields, but not the uploaded bytes or raw rows.

### 86. Is customer data still retained?

Yes. Email, optional phone, address, note, and other normalized order details are stored in OrderIntent. There is no automatic purge policy yet.

### 87. How is the canonical payload hash created?

The app normalizes order-level values, normalizes money, sorts lines deterministically, serializes the canonical object as JSON, and calculates SHA-256.

### 88. Does changing CSV row order change the payload hash?

Not when the same lines and values remain, because lines are sorted before hashing.

### 89. Does changing only SKU letter case always keep the same hash?

No. The canonical line contains both originalSku and normalizedSku. A case-only change in originalSku can therefore change the hash even though matching is case-insensitive.

### 90. Why can that SKU case behavior matter?

A later upload with the same external identity but a different original SKU spelling can be reported as a content conflict. That is conservative but stricter than a hash based only on normalized SKU.

### 91. How is the source-system value validated?

It is trimmed, converted to lowercase, must be 2 to 64 characters, must start with a letter or number, and can otherwise contain letters, numbers, periods, underscores, and hyphens.

### 92. How is the uploaded file name handled?

Directory parts are removed, whitespace is trimmed, an empty name becomes orders.csv, and the result is limited to 255 characters.

## Catalog cache and SKU mapping scenarios

### 93. Why does the app keep a local catalog cache?

Imports can validate and search SKUs without making Shopify calls for every row. Local reads also keep the UI responsive during Shopify or network problems.

### 94. What catalog data is stored?

The cache stores Shopify variant and product GIDs, SKU and normalized SKU, titles, price, product status, Shopify update time, cache time, soft-delete time, and sync-run marker.

### 95. Is catalog currency populated?

No. The schema has a currency field, but the current GraphQL query and mapper do not set it. Documentation that says the active sync stores currency is ahead of the implementation.

### 96. How is an SKU normalized?

It is trimmed and converted to uppercase. Empty values become null.

### 97. How does the app handle a spreadsheet apostrophe before a numeric SKU?

An imported value such as '1901743 is allowed to match both the literal normalized value and 1901743. This alias is applied only when every character after the apostrophe is numeric.

### 98. Why is the apostrophe rule narrow?

Punctuation can be meaningful in an alphanumeric SKU. The code avoids silently changing values such as 'ABC or A-100.

### 99. What happens when an SKU has one active match?

The line becomes VALID and receives the Shopify variant GID.

### 100. What happens when an SKU has no active match?

The line becomes NEEDS_MAPPING and the containing order is blocked.

### 101. What happens when several active variants share the same SKU?

All variants remain in the cache. The line becomes AMBIGUOUS_MAPPING until the merchant explicitly chooses a variant.

### 102. Are mappings global?

No. A mapping is unique for a shop, source system, and normalized external SKU.

### 103. Does a saved mapping take priority over direct SKU matching?

Yes, when its target variant is still active. If the saved target is inactive, the resolver ignores it and falls back to current catalog matches.

### 104. Can a mapping point to a variant from another shop?

No. The selected variant must be active and belong to the authenticated shop.

### 105. What happens when the user maps one SKU that appears on several lines?

The mapping is saved once and all matching lines in that draft batch are updated. Every affected order is then recalculated.

### 106. Can mappings be changed after confirmation?

Not through the current mapping service or UI. applySkuMapping accepts only a DRAFT batch.

### 107. What does automatic draft re-resolution do?

Whenever Import Details loads, unresolved draft lines are checked again against saved mappings and the current active cache. Newly available matches can unblock orders without manual selection.

### 108. How are mapping candidates searched?

The service combines exact unresolved-SKU matches with up to 100 active variants filtered by SKU, normalized SKU, product title, or variant title. Results are de-duplicated by local variant ID.

### 109. What happens if the cache is empty?

Orders that need catalog resolution remain blocked. The UI asks the merchant to run a catalog sync.

### 110. Can a stale cache still be used?

Yes. The UI warns that it may be out of date, but active cached rows remain available. This favors continuity while making freshness visible.

### 111. How does a full catalog sync work?

The worker pages productVariants with first and after, upserts every page, and saves lastProcessedCursor after each page transaction.

### 112. What happens if a catalog worker crashes after a page?

The next run reloads the CatalogSyncRun and resumes after the last committed cursor.

### 113. What happens if a full sync fails halfway?

Already committed page updates remain, and the older active cache is not cleared. The run becomes FAILED, while the shop becomes STALE if a previous successful sync exists or FAILED if none exists.

### 114. When are missing variants marked deleted?

Only after the full sync completes successfully. Active rows not marked as seen in that successful run receive deletedAt.

### 115. Is deletion physical?

No. Catalog variants are soft-deleted by setting deletedAt. SKU resolution and lists use only rows where deletedAt is null.

### 116. How do product webhooks update the cache?

Create and update webhooks enqueue a targeted productVariants query filtered by product ID. Delete webhooks enqueue work that marks the product's cached variants deleted without calling Shopify.

### 117. What happens when a product webhook has no product ID?

The receipt is marked processed with a safe processing error, no refresh event is created, and the result is ignored.

### 118. How are duplicate product webhooks detected?

WebhookReceipt is unique by shopId and webhookId. The topic is indexed but is not part of the unique constraint.

### 119. Does the product webhook call Shopify inside the HTTP request?

No. It authenticates, stores a receipt and outbox event, and returns 202. The worker performs the Shopify call later.

### 120. How are missed webhooks repaired?

The worker runs a catalog reconciliation scheduler. It finds active shops with old, failed, missing, or never-synced caches and requests a full sync.

### 121. How often does the catalog scheduler run?

The interval is based on the stale threshold, with a minimum of five minutes and a maximum of one hour. Each scan schedules at most 25 shops by default.

### 122. What happens if two manual sync requests arrive together?

The transaction reuses a running CatalogSyncRun. It can create more than one outbox row, but the catalog bootstrap job ID is based on the sync-run ID, so queue publication is deduplicated for that run.

## Upload and business idempotency scenarios

### 123. Where does the upload idempotency key come from?

The New Import page generates a UUID in the browser and submits it as a hidden field.

### 124. What happens if the user double-clicks upload?

Requests carrying the same key return the original batch. A unique database constraint and retry loop also handle concurrent submissions.

### 125. What happens if the page is reloaded and the same file is uploaded again?

A new browser idempotency key can create a new batch, but each external order is checked against the durable business identity.

### 126. What happens when the same external order and same payload are uploaded again?

The new batch links to the existing OrderIntent with reused set to true. It does not copy the intent or create a second Shopify order.

### 127. What happens when the same external order has changed content?

The transaction throws a 409 conflict listing the changed external IDs. The existing intent is not overwritten and the new batch is not committed.

### 128. Can the same external_order_id be used by two source systems?

Yes. Source system is part of the unique business key.

### 129. Can the same external identity exist in two Shopify stores?

Yes. shopId is also part of the unique key.

### 130. What happens when duplicate external IDs occur inside one CSV?

They are treated as multiple lines of one order, provided all order-level values are consistent.

### 131. What if a later batch reuses an order that is still processing?

It links to the same intent and sees the same current status. When that shared intent changes, refreshLinkedBatches recalculates every linked batch.

### 132. What if a later batch contains an order that already succeeded?

The succeeded intent is reused. Confirming the later batch creates no new order job for it, and the batch can immediately derive a completed state if all linked intents succeeded.

### 133. Is the payload hash itself a security boundary?

No. It is an integrity and conflict-detection value. Authorization still comes from the authenticated shop and database ownership checks.

### 134. Why use both request idempotency and business idempotency?

The request key handles repeated submission of one upload attempt. The business key handles a new upload attempt that contains an order the app has already seen.

## Transactional outbox and queue scenarios

### 135. What is an OutboxEvent?

It is a durable database record saying that committed business work must be published to a queue. It stores tenant, aggregate, event type, a JSON payload, publication state, and safe publication error details.

### 136. Which operations create outbox events?

Batch confirmation, catalog sync requests, product webhook ingestion, lifecycle webhook ingestion, ambiguity scheduling, dead-letter replay, and the diagnostic flow create events.

### 137. What happens if Redis is down during confirmation?

Confirmation can still commit the queued intents and outbox events in PostgreSQL. The dispatcher keeps publishedAt null and retries publication after Redis recovers.

### 138. What happens if PostgreSQL is down?

The app cannot create durable intent or update workflow state, so the request or worker action fails. It does not pretend that Redis alone is a successful commit.

### 139. When is publishedAt set?

Only after queue.add succeeds. The database update is conditional on publishedAt still being null.

### 140. What if the dispatcher publishes a job and crashes before setting publishedAt?

The event is published again after restart. The same deterministic BullMQ job ID normally prevents a duplicate queue job, and the worker's state checks provide another layer.

### 141. Can two dispatchers read the same event?

Yes, because there is no outbox claim or skip-locked column. Both can try to publish it, but deterministic job IDs and the conditional publication update make this safe in the common case.

### 142. Why do order jobs use the outbox event ID instead of only the order ID?

One event should deduplicate with itself, while an explicitly authorized replay needs a new transport identity. Database state remains the main business-idempotency guard.

### 143. Why does catalog bootstrap use the sync-run ID?

Repeated requests for the same running full sync should converge on one queue job.

### 144. What data is put in Redis job payloads?

The envelope contains operational IDs, event type, aggregate identity, operation name, and an event-specific safe payload. It does not need customer email, address, phone, raw CSV, or an access token.

### 145. How are unsafe outbox payload fields prevented from reaching Redis?

Every supported event type has a Zod allowlist schema. Unknown properties are stripped during projection.

### 146. Does safe projection remove sensitive data from PostgreSQL outbox rows?

No. It protects the Redis boundary. Callers must still avoid putting sensitive data into the outbox table.

### 147. What are the queue names?

They are order-write, catalog-sync, and maintenance.

### 148. How are job priorities assigned?

Order creation has the highest priority, followed by reconciliation and replay. Catalog refresh, bootstrap, reconciliation, and diagnostics use progressively lower priorities.

### 149. What are the default BullMQ retry and retention settings?

Jobs default to five attempts with exponential backoff starting at one second and 25 percent jitter. Completed jobs are retained for up to one day or 1,000 jobs, and failed jobs for up to seven days or 1,000 jobs.

### 150. Is JOB_MAX_ATTEMPTS the business retry limit for every failure?

No. Controlled deferrals move a job back to delayed state and can continue without exhausting normal attempts. Permanent Shopify user errors dead-letter immediately, while unexpected thrown errors use BullMQ attempts.

### 151. What happens when an unknown outbox event type appears?

Safe projection rejects it, publication is recorded as failed, and the event remains unpublished. The dispatcher retries it; a large number of poison events could consume each scan batch and needs operational attention.

### 152. What happens when a queue job payload does not match the database event?

The maintenance processor rejects missing or mismatched event identity. The order processor also verifies that aggregateId matches orderIntentId before doing work.

## Order confirmation and creation scenarios

### 153. What happens inside confirmImportBatch?

The transaction verifies the batch and active shop, requires every linked intent to be in an allowed state, assigns deterministic source identifiers to READY intents, changes them to QUEUED, writes one order event per claimed intent, and refreshes the batch.

### 154. Is confirmation idempotent?

Yes. If confirmedAt is already set, it returns alreadyConfirmed and creates no new events.

### 155. How is sourceIdentifier built?

It contains the normalized source system plus the first 32 hexadecimal characters of a SHA-256 hash of the external order ID. The raw external ID is not sent in that identifier.

### 156. Why is sourceIdentifier important?

It provides a stable non-PII key that can be searched in Shopify after an ambiguous create result.

### 157. Does confirmation call Shopify?

No. It only changes PostgreSQL state and writes outbox events.

### 158. How does a worker claim an order?

It performs a conditional update from QUEUED or due RETRY_WAIT to PROCESSING while shopifyOrderGid is null. Only the worker whose update count is one owns the claim.

### 159. What happens if two workers receive the same create job?

Only one can claim the eligible state. The other returns not claimed, waits for the active lease, or no-ops after success.

### 160. What data is sent to orderCreate?

The mutation receives email, currency, processed time, deterministic source identifier, OrderRelay tags, optional note and shipping address, and line items with variant IDs, quantities, and imported price sets.

### 161. Does the app use the current Shopify catalog price?

No. It uses the unit_price imported in the CSV. The cached price is for display and catalog context, not the order line price.

### 162. Does the app create or find a Shopify customer?

No customer lookup or customerCreate call is made. The order input sends the imported email and optional shipping address.

### 163. What financial state does the app create?

It sends no transactions and does not set a captured financial status. The app should describe this as no payment capture rather than promise a specific Shopify status in every API version.

### 164. Does order creation reserve inventory?

The app does not implement its own inventory synchronization or reservation workflow. Any Shopify behavior comes from orderCreate and store configuration.

### 165. What happens if a mapped variant was deleted after confirmation?

The worker sends the stored GID. Shopify can return a user error, which becomes a permanent failure. Replay later checks that every mapped variant is still active in the local cache.

### 166. What happens if Shopify returns a normal user error?

The first user error is sanitized, the intent moves to DEAD_LETTER, a DeadLetterRecord is written in the same transaction, and linked batch counts are refreshed.

### 167. What happens if Shopify returns ACCESS_DENIED?

The create service classifies it as MISSING_SCOPE. The worker moves the intent to RETRY_WAIT for 15 minutes instead of dead-lettering it.

### 168. What happens if Shopify returns THROTTLED?

The work is delayed. The shared cost gate uses response metadata when available, and the intent stays recoverable.

### 169. What happens if Shopify returns an internal server error for a write?

The result is treated as ambiguous because Shopify might have committed the order. The worker does not issue another create blindly.

### 170. What happens if the response body has an unexpected shape?

The result becomes AMBIGUOUS_RESULT and reconciliation is scheduled.

### 171. What happens if the Admin client fails before request dispatch?

Failure while obtaining the client is treated as a safe authentication retry because no mutation was sent.

### 172. What happens if admin.graphql or response.json throws?

The create service cannot prove whether Shopify received or committed the mutation, so it treats the result as ambiguous.

### 173. What happens after a successful create?

The intent moves to SUCCEEDED, stores the Shopify order GID and name, clears errors and retry dates, refreshes all linked batches, and shows an embedded Shopify Admin order link.

### 174. What if a duplicate job arrives after success?

The worker sees shopifyOrderGid or SUCCEEDED and returns already succeeded without calling Shopify.

## Retries, leases, ambiguity, and dead letters

### 175. Why does the app use a processing lease?

A worker can crash while an intent says PROCESSING. The lease distinguishes a probably active worker from an abandoned claim.

### 176. What is the default lease duration?

Five minutes, controlled by ORDER_PROCESSING_LEASE_MS.

### 177. What happens when another delivery sees a live PROCESSING lease?

It delays itself until the remaining lease expires.

### 178. What happens when the create lease has expired?

The app assumes the previous worker might have sent the mutation. It marks the intent ambiguous and schedules read-only reconciliation.

### 179. How are normal retry delays calculated?

They use exponential backoff from one second, capped at 60 seconds, plus up to 499 milliseconds of jitter.

### 180. What is AMBIGUOUS_RESULT?

It means the app cannot safely say whether Shopify created the order. It is a deliberate safety state, not a normal failure.

### 181. How does reconciliation work?

The worker searches Shopify orders for the exact deterministic source_identifier and requests at most two matches.

### 182. What happens when reconciliation finds exactly one order?

The intent is marked SUCCEEDED with that order's GID and name. No new create mutation is sent.

### 183. What happens when reconciliation finds more than one order?

Automatic reconciliation stops, nextAttemptAt becomes null, and the merchant must review the ambiguous result.

### 184. What happens when reconciliation finds no order?

It retries until the configured not-found bound is reached. The default bound is three reconciliation claims.

### 185. Does reaching the no-result bound automatically recreate the order?

No. The intent stays AMBIGUOUS_RESULT with no automatic next attempt. This avoids creating a duplicate after a delayed or hidden Shopify write.

### 186. Do all reconciliation errors obey the three-attempt bound?

No. The explicit bound is applied to repeated not-found results. Temporary authentication, rate-limit, network, or GraphQL errors can remain delayed and retry later.

### 187. Can the merchant force-create an ambiguous order?

No. The Needs Attention action can only enqueue another reconciliation read.

### 188. What is a DeadLetterRecord?

It is an immutable failure-history row containing the order identity, job type, safe category, code, sanitized message, attempts, timestamps, and optional replay actor and time.

### 189. Is a permanent failure and its dead-letter history written atomically?

Yes. The intent transition, new DeadLetterRecord, and linked batch refresh happen in one PostgreSQL transaction.

### 190. Which failures are dead-lettered now?

Permanent Shopify user errors and invariant-style permanent errors are dead-lettered by the order processor. Throttling, missing scope, authentication delay, and ambiguous writes use other states.

### 191. How does safe replay work?

It reuses the same OrderIntent and sourceIdentifier, checks shop capability and current active variant GIDs, marks the latest unreplayed failure record, changes the intent to QUEUED, and writes a new outbox event.

### 192. Can two replay requests create two new business orders?

The replay transition is conditional on DEAD_LETTER. Only one transaction can change it to QUEUED, and later workers still use the same intent identity and source identifier.

### 193. What happens if replay is requested after the order already succeeded?

It returns already succeeded and marks an unreplayed dead-letter record as replayed if one exists. It does not enqueue a create.

### 194. What if a mapped variant is no longer active during replay?

Replay is rejected. The current message says to resolve mappings, but the current UI cannot edit mappings on a non-draft dead-lettered order. That repair workflow is a known product gap.

### 195. Can the merchant change email, address, price, or quantity before replay?

No. Replay uses the original durable payload. A future correction workflow would need explicit versioning and idempotency rules.

### 196. Why preserve old dead-letter records?

They provide audit history. Replay marks a record with replayedAt and replayedBy rather than deleting the failure.

### 197. How is batch status derived after processing?

All succeeded means COMPLETED. Any processing means PROCESSING. Queued or retrying work means QUEUED. Ambiguity is shown as PROCESSING. A mix with success and final failures becomes PARTIALLY_COMPLETED; final failure without success becomes FAILED.

### 198. Why can AMBIGUOUS_RESULT make a batch stay PROCESSING?

The business outcome is not known. Calling the batch failed or complete would be misleading while safe reconciliation or merchant review remains.

## Rate limiting and concurrency

### 199. How does the GraphQL cost gate work?

A Redis Lua script atomically restores estimated capacity over time, checks a padded request cost, reserves capacity, and returns a delay when the request should wait.

### 200. Why use Lua in Redis?

It makes read, restore, check, and reserve one atomic operation across concurrent workers.

### 201. Is the rate gate global?

No. Keys are scoped by internal shop ID, so one busy store does not consume another store's budget.

### 202. How does the gate learn real Shopify capacity?

The GraphQL wrapper reads extensions.cost.throttleStatus from the response and stores maximum available, currently available, and restore rate in Redis.

### 203. What happens before any Shopify cost metadata is observed?

The gate uses configurable fallback maximum capacity and restore rate, with defaults of 100 and 2 per second.

### 204. What does the safety margin do?

With the default 0.8 margin, estimated cost is padded. Background work also leaves 20 percent of the maximum budget available for higher-priority order work.

### 205. How are catalog and order calls coordinated?

They share the same per-shop cost key. Order calls use order priority, while catalog calls use background priority and preserve headroom.

### 206. What is the separate five-orders-per-minute gate?

Some development or trial stores return an orderCreate resource-limit error after five orders per minute. When that error is observed, a second Redis gate enforces a shared rolling window with a safety delay.

### 207. Is that five-per-minute gate always active?

No. It is activated after Shopify returns the recognized resource-limit user error. Until then, normal cost gating applies.

### 208. What happens if Redis rate-gate state is lost?

The local budget resets to fallback assumptions. Shopify remains the final authority and can throttle the app again, after which the gate relearns current state.

### 209. Does a delayed rate-limited job hold a worker thread?

No. The worker moves it to BullMQ's delayed state and throws DelayedError instead of sleeping or busy-waiting.

### 210. What are the default worker concurrency values?

Order concurrency is five, catalog concurrency is two, and maintenance concurrency is fixed at one.

## Webhooks, uninstall, and scope changes

### 211. Which webhooks are configured?

The app subscribes to app uninstall, app scope update, and product create, update, and delete.

### 212. How are webhook duplicates handled?

The service inserts a WebhookReceipt with a unique shop and webhook ID. A unique-constraint conflict returns duplicate without repeating state changes.

### 213. Why store a payload hash?

It provides an integrity reference for the received payload. The current duplicate logic does not compare hashes; webhook ID is the dedupe key.

### 214. What happens immediately during APP_UNINSTALLED?

The authenticated transaction marks the shop UNINSTALLED, records the time, deletes its sessions, stores the receipt, and creates minimal maintenance work.

### 215. What happens asynchronously after uninstall?

The maintenance worker cancels unresolved intents without Shopify order IDs, cancels active batches and running catalog syncs, and records safe uninstall errors.

### 216. Does uninstall delete imported customer data?

No. It deletes Shopify sessions and cancels work, but imported business records remain. Automated retention and erasure are not implemented.

### 217. Can a queued worker call Shopify after uninstall?

Workers check the durable shop state before the call and cancel work when they see UNINSTALLED. An already in-flight request remains a possible race.

### 218. What happens when write_orders is removed?

The HTTP webhook updates durable capability state. Maintenance moves QUEUED and RETRY_WAIT intents to RETRY_WAIT, clears automatic due time, and records MISSING_SCOPE without consuming new attempts.

### 219. What happens when write_orders is restored?

The lifecycle worker finds scope-blocked intents, gives them a due time, creates fresh order-create outbox events, and refreshes linked batches.

### 220. Can an old scope webhook reactivate an uninstalled shop?

Not by itself. Reactivation requires evidence of a current stored Shopify session.

### 221. How does reinstall reactivate the shop?

An authenticated admin request passes its exact session ID to syncAuthenticatedShop. If that session exists for the shop, the UNINSTALLED record can become ACTIVE or NEEDS_REAUTH.

### 222. What happens to reconciliation work during scope restoration?

Eligible ambiguous intents can be re-enqueued when order-read capability is available. Because write_orders includes read, a restored write scope satisfies that check.

### 223. Are lifecycle webhooks fully processed in the HTTP request?

Only the immediate capability and session state is committed synchronously. Broader cancellation, pausing, and resumption is handled through the maintenance queue.

## Status, UI, and pagination

### 224. Where does the dashboard get its information?

It reads PostgreSQL for catalog status, cached variants, and recent import batches. It does not call Shopify to build the page.

### 225. What does the Import Details status endpoint return?

It returns batch ID, status, version, aggregate counts, update time, and a terminal flag. It does not return email, address, phone, notes, or raw lines.

### 226. How is the status endpoint authorized?

It authenticates the admin request, derives the shop, and queries the batch with both shop ID and batch ID.

### 227. Why does the status endpoint use ETags?

The ETag is based on batch ID, version, and update time. If nothing changed, the endpoint returns 304 without sending the JSON body again.

### 228. Does it accept weak or multiple If-None-Match values?

Yes. It removes a weak W/ prefix, accepts a list, and also handles the wildcard.

### 229. How often does the browser poll?

It starts at 1.5 seconds and doubles after unchanged responses up to 15 seconds. A changed version resets the delay.

### 230. How does polling avoid duplicate requests?

The hook tracks an in-flight request, uses AbortController, and schedules the next poll only after the current one finishes.

### 231. What happens when the browser tab is hidden?

The timer is cleared and the current request is aborted. Polling resumes immediately when the page becomes visible.

### 232. When does polling stop?

It polls VALIDATING, READY, QUEUED, and PROCESSING. It stops for PARTIALLY_COMPLETED, COMPLETED, FAILED, CANCELLED, and also for DRAFT.

### 233. Why is DRAFT not polled?

Draft mapping changes happen through normal page actions and redirects. Background order processing has not started.

### 234. Which screens use keyset pagination?

The dashboard's cached variants and imports, Import Details orders, and Needs Attention items use opaque descending createdAt and ID cursors.

### 235. Why use keyset pagination?

It avoids increasingly expensive offsets and gives stable ordering when many rows exist.

### 236. How are invalid cursors handled?

The decoder validates a versioned base64url JSON payload. Invalid values produce a 400 response rather than an unsafe or unbounded query.

### 237. What is displayed in Needs Attention?

It includes missing or ambiguous mappings, AMBIGUOUS_RESULT orders, and DEAD_LETTER orders with sanitized error information and links to the originating import.

### 238. Does Needs Attention show the latest or complete dead-letter history?

The list loads only the latest dead-letter record for each intent. Older records remain in PostgreSQL but are not displayed on that page.

## Security, privacy, and observability

### 239. What sensitive values must never be logged?

Customer email, addresses, phone numbers, raw CSV data, access tokens, authorization headers, cookies, secrets, passwords, and full Shopify payloads should not be logged.

### 240. How does the logger protect sensitive data?

It redacts sensitive context-key names and common email, phone, bearer-token, Shopify-token, and credential patterns in free text.

### 241. Is redaction a reason to log full payloads?

No. The code treats redaction as defense in depth. Callers are expected to send only safe operational metadata.

### 242. What format do logs use?

They are one JSON object per line with timestamp, level, stable message, process role, operation name, and relevant IDs.

### 243. How are asynchronous logs correlated?

The durable outbox event ID becomes the correlation ID in the queue envelope and worker logs.

### 244. How are HTTP render requests correlated?

The server accepts a bounded safe X-Correlation-ID or X-Request-ID. Unsafe input is replaced with a UUID, and X-Correlation-ID is returned in the HTML response.

### 245. Are reserved log fields protected?

Yes. Context cannot replace timestamp, level, or message.

### 246. What is the log message size policy for errors?

sanitizeErrorMessage collapses whitespace, redacts sensitive patterns, and limits the stored text to 500 characters.

### 247. Does the app encrypt imported PII at the application layer?

No application-level field encryption is implemented. Protection depends on PostgreSQL, infrastructure encryption, access controls, backups, and operational policy.

### 248. Is there a data-retention policy in code?

No. A production deployment needs retention, deletion, and privacy-request handling appropriate to its legal and business requirements.

### 249. How is customer data kept out of Redis?

Queue payload projection uses event-specific allowlists containing only operational IDs, booleans, and bounded delays.

### 250. How is customer data kept out of the status API?

The status query selects only batch identity, state, version, counts, and update time.

### 251. Is the original file name sensitive?

It can reveal user-chosen text, so it is sanitized as a basename and length-limited. It is still displayed in the UI and should not be treated as secret storage.

## Operations and deployment

### 252. What does GET /health check?

Only web-process liveness. It returns 200 with status ok and does not test dependencies.

### 253. What does GET /ready check?

It validates required environment settings, runs SELECT 1 against PostgreSQL, and pings Redis. It returns 200 only when all checks pass; otherwise it returns 503.

### 254. Does /ready prove the worker is healthy?

No. It proves dependency access from the web process. Worker health is inferred from startup, job, and queue metrics because there is no worker health HTTP endpoint.

### 255. Does the readiness response expose secrets?

No. It reports dependency names and safe failure messages, not connection strings or credentials.

### 256. Which environment values are validated?

The app validates Shopify credentials and URL, scopes, PostgreSQL and Redis URLs, log level, worker concurrency, import limits, retry and rate settings, reconciliation settings, and outbox polling settings.

### 257. What happens when DATABASE_URL points to SQLite?

Environment validation rejects it. PostgreSQL or postgres URL schemes are required.

### 258. How should migrations run in production?

Run prisma migrate deploy once as a controlled deployment step. Do not let every web and worker replica race to apply migrations.

### 259. How does Docker Compose start locally?

The default profile starts PostgreSQL and Redis. The app profile adds a one-shot migration service plus separate web and worker services.

### 260. Why are host and container database URLs separate?

Host commands use localhost, while containers use Compose service names such as postgres and redis.

### 261. What does the Docker image contain?

It installs locked dependencies, generates Prisma, builds the web and worker artifacts, prunes development dependencies, and defaults to migration plus web startup.

### 262. How is the worker started from the same image?

Compose overrides the command with npm run worker:start. The TypeScript worker is compiled into build/worker.

### 263. How does graceful shutdown work?

On SIGTERM or SIGINT, the worker stops the catalog scheduler, stops the outbox dispatcher, closes workers, queues, Redis, and Prisma, then exits.

### 264. What happens to in-flight work during an abrupt shutdown?

BullMQ can redeliver it. If an order remains PROCESSING past its lease, the next delivery moves it to ambiguity reconciliation rather than blindly creating again.

### 265. What operational signal shows a Redis outage?

Unpublished outbox count and oldest age grow, while lastPublishError and dispatcher warnings appear. Business intent remains in PostgreSQL.

### 266. What operational signal shows a stuck worker?

The absence of current worker.started and queue completion activity, growing delayed or waiting counts, and old PROCESSING leases are warning signs.

### 267. How should an operator handle AMBIGUOUS_RESULT?

Use read-only reconciliation and inspect Shopify by the deterministic source identifier. Do not manually clear the identifier or force the intent back to QUEUED.

### 268. Is deployment automated?

No. CI verifies the repository, but environment-specific infrastructure and Shopify deployment are manual.

## Testing and quality

### 269. What test runner is used?

Vitest runs in the Node environment.

### 270. What did the current automated run prove?

All 68 tests passed. They cover parser rules, catalog pagination and resume, keyset cursors, import identity, outbox recovery, order concurrency and ambiguity, lifecycle safety, logging, polling helpers, session storage, and a representative pipeline.

### 271. Do tests use real PostgreSQL?

The integration tests use PostgreSQL when DATABASE_URL is available. In this audit those tests ran and passed.

### 272. Do tests use real Redis and BullMQ?

Queue, outbox, and rate-gate integration tests use Redis when REDIS_URL is available. In this audit they ran and passed.

### 273. Do tests create real Shopify orders?

No. Shopify GraphQL clients and responses are mocked.

### 274. What does the representative pipeline test cover?

It parses sample CSV, verifies repeated upload idempotency, confirms a batch, projects outbox events, runs order processors with mocked Shopify, and verifies terminal local status.

### 275. What concurrency behavior is tested?

Tests show that only one of two workers claims an order and that concurrent completions keep batch counters consistent.

### 276. What failure behavior is tested?

Tests cover Redis publication failure and recovery, worker restart ambiguity, Shopify user errors, resource throttling, GraphQL throttling, pre-dispatch auth failure, lost mutation response, and reconciliation results.

### 277. What security behavior is tested?

Tests cover cross-shop access, log redaction, safe correlation IDs, PII stripping from queue payloads, lifecycle webhook dedupe, uninstall blocking, and scope pause/resume.

### 278. What important behavior is not automated?

Live Shopify OAuth, managed installation, real Admin GraphQL permissions, actual webhook delivery, embedded App Bridge navigation, and end-to-end browser interaction are manual.

### 279. Is there a Playwright test suite?

No. The project deliberately avoids a brittle live-OAuth browser setup for now.

### 280. Does CI deploy the app?

No. CI installs locked packages, generates Prisma, applies migrations, lints, type-checks, tests, and builds. It does not deploy to Shopify or production infrastructure.

### 281. Why is package-lock.json important?

The repository uses npm ci, and the lockfile defines the exact dependency graph used by Docker and CI.

### 282. What Node versions are supported?

The package requires Node 20.19 up to but not including 22, or Node 22.12 and newer.

## Critical review and improvement questions

### 283. What documentation claim needed correction?

usage.md calls read_orders an additional minimum scope. Shopify's current scope rules say write_orders already includes read permission, matching the checked-in read_products,write_orders configuration.

### 284. What catalog documentation is ahead of the code?

The usage guide says cached variants include currency. The database has that column, but the current catalog query and mapper leave it null.

### 285. What does “streaming CSV parser” hide?

It correctly streams bytes through csv-parse and enforces limits, but it does not stream each validated order directly into durable storage. The complete normalized input is still accumulated in memory.

### 286. What product gap exists in dead-letter recovery?

Replay can reject inactive variant mappings, but mapping edits are allowed only on draft batches. A repair screen or versioned correction workflow is needed for a failed confirmed order.

### 287. What scalability concern exists in draft creation?

The service performs many sequential Prisma writes inside one transaction, including per-intent line creation. Ten thousand rows can produce a long transaction and should be load-tested or batched.

### 288. What scalability concern exists in the outbox dispatcher?

It scans and publishes a batch sequentially and has no claim lease. This is simple and tested, but high volume may need skip-locked claims, partitioning, and metrics.

### 289. What fairness concern exists in stale catalog scheduling?

The scan orders by oldest successful sync and takes 25. That is sensible, but repeated failures and a growing tenant count need monitoring to prevent starvation.

### 290. What data-governance feature is most urgent before production?

Add retention and deletion workflows for normalized customer data, dead-letter history, webhook receipts, and old imports, while preserving shared OrderIntent relationships safely.

### 291. What observability feature is missing?

There is no dedicated worker readiness endpoint or built-in metrics exporter. Production should expose queue depth, unpublished outbox age, processing lease age, error rates, and reconciliation counts.

### 292. What recovery feature is missing for poison outbox events?

There is no separate outbox dead-letter state. Unsupported or permanently invalid events remain unpublished and retry forever.

### 293. What order correction feature is missing?

The app cannot version or edit a confirmed order's email, address, price, quantity, or mapping. Re-uploading changed content correctly conflicts, but there is no reviewed correction workflow.

### 294. What payment-related wording should an engineer avoid?

Do not say the app imports paid orders. It creates orders with no payment transactions and no captured financial state.

### 295. What exactly-once wording should an engineer avoid?

Do not say deterministic queue IDs guarantee exactly once. They reduce duplicate transport, while database identity, guarded transitions, source identifiers, and reconciliation reduce duplicate business writes.

### 296. Could Shopify still create a duplicate?

Yes, in an irreducibly ambiguous remote-write situation or through external manual action. The app minimizes risk but cannot atomically commit its PostgreSQL transaction and Shopify's database transaction together.

### 297. Why not automatically create again after three empty reconciliation searches?

Shopify indexing or visibility can lag, and a lost response may still represent a committed order. Automatic recreation would trade an unresolved item for a possible duplicate customer order.

### 298. What would make the outbox guarantee stronger?

Add database claims with a lease and SKIP LOCKED, explicit poison-event handling, backlog metrics and alerts, and a repair command that preserves audit history.

### 299. What would make CSV ingestion more scalable?

Stage the upload in controlled object storage, process it asynchronously, stream grouped records into bounded chunks, and show validation progress. This would require new cleanup and security controls.

### 300. What would make mapping recovery stronger?

Add a controlled correction state for confirmed failures, record mapping revisions, rerun payload validation, keep the same business identity, and allow create replay only when the previous result is conclusively not a Shopify write.

### 301. What would make privacy stronger?

Add configurable retention, tenant deletion, data-subject workflows, encrypted backups, restricted database roles, field-level access auditing, and documented recovery-time deletion behavior.

### 302. What would make testing stronger?

Add contract tests against a development store, authenticated Shopify CLI configuration validation in release checks, a small embedded browser smoke suite, migration-upgrade tests with existing data, and load tests for maximum imports.

### 303. What would make API-version maintenance safer?

Keep GraphQL validation in CI, test webhook payload fixtures for the configured webhook version, monitor Shopify deprecations, and upgrade one version at a time with real-store verification.

### 304. What is the strongest part of the design?

The app separates durable business identity from queue delivery. Database constraints, the transactional outbox, conditional claims, deterministic source identifiers, and ambiguity reconciliation reinforce each other.

### 305. What is the weakest production area?

Operational and data-governance tooling is still portfolio-level. Retention, worker metrics, poison-event handling, live Shopify verification, and correction workflows need more work.

### 306. If you had one minute to explain the app to an engineer, what would you say?

OrderRelay turns a CSV into tenant-scoped durable order intents, resolves each line against a local Shopify catalog cache, and queues confirmed work through a PostgreSQL outbox to BullMQ. Workers use guarded state transitions and per-shop rate controls to call Shopify. Conclusive success is stored locally; permanent failures go to dead-letter history; inconclusive writes are searched by a deterministic source identifier and are never blindly recreated.
