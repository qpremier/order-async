import crypto from "node:crypto";
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
import { describeOutboxJob, OUTBOX_EVENT_TYPES } from "../app/queues/jobs";
import {
  nextImportPollDelay,
  shouldPollImport,
} from "../app/services/imports/import-polling";
import {
  buildImportStatusEtag,
  createImportStatusLoader,
  etagMatches,
} from "../app/services/imports/import-status.server";
import {
  replayDeadLetterOrder,
  requestAmbiguousReconciliation,
} from "../app/services/orders/order-attention.server";
import { markOrderIntentPermanentFailure } from "../app/services/orders/order-state.server";
import { syncAuthenticatedShop } from "../app/services/shops/shop-capabilities.server";
import {
  ingestAppLifecycleWebhook,
  processAppLifecycleWebhook,
} from "../app/services/webhooks/app-lifecycle.server";
import { processOrderJob } from "../worker/processors/order.processor";

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;
const fixedNow = new Date("2026-09-11T12:00:00.000Z");

describe("Phase 6 local status polling", () => {
  it("returns local status with an ETag and never calls Shopify GraphQL", async () => {
    const shopifyGraphql = vi.fn();
    const authenticateAdmin = vi.fn(async () => ({
      session: { shop: "phase6-status.myshopify.com" },
      admin: { graphql: shopifyGraphql },
    }));
    const findShop = vi.fn(async () => ({ id: "shop-1" }));
    const findBatch = vi.fn(async () => ({
      id: "batch-1",
      status: "PROCESSING",
      version: 7,
      totalOrders: 10,
      readyOrders: 0,
      queuedOrders: 2,
      processingOrders: 1,
      succeededOrders: 6,
      failedOrders: 0,
      needsAttentionOrders: 1,
      updatedAt: fixedNow,
    }));
    const loader = createImportStatusLoader({
      authenticateAdmin: authenticateAdmin as never,
      prisma: {
        shop: { findUnique: findShop },
        importBatch: { findFirst: findBatch },
      } as never,
    });

    const first = await loader({
      request: new Request(
        "https://example.com/app/api/imports/batch-1/status",
      ),
      params: { batchId: "batch-1" },
    });
    const etag = first.headers.get("ETag");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      id: "batch-1",
      status: "PROCESSING",
      counts: { total: 10, succeeded: 6 },
    });
    expect(shopifyGraphql).not.toHaveBeenCalled();

    const unchanged = await loader({
      request: new Request(
        "https://example.com/app/api/imports/batch-1/status",
        { headers: { "If-None-Match": etag! } },
      ),
      params: { batchId: "batch-1" },
    });
    expect(unchanged.status).toBe(304);
    expect(shopifyGraphql).not.toHaveBeenCalled();
  });

  it("matches weak and listed ETags and backs polling off until terminal", () => {
    const etag = buildImportStatusEtag({
      id: "batch-1",
      version: 2,
      updatedAt: fixedNow.toISOString(),
    });
    expect(etagMatches(`"old", W/${etag}`, etag)).toBe(true);
    expect(nextImportPollDelay(0)).toBe(1_500);
    expect(nextImportPollDelay(10)).toBe(15_000);
    expect(shouldPollImport("PROCESSING")).toBe(true);
    expect(shouldPollImport("COMPLETED")).toBe(false);
    expect(shouldPollImport("FAILED")).toBe(false);
    expect(shouldPollImport("CANCELLED")).toBe(false);
  });
});

