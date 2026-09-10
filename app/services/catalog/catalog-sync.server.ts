import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { normalizeSku } from "./catalog-cache.server.js";
import { sanitizeErrorMessage } from "../logging/logger.server.js";

export interface ShopifyAdminGraphqlClient {
  graphql(
    query: string,
    options?: {
      variables?: Record<string, unknown>;
    },
  ): Promise<{
    json(): Promise<unknown>;
  }>;
}

export interface CatalogSyncOptions {
  prisma: PrismaClient;
  shopId: string;
  syncRunId: string;
  admin: ShopifyAdminGraphqlClient;
  pageSize: number;
  now?: () => Date;
}

export interface ProductRefreshOptions {
  prisma: PrismaClient;
  shopId: string;
  productGid: string;
  productNumericId?: string | null;
  deleted?: boolean;
  admin: ShopifyAdminGraphqlClient;
  pageSize: number;
  now?: () => Date;
}

const catalogVariantNodeSchema = z.object({
  id: z.string().min(1),
  sku: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]).nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  product: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().nullable().optional(),
    updatedAt: z.string().datetime().nullable().optional(),
  }),
});

const productVariantConnectionSchema = z.object({
  edges: z.array(
    z.object({
      cursor: z.string().nullable().optional(),
      node: catalogVariantNodeSchema,
    }),
  ),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable().optional(),
  }),
});

const catalogVariantsResponseSchema = z.object({
  data: z.object({
    productVariants: productVariantConnectionSchema,
  }),
  errors: z.unknown().optional(),
});

export const CATALOG_VARIANTS_QUERY = `#graphql
  query OrderRelayCatalogVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          sku
          title
          price
          updatedAt
          product {
            id
            title
            status
            updatedAt
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `#graphql
  query OrderRelayProductVariants(
    $first: Int!
    $after: String
    $query: String!
  ) {
    productVariants(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          sku
          title
          price
          updatedAt
          product {
            id
            title
            status
            updatedAt
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type CatalogVariantNode = z.infer<typeof catalogVariantNodeSchema>;

export async function runFullCatalogSync(options: CatalogSyncOptions): Promise<{
  status: "succeeded" | "already-completed";
  processedVariants: number;
}> {
  const now = options.now ?? (() => new Date());
  const run = await options.prisma.catalogSyncRun.findUniqueOrThrow({
    where: {
      id: options.syncRunId,
    },
    include: {
      shop: true,
    },
  });

  if (run.shopId !== options.shopId) {
    throw new Error("Catalog sync run does not belong to the requested shop");
  }

  if (run.status === "SUCCEEDED") {
    return {
      status: "already-completed",
      processedVariants: 0,
    };
  }

  let after = run.lastProcessedCursor;
  let processedVariants = 0;

  await options.prisma.$transaction([
    options.prisma.catalogSyncRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: "RUNNING",
        sanitizedLastError: null,
        lastErrorCategory: null,
      },
    }),
    options.prisma.shop.update({
      where: {
        id: options.shopId,
      },
      data: {
        catalogSyncStatus: "SYNCING",
      },
    }),
  ]);

  try {
    let hasNextPage = true;

    while (hasNextPage) {
      const page = await fetchCatalogVariantPage(options.admin, {
        query: CATALOG_VARIANTS_QUERY,
        variables: {
          first: options.pageSize,
          after,
        },
      });

      await options.prisma.$transaction(async (tx) => {
        for (const edge of page.edges) {
          await upsertCatalogVariant(tx, {
            shopId: options.shopId,
            node: edge.node,
            cachedAt: now(),
            lastSeenSyncRunId: run.id,
          });
        }

        await tx.catalogSyncRun.update({
          where: {
            id: run.id,
          },
          data: {
            lastProcessedCursor: page.pageInfo.endCursor ?? after,
          },
        });
      });

      processedVariants += page.edges.length;
      after = page.pageInfo.endCursor ?? null;
      hasNextPage = page.pageInfo.hasNextPage;
    }

    const completedAt = now();
    await options.prisma.$transaction([
      options.prisma.catalogVariant.updateMany({
        where: {
          shopId: options.shopId,
          deletedAt: null,
          OR: [
            {
              lastSeenSyncRunId: {
                not: run.id,
              },
            },
            {
              lastSeenSyncRunId: null,
            },
          ],
        },
        data: {
          deletedAt: completedAt,
        },
      }),
      options.prisma.catalogSyncRun.update({
        where: {
          id: run.id,
        },
        data: {
          status: "SUCCEEDED",
          completedAt,
          sanitizedLastError: null,
          lastErrorCategory: null,
        },
      }),
      options.prisma.shop.update({
        where: {
          id: options.shopId,
        },
        data: {
          catalogSyncStatus: "FRESH",
          lastCatalogSyncAt: completedAt,
        },
      }),
    ]);

    return {
      status: "succeeded",
      processedVariants,
    };
  } catch (error) {
    await markSyncFailed(options.prisma, {
      shopId: options.shopId,
      syncRunId: run.id,
      error,
    });

    throw error;
  }
}

