# Day 3 — HTTP Routes, Authentication, and Tenant Safety

## Goal

Learn how a React Router route turns a merchant request into a tenant-scoped domain call without mixing UI, authorization, and business logic.

## Read in this order

1. [`app/routes.js`](../app/routes.js) — routes are discovered from filenames.
2. [`app/root.jsx`](../app/root.jsx) — document shell.
3. [`app/routes/app.jsx`](../app/routes/app.jsx) — authenticated embedded layout.
4. [`app/routes/app._index.jsx`](../app/routes/app._index.jsx) — dashboard loader/action.
5. [`app/routes/app.imports.new.jsx`](../app/routes/app.imports.new.jsx) — upload loader/action/component.
6. [`app/routes/app.imports.$batchId.jsx`](../app/routes/app.imports.$batchId.jsx) — details, mapping, confirmation, and polling.
7. [`app/routes/app.api.imports.$batchId.status.js`](../app/routes/app.api.imports.$batchId.status.js) — local resource route.
8. One product webhook route and [`app/services/catalog/product-webhooks.server.js`](../app/services/catalog/product-webhooks.server.js).

## Route module mental model

- `loader` handles reads and supplies render data.
- `action` handles mutations from forms/requests.
- the default React component renders the embedded UI.
- `headers` and `ErrorBoundary` preserve Shopify authentication behavior.

Server-only modules use `.server.js` names. The route should authenticate and validate transport concerns, then call a service function for domain behavior.

## Embedded authentication path

`app.jsx` calls `authenticate.admin(request)`, then `syncAuthenticatedShop()` synchronizes the session’s shop domain and scopes into the durable `Shop` row. Descendant routes also authenticate their own requests; the layout is not treated as sufficient authorization for every later request.

The important tenant rule is:

```text
request -> authenticated session.shop -> Shop row -> Shop.id -> every domain query
```

The browser never gets to decide the authoritative shop ID. Route parameters such as `batchId` identify a resource only after the database query also constrains `shopId`.

## Upload route trace

In `app.imports.new.jsx`:

1. authenticate admin;
2. parse multipart form data;
3. load environment limits;
4. check `File`, source system, and idempotency key types;
5. call `parseImportCsv()`;
6. call `createDraftImport()` with the authenticated shop;
7. redirect to the persisted batch;
8. translate expected validation/domain errors to safe `4xx` JSON.

Notice that validation failures are returned to the merchant, while unknown exceptions are rethrown for server error handling. This avoids exposing stack traces or database details.

## Details route: one URL, three commands

The action reads a hidden `intent` field and accepts only:

- `catalog-sync`;
- `confirm-batch`;
- `map-sku`.

Each branch calls a focused service. This is command dispatch at the HTTP boundary. Unsupported values return `400` rather than falling through.

The loader uses two independent cursor/search concepts:

- `cursor` paginates order intents;
- `variantQuery` filters cached variant candidates.

Both reads stay local to PostgreSQL. Rendering an import page does not query Shopify.

## Webhook route difference

Admin pages use `authenticate.admin`; webhook routes use `authenticate.webhook`. The webhook payload is authenticated by Shopify’s helper, then the service:

1. upserts/locates the shop;
2. creates a unique `WebhookReceipt`;
3. writes minimal outbox work in the same transaction;
4. returns quickly.

The HTTP webhook route does not perform a catalog GraphQL refresh inline. This keeps webhook acknowledgements fast and makes work restart-safe.

## Health versus readiness

Read [`app/routes/health.jsx`](../app/routes/health.jsx) and [`app/routes/ready.jsx`](../app/routes/ready.jsx).

- Liveness answers “is this process responding?”
- Readiness answers “can it currently serve correctly?” and checks validated environment, PostgreSQL, and Redis.

A Redis `PING` is only a connectivity check. It does not prove queues are draining, workers are alive, or Shopify is reachable.

## Exercise: trace authorization

For `/app/imports/:batchId`, write down where each value originates:

- `session.shop` — verified session;
- `shop.id` — PostgreSQL lookup using verified domain;
- `params.batchId` — untrusted URL input;
- final record — query requiring both `batchId` and `shopId`.

Then inspect the mapping action and prove a variant from another shop cannot be selected.

## Defend-it questions

1. Why authenticate in each route even though `app.jsx` is authenticated?
2. Why is a browser-provided shop domain not authorization?
3. Why do webhook handlers write receipts and outbox rows before returning?
4. What does `/ready` prove, and what does it not prove?
5. Where should a new business rule live: JSX action or service module?