describeIfDatabase("Phase 6 dead letter and webhook safety", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterEach(async () => {
    await prisma.shop.deleteMany({
      where: { domain: { startsWith: "phase6-" } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists permanent failures and replays the same order identity", async () => {
    const fixture = await createOrderFixture(prisma, "PROCESSING");
    const failed = await markOrderIntentPermanentFailure(prisma, {
      shopId: fixture.shopId,
      orderIntentId: fixture.orderIntentId,
      category: "SHOPIFY_USER_ERROR",
      code: "lineItems.0",
      message: "Shopify rejected this line item.",
      now: fixedNow,
    });
    expect(failed).toBe(true);

    const replay = await replayDeadLetterOrder(prisma, {
      shopId: fixture.shopId,
      orderIntentId: fixture.orderIntentId,
      replayedBy: "merchant",
      now: new Date(fixedNow.getTime() + 1_000),
    });
    const intent = await prisma.orderIntent.findUniqueOrThrow({
      where: { id: fixture.orderIntentId },
    });
    const records = await prisma.deadLetterRecord.findMany({
      where: { orderIntentId: fixture.orderIntentId },
    });
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: replay.outboxEventId },
    });

    expect(replay).toMatchObject({
      status: "queued",
      orderIntentId: fixture.orderIntentId,
    });
    expect(intent.id).toBe(fixture.orderIntentId);
    expect(intent.status).toBe("QUEUED");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      errorCategory: "SHOPIFY_USER_ERROR",
      replayedBy: "merchant",
    });
    expect(event.eventType).toBe(OUTBOX_EVENT_TYPES.deadLetterReplay);
    expect(describeOutboxJob(event).jobId).toBe(
      `dead-letter-replay__${event.id}`,
    );
    await expect(
      replayDeadLetterOrder(prisma, {
        shopId: fixture.shopId,
        orderIntentId: fixture.orderIntentId,
        replayedBy: "merchant",
        now: new Date(fixedNow.getTime() + 2_000),
      }),
    ).rejects.toThrow("not eligible for replay");
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: fixture.orderIntentId,
          eventType: OUTBOX_EVENT_TYPES.deadLetterReplay,
        },
      }),
    ).toBe(1);
  });

  it("does not enqueue a replay after the order already succeeded", async () => {
    const fixture = await createOrderFixture(prisma, "SUCCEEDED");
    await prisma.deadLetterRecord.create({
      data: {
        shopId: fixture.shopId,
        orderIntentId: fixture.orderIntentId,
        jobType: "order.create",
        errorCategory: "SHOPIFY_USER_ERROR",
        sanitizedMessage: "Historical failure.",
        attempts: 1,
        firstFailedAt: fixedNow,
        lastFailedAt: fixedNow,
      },
    });

    const result = await replayDeadLetterOrder(prisma, {
      shopId: fixture.shopId,
      orderIntentId: fixture.orderIntentId,
      replayedBy: "merchant",
      now: fixedNow,
    });
    expect(result.status).toBe("already-succeeded");
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: fixture.orderIntentId,
          eventType: OUTBOX_EVENT_TYPES.deadLetterReplay,
        },
      }),
    ).toBe(0);
  });

  it("queues only reconciliation for an ambiguous result", async () => {
    const fixture = await createOrderFixture(prisma, "AMBIGUOUS_RESULT");
    const result = await requestAmbiguousReconciliation(prisma, {
      shopId: fixture.shopId,
      orderIntentId: fixture.orderIntentId,
      now: fixedNow,
    });
    const event = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: result.outboxEventId },
    });
    expect(event.eventType).toBe(OUTBOX_EVENT_TYPES.orderReconcileAmbiguous);
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: fixture.orderIntentId,
          eventType: OUTBOX_EVENT_TYPES.orderCreate,
        },
      }),
    ).toBe(0);
  });

  it("deduplicates scope webhooks and pauses queued order work", async () => {
    const fixture = await createOrderFixture(prisma, "QUEUED");
    const payload = { current: ["read_orders", "read_products"] };
    const first = await ingestAppLifecycleWebhook(prisma, {
      shopDomain: fixture.shopDomain,
      topic: "APP_SCOPES_UPDATE",
      webhookId: "scope-delivery-1",
      payload,
      now: fixedNow,
    });
    const duplicate = await ingestAppLifecycleWebhook(prisma, {
      shopDomain: fixture.shopDomain,
      topic: "APP_SCOPES_UPDATE",
      webhookId: "scope-delivery-1",
      payload,
      now: fixedNow,
    });
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { id: fixture.shopId },
    });
    expect(first.status).toBe("accepted");
    expect(duplicate.status).toBe("duplicate");
    expect(shop.status).toBe("NEEDS_REAUTH");
    expect(
      await prisma.webhookReceipt.count({
        where: { shopId: fixture.shopId, webhookId: "scope-delivery-1" },
      }),
    ).toBe(1);

    if (first.status !== "accepted") throw new Error("expected accepted");
    await processAppLifecycleWebhook(prisma, {
      shopId: fixture.shopId,
      webhookReceiptId: first.webhookReceiptId,
      now: fixedNow,
    });
    const intent = await prisma.orderIntent.findUniqueOrThrow({
      where: { id: fixture.orderIntentId },
    });
    expect(intent).toMatchObject({
      status: "RETRY_WAIT",
      lastErrorCategory: "MISSING_SCOPE",
      attemptCount: 0,
    });

    const getAdmin = vi.fn();
    await expect(
      processOrderJob(orderJob(fixture), {
        prisma,
        rateGate: {} as never,
        orderCreateEstimatedCost: 20,
        orderReconcileEstimatedCost: 10,
        reconciliationDelayMs: 5_000,
        reconciliationMaxAttempts: 3,
        processingLeaseMs: 300_000,
        getAdmin,
        now: () => fixedNow,
      }),
    ).rejects.toMatchObject({ name: "OrderWorkDeferredError" });
    expect(getAdmin).not.toHaveBeenCalled();

    const restored = await ingestAppLifecycleWebhook(prisma, {
      shopDomain: fixture.shopDomain,
      topic: "APP_SCOPES_UPDATE",
      webhookId: "scope-delivery-2",
      payload: {
        current: ["read_orders", "read_products", "write_orders"],
      },
      now: new Date(fixedNow.getTime() + 1_000),
    });
    if (restored.status !== "accepted") throw new Error("expected accepted");
    await processAppLifecycleWebhook(prisma, {
      shopId: fixture.shopId,
      webhookReceiptId: restored.webhookReceiptId,
      now: new Date(fixedNow.getTime() + 1_000),
    });
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: fixture.orderIntentId,
          eventType: OUTBOX_EVENT_TYPES.orderCreate,
        },
      }),
    ).toBe(1);
  });

  it("blocks all new Shopify calls and cancels active imports after uninstall", async () => {
    const fixture = await createOrderFixture(prisma, "QUEUED");
    const accepted = await ingestAppLifecycleWebhook(prisma, {
      shopDomain: fixture.shopDomain,
      topic: "APP_UNINSTALLED",
      webhookId: "uninstall-delivery-1",
      payload: { id: 1 },
      now: fixedNow,
    });
    if (accepted.status !== "accepted") throw new Error("expected accepted");

    const racedAuthenticatedRequest = await syncAuthenticatedShop(prisma, {
      shopDomain: fixture.shopDomain,
      grantedScopes: "read_products,read_orders,write_orders",
    });
    expect(racedAuthenticatedRequest.status).toBe("UNINSTALLED");

    const getAdmin = vi.fn();
    const result = await processOrderJob(orderJob(fixture), {
      prisma,
      rateGate: {} as never,
      orderCreateEstimatedCost: 20,
      orderReconcileEstimatedCost: 10,
      reconciliationDelayMs: 5_000,
      reconciliationMaxAttempts: 3,
      processingLeaseMs: 300_000,
      getAdmin,
      now: () => fixedNow,
    });
    expect(result.status).toBe("cancelled");
    expect(getAdmin).not.toHaveBeenCalled();

    await processAppLifecycleWebhook(prisma, {
      shopId: fixture.shopId,
      webhookReceiptId: accepted.webhookReceiptId,
      now: fixedNow,
    });
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: fixture.batchId },
    });
    const shop = await prisma.shop.findUniqueOrThrow({
      where: { id: fixture.shopId },
    });
    expect(shop.status).toBe("UNINSTALLED");
    expect(batch.status).toBe("CANCELLED");
  });
});

