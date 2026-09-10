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
import { resolveCatalogSku } from "../app/services/catalog/catalog-cache.server";
import {
  runFullCatalogSync,
  type ShopifyAdminGraphqlClient,
} from "../app/services/catalog/catalog-sync.server";

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase("Phase 3 catalog synchronization", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });
  });

  afterEach(async () => {
    await prisma.shop.deleteMany({
      where: {
        domain: {
          startsWith: "phase3-",
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("syncs a full catalog across multiple Shopify cursor pages", async () => {
    const shop = await createShop(prisma);
    const syncRun = await prisma.catalogSyncRun.create({
      data: {
        shopId: shop.id,
      },
    });
    const admin = createMockAdmin([
      productVariantsResponse({
        edges: [
          variantEdge({
            cursor: "cursor-1",
            id: "gid://shopify/ProductVariant/1",
            sku: "SKU-1",
          }),
        ],
        hasNextPage: true,
        endCursor: "cursor-1",
      }),
      productVariantsResponse({
        edges: [
          variantEdge({
            cursor: "cursor-2",
            id: "gid://shopify/ProductVariant/2",
            sku: "SKU-2",
          }),
        ],
        hasNextPage: false,
        endCursor: "cursor-2",
      }),
    ]);

    const result = await runFullCatalogSync({
      prisma,
      shopId: shop.id,
      syncRunId: syncRun.id,
      admin,
      pageSize: 1,
      now: fixedNow,
    });

    const variants = await prisma.catalogVariant.findMany({
      where: {
        shopId: shop.id,
        deletedAt: null,
      },
      orderBy: {
        shopifyVariantGid: "asc",
      },
    });
    const completedRun = await prisma.catalogSyncRun.findUniqueOrThrow({
      where: {
        id: syncRun.id,
      },
    });
    const completedShop = await prisma.shop.findUniqueOrThrow({
      where: {
        id: shop.id,
      },
    });

    expect(result).toEqual({
      status: "succeeded",
      processedVariants: 2,
    });
    expect(admin.graphql).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({ after: null, first: 1 }),
      }),
    );
    expect(admin.graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({ after: "cursor-1", first: 1 }),
      }),
    );
    expect(variants.map((variant) => variant.normalizedSku)).toEqual([
      "SKU-1",
      "SKU-2",
    ]);
    expect(completedRun.status).toBe("SUCCEEDED");
    expect(completedRun.lastProcessedCursor).toBe("cursor-2");
    expect(completedShop.catalogSyncStatus).toBe("FRESH");
    expect(completedShop.lastCatalogSyncAt).toEqual(fixedNow());
  });

  it("resumes an interrupted catalog sync from the saved checkpoint", async () => {
    const shop = await createShop(prisma);
    const syncRun = await prisma.catalogSyncRun.create({
      data: {
        shopId: shop.id,
        lastProcessedCursor: "cursor-1",
      },
    });

    await prisma.catalogVariant.create({
      data: {
        shopId: shop.id,
        shopifyVariantGid: "gid://shopify/ProductVariant/1",
        shopifyProductGid: "gid://shopify/Product/1",
        sku: "SKU-1",
        normalizedSku: "SKU-1",
        productTitle: "Existing product",
        lastSeenSyncRunId: syncRun.id,
      },
    });

    const admin = createMockAdmin([
      productVariantsResponse({
        edges: [
          variantEdge({
            cursor: "cursor-2",
            id: "gid://shopify/ProductVariant/2",
            sku: "SKU-2",
          }),
        ],
        hasNextPage: false,
        endCursor: "cursor-2",
      }),
    ]);

    await runFullCatalogSync({
      prisma,
      shopId: shop.id,
      syncRunId: syncRun.id,
      admin,
      pageSize: 1,
      now: fixedNow,
    });

    const variants = await prisma.catalogVariant.findMany({
      where: {
        shopId: shop.id,
        deletedAt: null,
      },
      orderBy: {
        shopifyVariantGid: "asc",
      },
    });

    expect(admin.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        variables: expect.objectContaining({ after: "cursor-1" }),
      }),
    );
    expect(variants.map((variant) => variant.normalizedSku)).toEqual([
      "SKU-1",
      "SKU-2",
    ]);
  });

  it("preserves the previous cache when Shopify sync fails", async () => {
    const shop = await createShop(prisma, {
      catalogSyncStatus: "FRESH",
      lastCatalogSyncAt: new Date("2026-09-09T00:00:00.000Z"),
    });
    const syncRun = await prisma.catalogSyncRun.create({
      data: {
        shopId: shop.id,
      },
    });

    await prisma.catalogVariant.create({
      data: {
        shopId: shop.id,
        shopifyVariantGid: "gid://shopify/ProductVariant/old",
        shopifyProductGid: "gid://shopify/Product/old",
        sku: "OLD-SKU",
        normalizedSku: "OLD-SKU",
        productTitle: "Previous product",
      },
    });

    const admin = createThrowingAdmin(new Error("Shopify unavailable"));

    await expect(
      runFullCatalogSync({
        prisma,
        shopId: shop.id,
        syncRunId: syncRun.id,
        admin,
        pageSize: 10,
        now: fixedNow,
      }),
    ).rejects.toThrow("Shopify unavailable");

    const variant = await prisma.catalogVariant.findFirstOrThrow({
      where: {
        shopId: shop.id,
        shopifyVariantGid: "gid://shopify/ProductVariant/old",
      },
    });
    const failedRun = await prisma.catalogSyncRun.findUniqueOrThrow({
      where: {
        id: syncRun.id,
      },
    });
    const staleShop = await prisma.shop.findUniqueOrThrow({
      where: {
        id: shop.id,
      },
    });

    expect(variant.deletedAt).toBeNull();
    expect(failedRun.status).toBe("FAILED");
    expect(failedRun.sanitizedLastError).toContain("Shopify unavailable");
    expect(staleShop.catalogSyncStatus).toBe("STALE");
  });

  it("retains duplicate SKUs and reports them as ambiguous", async () => {
    const shop = await createShop(prisma);

    await prisma.catalogVariant.createMany({
      data: [
        {
          shopId: shop.id,
          shopifyVariantGid: "gid://shopify/ProductVariant/a",
          shopifyProductGid: "gid://shopify/Product/a",
          sku: "DUP",
          normalizedSku: "DUP",
          productTitle: "Product A",
        },
        {
          shopId: shop.id,
          shopifyVariantGid: "gid://shopify/ProductVariant/b",
          shopifyProductGid: "gid://shopify/Product/b",
          sku: "dup",
          normalizedSku: "DUP",
          productTitle: "Product B",
        },
      ],
    });

    const resolution = await resolveCatalogSku(prisma, {
      shopId: shop.id,
      sku: " dup ",
    });

    expect(resolution.status).toBe("ambiguous");
    expect(resolution.variants).toHaveLength(2);
  });
});