export async function refreshCatalogProduct(
  options: ProductRefreshOptions,
): Promise<{ status: "refreshed" | "deleted"; processedVariants: number }> {
  const now = options.now ?? (() => new Date());

  if (options.deleted) {
    const deletedAt = now();
    await options.prisma.catalogVariant.updateMany({
      where: {
        shopId: options.shopId,
        shopifyProductGid: options.productGid,
        deletedAt: null,
      },
      data: {
        deletedAt,
        cachedAt: deletedAt,
      },
    });

    return {
      status: "deleted",
      processedVariants: 0,
    };
  }

  const productNumericId =
    options.productNumericId ?? extractNumericId(options.productGid);

  if (!productNumericId) {
    throw new Error("Product refresh requires a Shopify product ID");
  }

  const seenVariantGids = new Set<string>();
  let after: string | null = null;
  let hasNextPage = true;
  let processedVariants = 0;

  while (hasNextPage) {
    const page = await fetchCatalogVariantPage(options.admin, {
      query: PRODUCT_VARIANTS_QUERY,
      variables: {
        first: options.pageSize,
        after,
        query: `product_ids:${productNumericId}`,
      },
    });

    await options.prisma.$transaction(async (tx) => {
      for (const edge of page.edges) {
        seenVariantGids.add(edge.node.id);
        await upsertCatalogVariant(tx, {
          shopId: options.shopId,
          node: edge.node,
          cachedAt: now(),
        });
      }
    });

    processedVariants += page.edges.length;
    after = page.pageInfo.endCursor ?? null;
    hasNextPage = page.pageInfo.hasNextPage;
  }

  await options.prisma.catalogVariant.updateMany({
    where: {
      shopId: options.shopId,
      shopifyProductGid: options.productGid,
      deletedAt: null,
      shopifyVariantGid:
        seenVariantGids.size > 0
          ? {
              notIn: [...seenVariantGids],
            }
          : undefined,
    },
    data: {
      deletedAt: now(),
    },
  });

  return {
    status: "refreshed",
    processedVariants,
  };
}

async function fetchCatalogVariantPage(
  admin: ShopifyAdminGraphqlClient,
  input: {
    query: string;
    variables: Record<string, unknown>;
  },
) {
  const response = await admin.graphql(input.query, {
    variables: input.variables,
  });
  const body = await response.json();
  const parsed = catalogVariantsResponseSchema.parse(body);

  if (parsed.errors) {
    throw new Error("Shopify returned errors while syncing catalog variants");
  }

  return parsed.data.productVariants;
}

async function upsertCatalogVariant(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    node: CatalogVariantNode;
    cachedAt: Date;
    lastSeenSyncRunId?: string;
  },
) {
  const data = mapCatalogVariant(input);

  await tx.catalogVariant.upsert({
    where: {
      shopId_shopifyVariantGid: {
        shopId: input.shopId,
        shopifyVariantGid: input.node.id,
      },
    },
    create: data,
    update: {
      ...data,
      shopId: undefined,
      shopifyVariantGid: undefined,
      createdAt: undefined,
    },
  });
}

function mapCatalogVariant(input: {
  shopId: string;
  node: CatalogVariantNode;
  cachedAt: Date;
  lastSeenSyncRunId?: string;
}): Prisma.CatalogVariantUncheckedCreateInput {
  const sku = input.node.sku?.trim() || null;

  return {
    shopId: input.shopId,
    shopifyVariantGid: input.node.id,
    shopifyProductGid: input.node.product.id,
    sku,
    normalizedSku: normalizeSku(sku),
    variantTitle: input.node.title ?? null,
    productTitle: input.node.product.title,
    price:
      input.node.price === null || input.node.price === undefined
        ? null
        : String(input.node.price),
    productStatus: input.node.product.status ?? null,
    shopifyUpdatedAt: parseNullableDate(
      input.node.updatedAt ?? input.node.product.updatedAt,
    ),
    cachedAt: input.cachedAt,
    deletedAt: null,
    lastSeenSyncRunId: input.lastSeenSyncRunId,
  };
}

async function markSyncFailed(
  prisma: PrismaClient,
  input: {
    shopId: string;
    syncRunId: string;
    error: unknown;
  },
) {
  const failedAt = new Date();
  const shop = await prisma.shop.findUniqueOrThrow({
    where: {
      id: input.shopId,
    },
    select: {
      lastCatalogSyncAt: true,
    },
  });

  await prisma.$transaction([
    prisma.catalogSyncRun.update({
      where: {
        id: input.syncRunId,
      },
      data: {
        status: "FAILED",
        completedAt: failedAt,
        lastErrorCategory: "UNKNOWN",
        sanitizedLastError: sanitizeErrorMessage(input.error),
      },
    }),
    prisma.shop.update({
      where: {
        id: input.shopId,
      },
      data: {
        catalogSyncStatus: shop.lastCatalogSyncAt ? "STALE" : "FAILED",
      },
    }),
  ]);
}

function parseNullableDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function extractNumericId(gid: string): string | undefined {
  return gid.split("/").at(-1);
}
