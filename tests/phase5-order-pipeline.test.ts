import { PrismaClient } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  describeOutboxJob,
  JOB_NAMES,
  OUTBOX_EVENT_TYPES,
} from "../app/queues/jobs";
import { createDraftImport } from "../app/services/imports/import-domain.server";
import { parseImportCsv } from "../app/services/imports/import-parser.server";
import { buildOrderCreateInput } from "../app/services/orders/order-create.server";
import {
  buildOrderSourceIdentifier,
  confirmImportBatch,
} from "../app/services/orders/order-state.server";
import { ShopifyRateGate } from "../app/services/shopify/shopify-rate-gate.server";
import {
  OrderWorkDeferredError,
  processOrderJob,
  type OrderProcessorOptions,
} from "../worker/processors/order.processor";

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describe("Phase 5 order queue descriptors", () => {
  it("publishes ambiguity reconciliation with the requested delay", () => {
    const descriptor = describeOutboxJob({
      id: "event-1",
      shopId: "shop-1",
      aggregateType: "OrderIntent",
      aggregateId: "intent-1",
      eventType: OUTBOX_EVENT_TYPES.orderReconcileAmbiguous,
      payload: { orderIntentId: "intent-1", delayMs: 5_000 },
    });

    expect(descriptor.jobId).toBe("order-reconcile-ambiguous__event-1");
    expect(descriptor.options.delay).toBe(5_000);
  });
});

