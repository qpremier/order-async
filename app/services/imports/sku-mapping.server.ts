import { type OrderIntentStatus, type PrismaClient } from "@prisma/client";
import {
  aggregateStatuses,
  ImportRequestError,
} from "./import-domain.server.js";

export async function applySkuMapping(
  prisma: PrismaClient,
  input: {
    shopId: string;
    batchId: string;
    normalizedSku: string;
    shopifyVariantGid: string;
  },
) {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findFirst({
      where: { id: input.batchId, shopId: input.shopId, status: "DRAFT" },
    });
    if (!batch) {
      throw new ImportRequestError("Import not found or no longer editable.", {
        status: 404,
      });
    }

    const normalizedSku = input.normalizedSku.trim().toUpperCase();
    const lines = await tx.orderLine.findMany({
      where: {
        shopId: input.shopId,
        normalizedSku,
        orderIntent: {
          importBatchLinks: { some: { importBatchId: batch.id } },
        },
      },
      select: { orderIntentId: true, originalSku: true },
    });
    if (lines.length === 0) {
      throw new ImportRequestError("The SKU is not part of this import.", {
        status: 404,
      });
    }

    const variant = await tx.catalogVariant.findFirst({
      where: {
        shopId: input.shopId,
        shopifyVariantGid: input.shopifyVariantGid,
        deletedAt: null,
      },
    });
    if (!variant) {
      throw new ImportRequestError("Choose an active catalog variant.");
    }

    await tx.skuMapping.upsert({
      where: {
        shopId_sourceSystem_normalizedExternalSku: {
          shopId: input.shopId,
          sourceSystem: batch.sourceSystem,
          normalizedExternalSku: normalizedSku,
        },
      },
      create: {
        shopId: input.shopId,
        sourceSystem: batch.sourceSystem,
        externalSku: lines[0].originalSku,
        normalizedExternalSku: normalizedSku,
        shopifyVariantGid: variant.shopifyVariantGid,
      },
      update: {
        externalSku: lines[0].originalSku,
        shopifyVariantGid: variant.shopifyVariantGid,
      },
    });

    await tx.orderLine.updateMany({
      where: {
        shopId: input.shopId,
        normalizedSku,
        orderIntent: {
          importBatchLinks: { some: { importBatchId: batch.id } },
        },
      },
      data: {
        shopifyVariantGid: variant.shopifyVariantGid,
        validationStatus: "VALID",
        validationMessage: null,
      },
    });

    const affectedIntentIds = [
      ...new Set(lines.map((line) => line.orderIntentId)),
    ];
    for (const orderIntentId of affectedIntentIds) {
      const remainingLines = await tx.orderLine.findMany({
        where: { shopId: input.shopId, orderIntentId },
        select: { validationStatus: true },
      });
      const status = statusFromValidation(
        remainingLines.map((line) => line.validationStatus),
      );
      await tx.orderIntent.updateMany({
        where: {
          id: orderIntentId,
          shopId: input.shopId,
          status: { in: ["NEEDS_MAPPING", "AMBIGUOUS_MAPPING", "READY"] },
        },
        data: { status, version: { increment: 1 } },
      });
    }

    const linkedIntents = await tx.orderIntent.findMany({
      where: {
        shopId: input.shopId,
        importBatchLinks: { some: { importBatchId: batch.id } },
      },
      select: { status: true },
    });
    await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        ...aggregateStatuses(linkedIntents.map((intent) => intent.status)),
        version: { increment: 1 },
      },
    });

    return { normalizedSku, shopifyVariantGid: variant.shopifyVariantGid };
  });
}

function statusFromValidation(
  statuses: Array<
    "UNVALIDATED" | "VALID" | "NEEDS_MAPPING" | "AMBIGUOUS_MAPPING" | "INVALID"
  >,
): OrderIntentStatus {
  if (
    statuses.some((status) => status === "INVALID" || status === "UNVALIDATED")
  ) {
    return "INVALID";
  }
  if (statuses.some((status) => status === "AMBIGUOUS_MAPPING")) {
    return "AMBIGUOUS_MAPPING";
  }
  if (statuses.some((status) => status === "NEEDS_MAPPING")) {
    return "NEEDS_MAPPING";
  }
  return "READY";
}
