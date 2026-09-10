# OrderRelay

OrderRelay is a Shopify embedded app for reliable external order imports. The app is being evolved incrementally from the Shopify React Router template.

Phase 1 establishes the PostgreSQL foundation only. CSV import, catalog sync behavior, BullMQ workers, order creation, and dead-letter replay are planned for later phases.

## Stack

- React Router 7 and React 18
- Shopify App Bridge and Shopify React Router authentication helpers
- Prisma with PostgreSQL
- Redis configured for future BullMQ queues
- Docker and Docker Compose for local infrastructure
- Vitest for foundation tests

## Local Setup

Install dependencies with npm so `package-lock.json` stays authoritative:

```sh
npm install
```

Start local infrastructure:

```sh
docker compose up -d postgres redis
```

Copy `.env.example` to `.env` for non-Shopify-CLI commands and fill the Shopify values supplied by your app configuration. The default local database URL is:

```sh
postgresql://orderrelay:orderrelay@localhost:5432/orderrelay_development?schema=public
```

`WEB_DATABASE_URL` and `WEB_REDIS_URL` use Compose service hostnames for the optional web container. Keep `DATABASE_URL` and `REDIS_URL` pointed at `localhost` for commands run from the host.

Generate the Prisma client and apply migrations:

```sh
npm run setup
```

Run the Shopify development server:

```sh
npm run dev
```

## Useful Commands

```sh
npm run prisma:generate
npm run migrate:deploy
npm run migrate:dev
npm run lint
npm run typecheck
npm test
npm run build
```

## Health Checks

- `GET /health` returns process liveness without checking dependencies.
- `GET /ready` validates required environment, PostgreSQL connectivity, and Redis connectivity.

Health responses never include secrets or raw connection strings.

## Docker Compose

Default Compose startup runs only infrastructure:

```sh
docker compose up -d postgres redis
```

To run the web container as well, provide Shopify credentials in the environment and use the app profile:

```sh
docker compose --profile app up --build
```

No worker service is included yet. BullMQ and the separate worker process begin in Phase 2.

## Documentation

- `docs/implementation-plan.md`
- `docs/architecture.md`
- `docs/adr/001-postgresql-and-bullmq.md`
- `docs/adr/002-idempotency-and-transactional-outbox.md`