describeIfDatabase("Phase 5 order pipeline", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterEach(async () => {
    await prisma.shop.deleteMany({
      where: { domain: { startsWith: "phase5-" } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("confirms ready intents and creates outbox work without calling Shopify", async () => {
    const fixture = await createReadyImport(prisma);

    const result = await confirmImportBatch(prisma, {
      shopId: fixture.shopId,
      batchId: fixture.batchId,
      now: new Date("2026-09-11T00:00:00.000Z"),
    });
    const intent = await prisma.orderIntent.findUniqueOrThrow({
      where: { id: fixture.orderIntentId },
    });
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: fixture.orderIntentId },
    });

    expect(result).toMatchObject({
      status: "QUEUED",
      queuedOrderIntentIds: [fixture.orderIntentId],
      alreadyConfirmed: false,
    });
    expect(intent).toMatchObject({
      status: "QUEUED",
      sourceIdentifier: buildOrderSourceIdentifier("erp-main", "order-1"),
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: OUTBOX_EVENT_TYPES.orderCreate,
      payload: { orderIntentId: fixture.orderIntentId },
    });

    const repeated = await confirmImportBatch(prisma, {
      shopId: fixture.shopId,
      batchId: fixture.batchId,
    });
    expect(repeated.alreadyConfirmed).toBe(true);
    expect(
      await prisma.outboxEvent.count({ where: { shopId: fixture.shopId } }),
    ).toBe(1);
  });

  it("lets only one of two workers claim and create an order", async () => {
    const fixture = await queuedImport(prisma);
    const graphql = vi.fn().mockResolvedValue(
      response({
        data: {
          orderCreate: {
            order: { id: "gid://shopify/Order/101", name: "#101" },
            userErrors: [],
          },
        },
      }),
    );
    const options = processorOptions(prisma, graphql);
    const orderJob = job(JOB_NAMES.orderCreate, fixture);

    const results = await Promise.allSettled([
      processOrderJob(orderJob, options),
      processOrderJob(orderJob, options),
    ]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(
      results.some(
        (result) =>
          result.status === "fulfilled" && result.value.status === "succeeded",
      ),
    ).toBe(true);
    expect(
      results.some(
        (result) =>
          (result.status === "rejected" &&
            result.reason instanceof OrderWorkDeferredError) ||
          (result.status === "fulfilled" &&
            result.value.status === "not-claimed"),
      ),
    ).toBe(true);
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "SUCCEEDED",
      shopifyOrderGid: "gid://shopify/Order/101",
      shopifyOrderName: "#101",
    });

    await expect(processOrderJob(orderJob, options)).resolves.toMatchObject({
      status: "already-succeeded",
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("reconciles a stale processing claim after a worker restart instead of blindly creating", async () => {
    const fixture = await queuedImport(prisma);
    await prisma.orderIntent.update({
      where: { id: fixture.orderIntentId },
      data: {
        status: "PROCESSING",
        processingStartedAt: new Date("2026-09-10T23:50:00.000Z"),
      },
    });
    const graphql = vi.fn();

    await expect(
      processOrderJob(
        job(JOB_NAMES.orderCreate, fixture),
        processorOptions(prisma, graphql),
      ),
    ).resolves.toMatchObject({ status: "ambiguous" });
    expect(graphql).not.toHaveBeenCalled();
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({ status: "AMBIGUOUS_RESULT" });
  });

  it("stores Shopify user errors as a permanent safe failure", async () => {
    const fixture = await queuedImport(prisma);
    const graphql = vi.fn().mockResolvedValue(
      response({
        data: {
          orderCreate: {
            order: null,
            userErrors: [
              {
                field: ["order", "lineItems", "0"],
                message: "Variant is unavailable",
              },
            ],
          },
        },
      }),
    );

    await expect(
      processOrderJob(
        job(JOB_NAMES.orderCreate, fixture),
        processorOptions(prisma, graphql),
      ),
    ).resolves.toMatchObject({ status: "permanent-failure" });
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "DEAD_LETTER",
      lastErrorCategory: "SHOPIFY_USER_ERROR",
      lastErrorCode: "order.lineItems.0",
      sanitizedLastError: "Variant is unavailable",
    });
  });

  it("delays Shopify throttling without dead-lettering", async () => {
    const fixture = await queuedImport(prisma);
    const graphql = vi.fn().mockResolvedValue(
      response({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }),
    );

    await expect(
      processOrderJob(
        job(JOB_NAMES.orderCreate, fixture),
        processorOptions(prisma, graphql),
      ),
    ).rejects.toBeInstanceOf(OrderWorkDeferredError);
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "RETRY_WAIT",
      lastErrorCategory: "THROTTLED",
    });
  });

  it("retries safely when the Admin client fails before request dispatch", async () => {
    const fixture = await queuedImport(prisma);
    const options = processorOptions(prisma, vi.fn());
    options.getAdmin = async () => {
      throw new Error("offline session temporarily unavailable");
    };

    await expect(
      processOrderJob(job(JOB_NAMES.orderCreate, fixture), options),
    ).rejects.toBeInstanceOf(OrderWorkDeferredError);
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "RETRY_WAIT",
      lastErrorCategory: "AUTHENTICATION",
      lastErrorCode: "ADMIN_CLIENT_UNAVAILABLE",
    });
  });

  it("marks a lost mutation response ambiguous and queues delayed reconciliation", async () => {
    const fixture = await queuedImport(prisma);
    const graphql = vi.fn().mockRejectedValue(new Error("connection reset"));

    await expect(
      processOrderJob(
        job(JOB_NAMES.orderCreate, fixture),
        processorOptions(prisma, graphql),
      ),
    ).resolves.toMatchObject({ status: "ambiguous" });
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "AMBIGUOUS_RESULT",
      lastErrorCategory: "AMBIGUOUS_WRITE_RESULT",
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: {
        aggregateId: fixture.orderIntentId,
        eventType: OUTBOX_EVENT_TYPES.orderReconcileAmbiguous,
      },
    });
    expect(event.payload).toMatchObject({ delayMs: 5_000 });
  });

  it("reconciles exactly one matching order without another create", async () => {
    const fixture = await ambiguousImport(prisma);
    const graphql = vi.fn().mockResolvedValue(
      response({
        data: {
          orders: {
            nodes: [{ id: "gid://shopify/Order/202", name: "#202" }],
          },
        },
      }),
    );

    await expect(
      processOrderJob(
        job(JOB_NAMES.orderReconcileAmbiguous, fixture),
        processorOptions(prisma, graphql),
      ),
    ).resolves.toMatchObject({ status: "reconciled" });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining("OrderRelayReconcileOrder"),
      expect.objectContaining({
        variables: {
          query: expect.stringContaining("source_identifier"),
        },
      }),
    );
    expect(
      await prisma.orderIntent.findUniqueOrThrow({
        where: { id: fixture.orderIntentId },
      }),
    ).toMatchObject({
      status: "SUCCEEDED",
      shopifyOrderGid: "gid://shopify/Order/202",
    });
  });

  it.each([
    [[], "not-found-final"],
    [
      [
        { id: "gid://shopify/Order/1", name: "#1" },
        { id: "gid://shopify/Order/2", name: "#2" },
      ],
      "multiple",
    ],
  ])(
    "keeps unresolved reconciliation visible for merchant review",
    async (nodes, status) => {
      const fixture = await ambiguousImport(prisma);
      const graphql = vi
        .fn()
        .mockResolvedValue(response({ data: { orders: { nodes } } }));

      await expect(
        processOrderJob(job(JOB_NAMES.orderReconcileAmbiguous, fixture), {
          ...processorOptions(prisma, graphql),
          reconciliationMaxAttempts: 1,
        }),
      ).resolves.toMatchObject({ status });
      expect(
        await prisma.orderIntent.findUniqueOrThrow({
          where: { id: fixture.orderIntentId },
        }),
      ).toMatchObject({ status: "AMBIGUOUS_RESULT", nextAttemptAt: null });
    },
  );

  it("builds variant-priced unpaid order input without transactions", async () => {
    const fixture = await createReadyImport(prisma);
    await confirmImportBatch(prisma, {
      shopId: fixture.shopId,
      batchId: fixture.batchId,
    });
    const intent = await prisma.orderIntent.findUniqueOrThrow({
      where: { id: fixture.orderIntentId },
      include: { orderLines: true },
    });

    const input = buildOrderCreateInput(intent);
    expect(input).toMatchObject({
      currency: "USD",
      sourceIdentifier: expect.stringMatching(/^orderrelay:erp-main:/),
      lineItems: [
        {
          variantId: expect.stringContaining("ProductVariant"),
          quantity: 1,
          priceSet: {
            shopMoney: { amount: "10.00", currencyCode: "USD" },
          },
        },
      ],
    });
    expect(input).not.toHaveProperty("transactions");
    expect(input).not.toHaveProperty("financialStatus");
  });
});

