import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDraftImport,
  ExternalOrderConflictError,
  getImportDetails,
} from "../app/services/imports/import-domain.server";
import { parseImportCsv } from "../app/services/imports/import-parser.server";
import { applySkuMapping } from "../app/services/imports/sku-mapping.server";

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase("Phase 4 import domain", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  });

  afterEach(async () => {
    await prisma.shop.deleteMany({
      where: { domain: { startsWith: "phase4-" } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a DRAFT batch and blocks only orders with missing mappings", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    await createVariant(prisma, shop.id, "SKU-READY", "ready");
    const orders = await parseOrders([
      row("ready-order", "SKU-READY"),
      row("missing-order", "SKU-MISSING"),
    ]);

    const result = await createDraftImport(prisma, request(domain, orders));
    const intents = await prisma.orderIntent.findMany({
      where: { shopId: shop.id },
      orderBy: { externalOrderId: "asc" },
    });

    expect(result.batch).toMatchObject({
      status: "DRAFT",
      totalOrders: 2,
      readyOrders: 1,
      needsAttentionOrders: 1,
    });
    expect(
      intents.map((intent) => [intent.externalOrderId, intent.status]),
    ).toEqual([
      ["missing-order", "NEEDS_MAPPING"],
      ["ready-order", "READY"],
    ]);
  });

  it("requires explicit mapping for duplicate catalog SKUs and then unblocks the order", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    const firstVariant = await createVariant(prisma, shop.id, "DUP", "a");
    await createVariant(prisma, shop.id, "DUP", "b");
    const result = await createDraftImport(
      prisma,
      request(domain, await parseOrders([row("order-1", "dup")])),
    );

    expect(result.batch.needsAttentionOrders).toBe(1);
    expect(
      await prisma.orderIntent.findFirstOrThrow({ where: { shopId: shop.id } }),
    ).toMatchObject({ status: "AMBIGUOUS_MAPPING" });

    await applySkuMapping(prisma, {
      shopId: shop.id,
      batchId: result.batch.id,
      normalizedSku: "DUP",
      shopifyVariantGid: firstVariant.shopifyVariantGid,
    });

    expect(
      await prisma.orderIntent.findFirstOrThrow({ where: { shopId: shop.id } }),
    ).toMatchObject({ status: "READY" });
    expect(
      await prisma.importBatch.findUniqueOrThrow({
        where: { id: result.batch.id },
      }),
    ).toMatchObject({
      readyOrders: 1,
      needsAttentionOrders: 0,
    });
  });

  it("paginates order intents with opaque keyset cursors", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    await createVariant(prisma, shop.id, "SKU-1", "one");
    const result = await createDraftImport(
      prisma,
      request(
        domain,
        await parseOrders([row("order-1", "SKU-1"), row("order-2", "SKU-1")]),
      ),
    );

    const firstPage = await getImportDetails(prisma, {
      shopId: shop.id,
      batchId: result.batch.id,
      first: 1,
    });
    const secondPage = await getImportDetails(prisma, {
      shopId: shop.id,
      batchId: result.batch.id,
      cursor: firstPage?.intentsPage.endCursor,
      first: 1,
    });

    expect(firstPage?.intentsPage.hasNextPage).toBe(true);
    expect(firstPage?.intentsPage.endCursor).not.toContain("order-");
    expect(secondPage?.intentsPage.items[0].id).not.toBe(
      firstPage?.intentsPage.items[0].id,
    );
  });

  it("returns the original batch for repeated and concurrent idempotency keys", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    await createVariant(prisma, shop.id, "SKU-1", "one");
    const orders = await parseOrders([row("order-1", "SKU-1")]);
    const input = request(domain, orders);

    const [first, second] = await Promise.all([
      createDraftImport(prisma, input),
      createDraftImport(prisma, input),
    ]);
    const third = await createDraftImport(prisma, input);

    expect(
      new Set([first.batch.id, second.batch.id, third.batch.id]).size,
    ).toBe(1);
    expect(await prisma.importBatch.count({ where: { shopId: shop.id } })).toBe(
      1,
    );
  });

  it("reuses the same external order and hash in a later batch", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    await createVariant(prisma, shop.id, "SKU-1", "one");
    const orders = await parseOrders([row("order-1", "SKU-1")]);

    const first = await createDraftImport(prisma, request(domain, orders));
    const second = await createDraftImport(prisma, {
      ...request(domain, orders),
      idempotencyKey: crypto.randomUUID(),
    });

    expect(first.batch.id).not.toBe(second.batch.id);
    expect(second.reusedOrderCount).toBe(1);
    expect(await prisma.orderIntent.count({ where: { shopId: shop.id } })).toBe(
      1,
    );
    expect(await prisma.importBatchOrderIntent.count()).toBe(2);
  });

  it("raises a conflict instead of overwriting a changed external order", async () => {
    const domain = shopDomain();
    const shop = await prisma.shop.create({ data: { domain } });
    await createVariant(prisma, shop.id, "SKU-1", "one");
    await createDraftImport(
      prisma,
      request(domain, await parseOrders([row("order-1", "SKU-1", "10.00")])),
    );

    await expect(
      createDraftImport(prisma, {
        ...request(
          domain,
          await parseOrders([row("order-1", "SKU-1", "11.00")]),
        ),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ExternalOrderConflictError);
    expect(await prisma.importBatch.count({ where: { shopId: shop.id } })).toBe(
      1,
    );
  });

  it("prevents cross-shop details and mapping access", async () => {
    const victimDomain = shopDomain();
    const victim = await prisma.shop.create({ data: { domain: victimDomain } });
    const attacker = await prisma.shop.create({
      data: { domain: shopDomain() },
    });
    const variant = await createVariant(
      prisma,
      attacker.id,
      "SKU-X",
      "attacker",
    );
    const result = await createDraftImport(
      prisma,
      request(victimDomain, await parseOrders([row("order-1", "MISSING")])),
    );

    expect(
      await getImportDetails(prisma, {
        shopId: attacker.id,
        batchId: result.batch.id,
        first: 20,
      }),
    ).toBeNull();
    await expect(
      applySkuMapping(prisma, {
        shopId: attacker.id,
        batchId: result.batch.id,
        normalizedSku: "MISSING",
        shopifyVariantGid: variant.shopifyVariantGid,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(victim.id).not.toBe(attacker.id);
  });
});

const headers =
  "external_order_id,processed_at,email,currency,sku,quantity,unit_price";

function request(
  shopDomainValue: string,
  orders: Awaited<ReturnType<typeof parseOrders>>,
) {
  return {
    shopDomain: shopDomainValue,
    sourceSystem: "erp-main",
    originalFileName: "orders.csv",
    idempotencyKey: crypto.randomUUID(),
    orders,
  };
}

async function parseOrders(rows: string[]) {
  return parseImportCsv(
    new File([[headers, ...rows].join("\n")], "orders.csv"),
    {
      maxBytes: 100_000,
      maxRows: 100,
    },
  );
}

function row(externalOrderId: string, sku: string, price = "10.00") {
  return `${externalOrderId},2026-09-10T12:00:00Z,buyer@example.com,USD,${sku},1,${price}`;
}

function shopDomain() {
  return `phase4-${crypto.randomUUID()}.myshopify.com`;
}

function createVariant(
  prisma: PrismaClient,
  shopId: string,
  sku: string,
  suffix: string,
) {
  return prisma.catalogVariant.create({
    data: {
      shopId,
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}-${crypto.randomUUID()}`,
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
      sku,
      normalizedSku: sku.trim().toUpperCase(),
      productTitle: `Product ${suffix}`,
    },
  });
}
