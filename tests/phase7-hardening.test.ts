import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeOutboxJob, OUTBOX_EVENT_TYPES } from "../app/queues/jobs";
import {
  createDraftImport,
  ExternalOrderConflictError,
} from "../app/services/imports/import-domain.server";
import {
  ImportValidationError,
  parseImportCsv,
} from "../app/services/imports/import-parser.server";
import { getImportStatus } from "../app/services/imports/import-status.server";
import {
  createLogger,
  createSilentLogger,
  getRequestCorrelationId,
} from "../app/services/logging/logger.server";
import { confirmImportBatch } from "../app/services/orders/order-state.server";
import { ShopifyRateGate } from "../app/services/shopify/shopify-rate-gate.server";
import {
  processOrderJob,
  type OrderProcessorOptions,
} from "../worker/processors/order.processor";
import {
  createAsyncFailureInjector,
  injectedFailure,
  injectedResult,
} from "./helpers/failure-injection";

describe("Phase 7 observability and safe transport", () => {
  it("emits correlated JSON logs while redacting sensitive keys and values", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      now: () => new Date("2026-09-11T12:00:00.000Z"),
      write: (_level, line) => lines.push(line),
      context: { processRole: "worker" },
    });

    logger.info("Import failed for buyer@example.com; token=secret-value", {
      correlationId: "outbox-event-1",
      operationName: "order.create",
      shopId: "shop-1",
      orderIntentId: "intent-1",
      email: "buyer@example.com",
      shippingAddress: "100 Market Street",
      phone: "+1 512 555 0100",
      accessToken: "shpat_this-must-never-be-logged",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("buyer@example.com");
    expect(lines[0]).not.toContain("secret-value");
    expect(lines[0]).not.toContain("100 Market Street");
    expect(lines[0]).not.toContain("512 555 0100");
    expect(lines[0]).not.toContain("shpat_this-must-never-be-logged");
    expect(JSON.parse(lines[0])).toMatchObject({
      timestamp: "2026-09-11T12:00:00.000Z",
      level: "info",
      processRole: "worker",
      correlationId: "outbox-event-1",
      operationName: "order.create",
      email: "[REDACTED]",
      shippingAddress: "[REDACTED]",
      phone: "[REDACTED]",
      accessToken: "[REDACTED]",
    });
  });

  it("accepts safe inbound correlation IDs and replaces unsafe ones", () => {
    expect(
      getRequestCorrelationId(
        new Request("https://app.example.com", {
          headers: { "X-Correlation-ID": "request-123" },
        }),
      ),
    ).toBe("request-123");

    expect(
      getRequestCorrelationId(
        new Request("https://app.example.com", {
          headers: { "X-Correlation-ID": "buyer@example.com" },
        }),
      ),
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses the outbox event as correlation root and strips PII from queue payloads", () => {
    const descriptor = describeOutboxJob({
      id: "event-1",
      shopId: "shop-1",
      aggregateType: "OrderIntent",
      aggregateId: "intent-1",
      eventType: OUTBOX_EVENT_TYPES.orderCreate,
      payload: {
        orderIntentId: "intent-1",
        email: "buyer@example.com",
        shippingAddress: "100 Market Street",
        accessToken: "shpat_secret",
        rawCsv: "customer data",
      },
    });

    expect(descriptor.data.correlationId).toBe("event-1");
    expect(descriptor.data.payload).toEqual({ orderIntentId: "intent-1" });
    expect(JSON.stringify(descriptor.data)).not.toContain("buyer@example.com");
    expect(JSON.stringify(descriptor.data)).not.toContain("100 Market Street");
    expect(JSON.stringify(descriptor.data)).not.toContain("shpat_secret");
    expect(JSON.stringify(descriptor.data)).not.toContain("customer data");
  });
});

