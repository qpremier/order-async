import { buildDescendingKeysetArgs, toKeysetPage, } from "../pagination/cursor.server.js";
export function normalizeSku(sku) {
    const normalized = sku?.trim().toUpperCase();
    return normalized ? normalized : null;
}
/**
 * Returns the catalog keys that are safe to consider equivalent to an
 * imported SKU. Spreadsheet exports sometimes retain the leading apostrophe
 * used to force an all-numeric value to text (for example, `'1901743`). That
 * marker is not part of the merchant's numeric SKU.
 *
 * Only all-numeric values receive this alias. Meaningful punctuation on
 * alphanumeric SKUs remains part of the SKU and therefore requires mapping.
 */
export function skuMatchKeys(sku) {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku)
        return [];
    if (/^'\d+$/.test(normalizedSku)) {
        return [normalizedSku, normalizedSku.slice(1)];
    }
    return [normalizedSku];
}
export async function getCatalogCacheStatus(prisma, options) {
    const [shop, activeVariantCount, duplicateGroups, runningSync] = await Promise.all([
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
    const staleCutoff = new Date(now.getTime() - options.staleAfterMinutes * 60_000);
    const isStale = !shop.lastCatalogSyncAt ||
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
export async function listCatalogVariantsPage(prisma, options) {
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
export async function resolveCatalogSku(prisma, options) {
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
            normalizedSku: { in: skuMatchKeys(normalizedSku) },
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