async function createShop(
  prisma: PrismaClient,
  overrides: {
    catalogSyncStatus?:
      "NEVER_SYNCED" | "SYNCING" | "FRESH" | "STALE" | "FAILED";
    lastCatalogSyncAt?: Date;
  } = {},
) {
  return prisma.shop.create({
    data: {
      domain: `phase3-${crypto.randomUUID()}.myshopify.com`,
      catalogSyncStatus: overrides.catalogSyncStatus ?? "NEVER_SYNCED",
      lastCatalogSyncAt: overrides.lastCatalogSyncAt,
    },
  });
}

function createMockAdmin(
  responses: unknown[],
): ShopifyAdminGraphqlClient & { graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn(async () => {
    const response = responses.shift();

    return {
      json: async () => response,
    };
  });

  return {
    graphql,
  };
}

function createThrowingAdmin(error: Error): ShopifyAdminGraphqlClient {
  return {
    graphql: vi.fn(async () => {
      throw error;
    }),
  };
}

function productVariantsResponse(input: {
  edges: Array<{
    cursor: string;
    node: Record<string, unknown>;
  }>;
  hasNextPage: boolean;
  endCursor: string | null;
}) {
  return {
    data: {
      productVariants: {
        edges: input.edges,
        pageInfo: {
          hasNextPage: input.hasNextPage,
          endCursor: input.endCursor,
        },
      },
    },
  };
}

function variantEdge(input: { cursor: string; id: string; sku: string }) {
  return {
    cursor: input.cursor,
    node: {
      id: input.id,
      sku: input.sku,
      title: "Default Title",
      price: "10.00",
      updatedAt: "2026-09-10T00:00:00.000Z",
      product: {
        id: "gid://shopify/Product/1",
        title: "Test product",
        status: "ACTIVE",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    },
  };
}

function fixedNow() {
  return new Date("2026-09-10T12:00:00.000Z");
}