describe("Phase 7 sample imports and failure injection", () => {
  it("keeps the scripted failure sequence deterministic", async () => {
    const injector = createAsyncFailureInjector<[string], string>([
      injectedFailure(new Error("injected worker crash")),
      injectedResult("recovered"),
    ]);

    await expect(injector.invoke("first")).rejects.toThrow(
      "injected worker crash",
    );
    await expect(injector.invoke("second")).resolves.toBe("recovered");
    expect(injector.calls).toEqual([["first"], ["second"]]);
    expect(injector.remaining).toBe(0);
  });

  it("parses the valid, missing-SKU, and duplicate-identity samples", async () => {
    const valid = await parseExample("orders-valid.csv");
    const missing = await parseExample("orders-missing-sku.csv");
    const duplicateIdentity = await parseExample(
      "orders-duplicate-external-id.csv",
    );

    expect(valid).toHaveLength(2);
    expect(
      valid.find((order) => order.externalOrderId === "ERP-1001")?.lines,
    ).toHaveLength(2);
    expect(missing[0].lines[0].normalizedSku).toBe("SKU-NOT-IN-CATALOG");
    expect(duplicateIdentity[0].externalOrderId).toBe("ERP-1001");
    expect(duplicateIdentity[0].payloadHash).not.toBe(valid[0].payloadHash);
  });

  it("rejects the invalid sample with bounded safe field errors", async () => {
    await expect(parseExample("orders-invalid.csv")).rejects.toMatchObject({
      name: "ImportValidationError",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "processed_at" }),
        expect.objectContaining({ field: "email" }),
        expect.objectContaining({ field: "currency" }),
        expect.objectContaining({ field: "quantity" }),
        expect.objectContaining({ field: "unit_price" }),
      ]),
    } satisfies Partial<ImportValidationError>);
  });
});

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase("Phase 7 representative import pipeline", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterEach(async () => {
    await prisma.shop.deleteMany({
      where: { domain: { startsWith: "phase7-" } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("runs CSV validation through durable order completion with mocked Shopify", async () => {
    const domain = `phase7-${randomUUID()}.myshopify.com`;
    const shop = await prisma.shop.create({
      data: {
        domain,
        grantedScopes: "read_products,read_orders,write_orders",
      },
    });
    await prisma.catalogVariant.createMany({
      data: [
        catalogVariant(shop.id, "SKU-RED", "101"),
        catalogVariant(shop.id, "SKU-BLUE", "102"),
      ],
    });

    const orders = await parseExample("orders-valid.csv");
    const idempotencyKey = randomUUID();
    const created = await createDraftImport(prisma, {
      shopDomain: domain,
      grantedScopes: "read_products,read_orders,write_orders",
      sourceSystem: "demo-erp",
      originalFileName: "orders-valid.csv",
      idempotencyKey,
      orders,
    });
    const repeated = await createDraftImport(prisma, {
      shopDomain: domain,
      grantedScopes: "read_products,read_orders,write_orders",
      sourceSystem: "demo-erp",
      originalFileName: "orders-valid.csv",
      idempotencyKey,
      orders,
    });

    expect(created.created).toBe(true);
    expect(repeated).toMatchObject({
      created: false,
      batch: { id: created.batch.id },
    });

    await confirmImportBatch(prisma, {
      shopId: shop.id,
      batchId: created.batch.id,
      now: new Date("2026-09-11T12:00:00.000Z"),
    });
    const events = await prisma.outboxEvent.findMany({
      where: {
        shopId: shop.id,
        eventType: OUTBOX_EVENT_TYPES.orderCreate,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const graphql = createAsyncFailureInjector<
      [string, { variables?: Record<string, unknown> }?],
      { json(): Promise<unknown> }
    >([
      injectedResult(graphqlResponse("gid://shopify/Order/7001", "#7001")),
      injectedResult(graphqlResponse("gid://shopify/Order/7002", "#7002")),
    ]);
    const options = processorOptions(prisma, (query, requestOptions) =>
      graphql.invoke(query, requestOptions),
    );

    expect(events).toHaveLength(2);
    for (const event of events) {
      const descriptor = describeOutboxJob(event);
      expect(JSON.stringify(descriptor.data)).not.toContain("@example.com");
      await expect(
        processOrderJob(
          {
            id: descriptor.jobId,
            name: descriptor.jobName,
            data: descriptor.data,
            attemptsMade: 0,
          },
          options,
        ),
      ).resolves.toMatchObject({ status: "succeeded" });
    }

    expect(graphql.calls).toHaveLength(2);
    await expect(
      getImportStatus(prisma, {
        shopId: shop.id,
        batchId: created.batch.id,
      }),
    ).resolves.toMatchObject({
      status: "COMPLETED",
      terminal: true,
      counts: {
        total: 2,
        queued: 0,
        processing: 0,
        succeeded: 2,
        failed: 0,
        needsAttention: 0,
      },
    });

    const missingOrders = await parseExample("orders-missing-sku.csv");
    const missing = await createDraftImport(prisma, {
      shopDomain: domain,
      grantedScopes: "read_products,read_orders,write_orders",
      sourceSystem: "demo-erp",
      originalFileName: "orders-missing-sku.csv",
      idempotencyKey: randomUUID(),
      orders: missingOrders,
    });
    expect(missing.batch).toMatchObject({
      readyOrders: 0,
      needsAttentionOrders: 1,
    });

    const conflictingOrders = await parseExample(
      "orders-duplicate-external-id.csv",
    );
    await expect(
      createDraftImport(prisma, {
        shopDomain: domain,
        grantedScopes: "read_products,read_orders,write_orders",
        sourceSystem: "demo-erp",
        originalFileName: "orders-duplicate-external-id.csv",
        idempotencyKey: randomUUID(),
        orders: conflictingOrders,
      }),
    ).rejects.toBeInstanceOf(ExternalOrderConflictError);
  });
});

async function parseExample(name: string) {
  const contents = await readFile(
    new URL(`../examples/${name}`, import.meta.url),
    "utf8",
  );
  return parseImportCsv(new File([contents], name, { type: "text/csv" }), {
    maxBytes: 100_000,
    maxRows: 100,
  });
}

function catalogVariant(shopId: string, sku: string, numericId: string) {
  return {
    shopId,
    shopifyVariantGid: `gid://shopify/ProductVariant/${numericId}`,
    shopifyProductGid: "gid://shopify/Product/100",
    sku,
    normalizedSku: sku,
    productTitle: `Sample ${sku}`,
  };
}

function graphqlResponse(orderGid: string, orderName: string) {
  return {
    json: async () => ({
      data: {
        orderCreate: {
          order: { id: orderGid, name: orderName },
          userErrors: [],
        },
      },
    }),
  };
}

function processorOptions(
  prisma: PrismaClient,
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json(): Promise<unknown> }>,
): OrderProcessorOptions {
  const evalMock = async (script: string) =>
    script.includes("return { allowed") ? [1, 0, 80, 100, 2] : 1;

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
    now: () => new Date("2026-09-11T12:00:00.000Z"),
    random: () => 0,
    logger: createSilentLogger(),
  };
}
