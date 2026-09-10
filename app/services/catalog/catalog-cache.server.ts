import type { CatalogVariant, PrismaClient } from "@prisma/client";
import {
  buildDescendingKeysetArgs,
  toKeysetPage,
  type KeysetPage,
} from "../pagination/cursor.server.js";

export interface CatalogCacheStatus {
  status: string;
  lastCatalogSyncAt: Date | null;
  activeVariantCount: number;
  ambiguousSkuCount: number;
  runningSyncStartedAt: Date | null;
  isStale: boolean;
}

export type SkuResolution =
  | {
      status: "missing";
      normalizedSku: string;
      variants: [];
    }
  | {
      status: "unique";
      normalizedSku: string;
      variants: [CatalogVariant];
    }
  | {
      status: "ambiguous";
      normalizedSku: string;
      variants: CatalogVariant[];
    };

export function normalizeSku(sku: string | null | undefined): string | null {
  const normalized = sku?.trim().toUpperCase();

  return normalized ? normalized : null;
}

export async function getCatalogCacheStatus(
  prisma: PrismaClient,
  options: {
    shopId: string;
    staleAfterMinutes: number;
    now?: Date;
  },
): Promise<CatalogCacheStatus> {
  const [shop, activeVariantCount, duplicateGroups, runningSync] =
    await Promise.all([
      prisma.shop.findUniqueOrThrow({
        where: {
          id: options.shopId,
        },
        select: {
          catalogSyncStatus: true,
          lastCatalogSyncAt: true,
        },
      }),
      prisma.catalogVariant.count({
        where: {
          shopId: options.shopId,
          deletedAt: null,
        },
      }),
      prisma.catalogVariant.groupBy({
        by: ["normalizedSku"],
        where: {
          shopId: options.shopId,
          deletedAt: null,
          normalizedSku: {
            not: null,
          },
        },
        _count: {
          _all: true,
        },
        having: {
          normalizedSku: {
            _count: {
              gt: 1,
            },
          },
        },
      }),
      prisma.catalogSyncRun.findFirst({
        where: {
          shopId: options.shopId,
          status: "RUNNING",
        },
        orderBy: {
          startedAt: "desc",
        },
        select: {
          startedAt: true,
        },
      }),
    ]);

  const now = options.now ?? new Date();
  const staleCutoff = new Date(
    now.getTime() - options.staleAfterMinutes * 60_000,
  );
  const isStale =
    !shop.lastCatalogSyncAt ||
    shop.lastCatalogSyncAt.getTime() < staleCutoff.getTime();

  return {
    status: shop.catalogSyncStatus,
    lastCatalogSyncAt: shop.lastCatalogSyncAt,
    activeVariantCount,
    ambiguousSkuCount: duplicateGroups.length,
    runningSyncStartedAt: runningSync?.startedAt ?? null,
    isStale,
  };
}

export async function listCatalogVariantsPage(
  prisma: PrismaClient,
  options: {
    shopId: string;
    cursor?: string | null;
    first: number;
  },
): Promise<KeysetPage<CatalogVariant>> {
  const keysetArgs = buildDescendingKeysetArgs({
    cursor: options.cursor,
    first: options.first,
  });

  const variants = await prisma.catalogVariant.findMany({
    where: {
      shopId: options.shopId,
      deletedAt: null,
      ...keysetArgs.where,
    },
    orderBy: keysetArgs.orderBy,
    take: keysetArgs.take,
  });

  return toKeysetPage(variants, options.first);
}

export async function resolveCatalogSku(
  prisma: PrismaClient,
  options: {
    shopId: string;
    sku: string;
  },
): Promise<SkuResolution> {
  const normalizedSku = normalizeSku(options.sku);

  if (!normalizedSku) {
    return {
      status: "missing",
      normalizedSku: "",
      variants: [],
    };
  }

  const variants = await prisma.catalogVariant.findMany({
    where: {
      shopId: options.shopId,
      normalizedSku,
      deletedAt: null,
    },
    orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }, { id: "asc" }],
  });

  if (variants.length === 1) {
    return {
      status: "unique",
      normalizedSku,
      variants: [variants[0]],
    };
  }

  if (variants.length === 0) {
    return {
      status: "missing",
      normalizedSku,
      variants: [],
    };
  }

  return {
    status: "ambiguous",
    normalizedSku,
    variants,
  };
}