async function createOrderFixture(
  prisma: PrismaClient,
  status: "PROCESSING" | "QUEUED" | "SUCCEEDED" | "AMBIGUOUS_RESULT",
) {
  const shopDomain = `phase6-${crypto.randomUUID()}.myshopify.com`;
  const shop = await prisma.shop.create({
    data: {
      domain: shopDomain,
      status: "ACTIVE",
      grantedScopes: "read_products,read_orders,write_orders",
    },
  });
  const variantGid = `gid://shopify/ProductVariant/${crypto.randomUUID()}`;
  await prisma.catalogVariant.create({
    data: {
      shopId: shop.id,
      shopifyVariantGid: variantGid,
      shopifyProductGid: `gid://shopify/Product/${crypto.randomUUID()}`,
      sku: "SAFE-SKU",
      normalizedSku: "SAFE-SKU",
      productTitle: "Safe product",
    },
  });
  const batch = await prisma.importBatch.create({
    data: {
      shopId: shop.id,
      sourceSystem: "phase6",
      originalFileName: "phase6.csv",
      idempotencyKey: crypto.randomUUID(),
      status: status === "SUCCEEDED" ? "COMPLETED" : "QUEUED",
      totalOrders: 1,
      queuedOrders: status === "QUEUED" ? 1 : 0,
      processingOrders: status === "PROCESSING" ? 1 : 0,
      succeededOrders: status === "SUCCEEDED" ? 1 : 0,
      needsAttentionOrders: status === "AMBIGUOUS_RESULT" ? 1 : 0,
      confirmedAt: fixedNow,
      completedAt: status === "SUCCEEDED" ? fixedNow : null,
    },
  });
  const intent = await prisma.orderIntent.create({
    data: {
      shopId: shop.id,
      importBatchId: batch.id,
      sourceSystem: "phase6",
      externalOrderId: crypto.randomUUID(),
      payloadHash: crypto.randomUUID().replaceAll("-", ""),
      sourceIdentifier: `orderrelay:phase6:${crypto.randomUUID()}`,
      processedAt: fixedNow,
      email: "not-returned@example.com",
      currency: "USD",
      status,
      processingStartedAt: status === "PROCESSING" ? fixedNow : null,
      shopifyOrderGid:
        status === "SUCCEEDED" ? "gid://shopify/Order/123" : null,
      shopifyOrderName: status === "SUCCEEDED" ? "#123" : null,
      succeededAt: status === "SUCCEEDED" ? fixedNow : null,
      orderLines: {
        create: {
          shopId: shop.id,
          originalSku: "SAFE-SKU",
          normalizedSku: "SAFE-SKU",
          shopifyVariantGid: variantGid,
          quantity: 1,
          unitPrice: "10.00",
          validationStatus: "VALID",
        },
      },
      importBatchLinks: {
        create: { importBatchId: batch.id },
      },
    },
  });
  return {
    shopId: shop.id,
    shopDomain,
    batchId: batch.id,
    orderIntentId: intent.id,
  };
}

function orderJob(fixture: { shopId: string; orderIntentId: string }) {
  return {
    id: "phase6-order-job",
    name: "order.create",
    data: {
      eventId: "phase6-event",
      shopId: fixture.shopId,
      aggregateType: "OrderIntent",
      aggregateId: fixture.orderIntentId,
      eventType: OUTBOX_EVENT_TYPES.orderCreate,
      payload: { orderIntentId: fixture.orderIntentId },
      operationName: "order.create",
      enqueuedAt: fixedNow.toISOString(),
    },
  };
}
