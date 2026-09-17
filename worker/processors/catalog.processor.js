import { z } from "zod";
import { JOB_NAMES, queueJobDataSchema, } from "../../app/queues/jobs.js";
import { QUEUE_NAMES } from "../../app/queues/queue-names.js";
import { refreshCatalogProduct, runFullCatalogSync, } from "../../app/services/catalog/catalog-sync.server.js";
import { createSilentLogger, } from "../../app/services/logging/logger.server.js";
import { withShopifyRateGate, } from "../../app/services/shopify/shopify-rate-gate.server.js";
import { hasShopifyScope, withShopCapabilityGuard, } from "../../app/services/shops/shop-capabilities.server.js";
const catalogBootstrapPayloadSchema = z.object({
    syncRunId: z.string().min(1),
});
const catalogRefreshProductPayloadSchema = z.object({
    productGid: z.string().min(1),
    productNumericId: z.string().min(1).optional().nullable(),
    deleted: z.boolean().optional(),
    webhookReceiptId: z.string().min(1).optional(),
});
export async function processCatalogJob(job, options) {
    const data = queueJobDataSchema.parse(job.data);
    const logger = options.logger ?? createSilentLogger();
    if (job.name === JOB_NAMES.catalogBootstrap) {
        return processCatalogBootstrapJob(data, options, logger, job.id ?? null);
    }
    if (job.name === JOB_NAMES.catalogRefreshProduct) {
        return processCatalogRefreshProductJob(data, options, logger, job.id ?? null);
    }
    if (job.name === JOB_NAMES.catalogReconcile) {
        logger.info("catalog.reconcile.noop", {
            correlationId: data.correlationId ?? data.eventId,
            operationName: JOB_NAMES.catalogReconcile,
            queueName: QUEUE_NAMES.catalogSync,
            shopId: data.shopId,
            outboxEventId: data.eventId,
            jobId: job.id,
        });
        return {
            status: "handled",
            eventId: data.eventId,
        };
    }
    throw new Error(`Unsupported catalog job type: ${job.name}`);
}
async function processCatalogBootstrapJob(data, options, logger, jobId) {
    const payload = catalogBootstrapPayloadSchema.parse(data.payload);
    const shop = await options.prisma.shop.findUniqueOrThrow({
        where: {
            id: data.shopId,
        },
        select: {
            id: true,
            domain: true,
            status: true,
            grantedScopes: true,
        },
    });
    if (shop.status === "UNINSTALLED" ||
        !hasShopifyScope(shop.grantedScopes, "read_products")) {
        return { status: "blocked", eventId: data.eventId, processedVariants: 0 };
    }
    const { admin: rawAdmin } = await getUnauthenticatedAdmin(shop.domain);
    const guardedAdmin = withShopCapabilityGuard(rawAdmin, {
        prisma: options.prisma,
        shopId: shop.id,
        requiredScope: "read_products",
    });
    const admin = options.rateGate
        ? withShopifyRateGate(guardedAdmin, {
            rateGate: options.rateGate,
            shopId: shop.id,
            estimatedCost: options.estimatedQueryCost ?? 50,
            priority: "background",
        })
        : guardedAdmin;
    const result = await runFullCatalogSync({
        prisma: options.prisma,
        shopId: shop.id,
        syncRunId: payload.syncRunId,
        admin,
        pageSize: options.pageSize,
    });
    logger.info("catalog.bootstrap.handled", {
        correlationId: data.correlationId ?? data.eventId,
        operationName: JOB_NAMES.catalogBootstrap,
        queueName: QUEUE_NAMES.catalogSync,
        shopId: data.shopId,
        outboxEventId: data.eventId,
        jobId,
    });
    return {
        status: result.status,
        eventId: data.eventId,
        processedVariants: result.processedVariants,
    };
}
async function processCatalogRefreshProductJob(data, options, logger, jobId) {
    const payload = catalogRefreshProductPayloadSchema.parse(data.payload);
    const shop = await options.prisma.shop.findUniqueOrThrow({
        where: {
            id: data.shopId,
        },
        select: {
            id: true,
            domain: true,
            status: true,
            grantedScopes: true,
        },
    });
    if (shop.status === "UNINSTALLED" ||
        !hasShopifyScope(shop.grantedScopes, "read_products")) {
        return { status: "blocked", eventId: data.eventId, processedVariants: 0 };
    }
    const { admin: rawAdmin } = await getUnauthenticatedAdmin(shop.domain);
    const guardedAdmin = withShopCapabilityGuard(rawAdmin, {
        prisma: options.prisma,
        shopId: shop.id,
        requiredScope: "read_products",
    });
    const admin = options.rateGate
        ? withShopifyRateGate(guardedAdmin, {
            rateGate: options.rateGate,
            shopId: shop.id,
            estimatedCost: options.estimatedQueryCost ?? 50,
            priority: "background",
        })
        : guardedAdmin;
    const result = await refreshCatalogProduct({
        prisma: options.prisma,
        shopId: shop.id,
        productGid: payload.productGid,
        productNumericId: payload.productNumericId,
        deleted: payload.deleted,
        admin,
        pageSize: options.pageSize,
    });
    if (payload.webhookReceiptId) {
        await options.prisma.webhookReceipt.updateMany({
            where: {
                id: payload.webhookReceiptId,
                shopId: shop.id,
                processedAt: null,
            },
            data: {
                processedAt: new Date(),
                processingError: null,
            },
        });
    }
    logger.info("catalog.refresh_product.handled", {
        correlationId: data.correlationId ?? data.eventId,
        operationName: JOB_NAMES.catalogRefreshProduct,
        queueName: QUEUE_NAMES.catalogSync,
        shopId: data.shopId,
        outboxEventId: data.eventId,
        jobId,
    });
    return {
        status: result.status,
        eventId: data.eventId,
        processedVariants: result.processedVariants,
    };
}
async function getUnauthenticatedAdmin(shopDomain) {
    const { unauthenticated } = await import("../../app/shopify.server.js");
    return unauthenticated.admin(shopDomain);
}