const redisUrl = process.env.REDIS_URL ?? "";
const describeIfRedis = redisUrl ? describe : describe.skip;

describeIfRedis("Phase 5 Shopify Redis rate gate", () => {
  let redis: import("ioredis").Redis;
  let now = Date.parse("2026-09-11T00:00:00.000Z");
  const prefixes: string[] = [];

  beforeAll(async () => {
    const { createBullMqRedisConnection } =
      await import("../app/queues/connection.server");
    redis = createBullMqRedisConnection(redisUrl, {
      connectionName: "orderrelay-phase5-rate-test",
    });
  });

  afterEach(async () => {
    for (const prefix of prefixes.splice(0)) {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(keys);
    }
    now = Date.parse("2026-09-11T00:00:00.000Z");
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("atomically separates shops and prevents concurrent overspend", async () => {
    const gate = createRedisGate({
      maximum: 30,
      restoreRate: 0.001,
      margin: 1,
    });
    const [first, second, otherShop] = await Promise.all([
      gate.reserve("shop-a", 20, "order"),
      gate.reserve("shop-a", 20, "order"),
      gate.reserve("shop-b", 20, "order"),
    ]);

    expect([first.allowed, second.allowed].filter(Boolean)).toHaveLength(1);
    expect(otherShop.allowed).toBe(true);
  });

  it("restores budget, honors observations, and reserves background headroom", async () => {
    const gate = createRedisGate({
      maximum: 100,
      restoreRate: 10,
      margin: 0.8,
    });
    await gate.observe("shop-a", {
      maximumAvailable: 100,
      currentlyAvailable: 20,
      restoreRate: 10,
    });

    expect((await gate.reserve("shop-a", 20, "order")).allowed).toBe(false);
    now += 500;
    expect((await gate.reserve("shop-a", 20, "order")).allowed).toBe(true);

    await gate.observe("shop-b", {
      maximumAvailable: 100,
      currentlyAvailable: 40,
      restoreRate: 10,
    });
    expect((await gate.reserve("shop-b", 20, "background")).allowed).toBe(
      false,
    );
  });

  function createRedisGate(input: {
    maximum: number;
    restoreRate: number;
    margin: number;
  }) {
    const prefix = `orderrelay:test-rate:${crypto.randomUUID()}`;
    prefixes.push(prefix);
    return new ShopifyRateGate({
      redis,
      safetyMargin: input.margin,
      fallbackMaximumAvailable: input.maximum,
      fallbackRestoreRate: input.restoreRate,
      now: () => now,
      jitter: () => 0,
      keyPrefix: prefix,
    });
  }
});

function processorOptions(
  prisma: PrismaClient,
  graphql: ReturnType<typeof vi.fn>,
): OrderProcessorOptions {
  const evalMock = vi.fn(async (script: string) =>
    script.includes("return { allowed") ? [1, 0, 80, 100, 2] : 1,
  );
  return {
    prisma,
    rateGate: new ShopifyRateGate({
      redis: { eval: evalMock } as never,
      safetyMargin: 0.8,
      fallbackMaximumAvailable: 100,
      fallbackRestoreRate: 2,
      jitter: () => 0,
    }),
    orderCreateEstimatedCost: 20,
    orderReconcileEstimatedCost: 10,
    reconciliationDelayMs: 5_000,
    reconciliationMaxAttempts: 3,
    processingLeaseMs: 5 * 60 * 1000,
    getAdmin: async () => ({ graphql }),
    now: () => new Date("2026-09-11T00:00:00.000Z"),
    random: () => 0,
  };
}

async function queuedImport(prisma: PrismaClient) {
  const fixture = await createReadyImport(prisma);
  await confirmImportBatch(prisma, {
    shopId: fixture.shopId,
    batchId: fixture.batchId,
    now: new Date("2026-09-11T00:00:00.000Z"),
  });
  return fixture;
}

async function ambiguousImport(prisma: PrismaClient) {
  const fixture = await queuedImport(prisma);
  await prisma.orderIntent.update({
    where: { id: fixture.orderIntentId },
    data: {
      status: "AMBIGUOUS_RESULT",
      nextAttemptAt: null,
      processingStartedAt: null,
      lastErrorCategory: "AMBIGUOUS_WRITE_RESULT",
    },
  });
  return fixture;
}

async function createReadyImport(prisma: PrismaClient) {
  const domain = `phase5-${crypto.randomUUID()}.myshopify.com`;
  const shop = await prisma.shop.create({
    data: {
      domain,
      grantedScopes: "read_products,read_orders,write_orders",
    },
  });
  await prisma.catalogVariant.create({
    data: {
      shopId: shop.id,
      shopifyVariantGid: `gid://shopify/ProductVariant/${crypto.randomUUID()}`,
      shopifyProductGid: "gid://shopify/Product/1",
      sku: "SKU-1",
      normalizedSku: "SKU-1",
      productTitle: "Product one",
    },
  });
  const orders = await parseImportCsv(
    new File(
      [
        [
          "external_order_id,processed_at,email,currency,sku,quantity,unit_price",
          "order-1,2026-09-10T12:00:00Z,buyer@example.com,USD,SKU-1,1,10.00",
        ].join("\n"),
      ],
      "orders.csv",
    ),
    { maxBytes: 100_000, maxRows: 100 },
  );
  const result = await createDraftImport(prisma, {
    shopDomain: domain,
    grantedScopes: "read_products,read_orders,write_orders",
    sourceSystem: "erp-main",
    originalFileName: "orders.csv",
    idempotencyKey: crypto.randomUUID(),
    orders,
  });
  const intent = await prisma.orderIntent.findFirstOrThrow({
    where: { shopId: shop.id },
  });
  return {
    shopId: shop.id,
    batchId: result.batch.id,
    orderIntentId: intent.id,
  };
}

function job(
  name: typeof JOB_NAMES.orderCreate | typeof JOB_NAMES.orderReconcileAmbiguous,
  fixture: { shopId: string; orderIntentId: string },
) {
  return {
    id: `${name}__${fixture.orderIntentId}`,
    name,
    attemptsMade: 0,
    data: {
      eventId: crypto.randomUUID(),
      shopId: fixture.shopId,
      aggregateType: "OrderIntent",
      aggregateId: fixture.orderIntentId,
      eventType: name,
      payload: { orderIntentId: fixture.orderIntentId },
      operationName: name,
      enqueuedAt: new Date().toISOString(),
    },
  };
}

function response(body: unknown) {
  return { json: async () => body };
}
