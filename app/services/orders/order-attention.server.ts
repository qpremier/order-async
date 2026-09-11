import type { Prisma, PrismaClient } from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import {
  buildDescendingKeysetArgs,
  toKeysetPage,
} from "../pagination/cursor.server.js";
import {
  hasShopifyScope,
  type ShopifyCapability,
} from "../shops/shop-capabilities.server.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";
import { refreshLinkedBatches } from "./order-state.server.js";

export class AttentionRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "AttentionRequestError";
    this.status = status;
  }
}

export async function listNeedsAttentionPage(
  prisma: PrismaClient,
  options: { shopId: string; cursor?: string | null; first: number },
) {
  const keysetArgs = buildDescendingKeysetArgs(options);
  const intents = await prisma.orderIntent.findMany({
    where: {
      shopId: options.shopId,
      status: {
        in: [
          "NEEDS_MAPPING",
          "AMBIGUOUS_MAPPING",
          "AMBIGUOUS_RESULT",
          "DEAD_LETTER",
        ],
      },
      ...keysetArgs.where,
    },
    orderBy: keysetArgs.orderBy,
    take: keysetArgs.take,
    include: {
      originatingBatch: {
        select: { id: true, originalFileName: true },
      },
      orderLines: {
        select: { originalSku: true, validationStatus: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      deadLetterRecords: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
  });
  return toKeysetPage(intents, options.first);
}

export async function replayDeadLetterOrder(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    replayedBy: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const intent = await tx.orderIntent.findFirst({
      where: { id: input.orderIntentId, shopId: input.shopId },
      include: {
        shop: true,
        orderLines: true,
        deadLetterRecords: {
          where: { replayedAt: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
      },
    });
    if (!intent) throw new AttentionRequestError("Order not found.", 404);

    const deadLetter = intent.deadLetterRecords[0];
    if (intent.shopifyOrderGid || intent.status === "SUCCEEDED") {
      if (deadLetter) {
        await markDeadLetterReplayed(tx, deadLetter.id, input.replayedBy, now);
      }
      return { status: "already-succeeded" as const, orderIntentId: intent.id };
    }
    if (intent.status !== "DEAD_LETTER" || !deadLetter) {
      throw new AttentionRequestError("This order is not eligible for replay.");
    }
    assertShopCapability(intent.shop, "write_orders");
    await lockAvailableShop(tx, intent.shopId, now);
    await assertCurrentMappings(tx, intent.shopId, intent.orderLines);

    const claimed = await tx.orderIntent.updateMany({
      where: {
        id: intent.id,
        shopId: input.shopId,
        status: "DEAD_LETTER",
        shopifyOrderGid: null,
      },
      data: {
        status: "QUEUED",
        processingStartedAt: null,
        nextAttemptAt: null,
        lastErrorCategory: null,
        lastErrorCode: null,
        sanitizedLastError: null,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new AttentionRequestError("This order changed before replay.");
    }

    await markDeadLetterReplayed(tx, deadLetter.id, input.replayedBy, now);
    const event = await createOutboxEvent(tx, {
      shopId: input.shopId,
      aggregateType: "OrderIntent",
      aggregateId: intent.id,
      eventType: OUTBOX_EVENT_TYPES.deadLetterReplay,
      payload: {
        orderIntentId: intent.id,
        deadLetterRecordId: deadLetter.id,
      },
    });
    await refreshLinkedBatches(tx, intent.id, now);
    return {
      status: "queued" as const,
      orderIntentId: intent.id,
      outboxEventId: event.id,
    };
  });
}

export async function requestAmbiguousReconciliation(
  prisma: PrismaClient,
  input: { shopId: string; orderIntentId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const intent = await tx.orderIntent.findFirst({
      where: { id: input.orderIntentId, shopId: input.shopId },
      include: { shop: true },
    });
    if (!intent) throw new AttentionRequestError("Order not found.", 404);
    if (intent.shopifyOrderGid || intent.status === "SUCCEEDED") {
      return { status: "already-succeeded" as const, orderIntentId: intent.id };
    }
    if (intent.status !== "AMBIGUOUS_RESULT" || !intent.sourceIdentifier) {
      throw new AttentionRequestError(
        "This order is not eligible for reconciliation.",
      );
    }
    assertShopCapability(intent.shop, "read_orders");
    await lockAvailableShop(tx, intent.shopId, now);
    if (intent.processingStartedAt || intent.nextAttemptAt) {
      return { status: "already-scheduled" as const, orderIntentId: intent.id };
    }

    const claimed = await tx.orderIntent.updateMany({
      where: {
        id: intent.id,
        shopId: input.shopId,
        status: "AMBIGUOUS_RESULT",
        processingStartedAt: null,
        nextAttemptAt: null,
        shopifyOrderGid: null,
      },
      data: { nextAttemptAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      return { status: "already-scheduled" as const, orderIntentId: intent.id };
    }

    const event = await createOutboxEvent(tx, {
      shopId: input.shopId,
      aggregateType: "OrderIntent",
      aggregateId: intent.id,
      eventType: OUTBOX_EVENT_TYPES.orderReconcileAmbiguous,
      payload: { orderIntentId: intent.id, delayMs: 0 },
    });
    return {
      status: "queued" as const,
      orderIntentId: intent.id,
      outboxEventId: event.id,
    };
  });
}

async function lockAvailableShop(
  tx: Prisma.TransactionClient,
  shopId: string,
  now: Date,
) {
  const locked = await tx.shop.updateMany({
    where: { id: shopId, status: { not: "UNINSTALLED" } },
    data: { updatedAt: now },
  });
  if (locked.count !== 1) {
    throw new AttentionRequestError(
      "This shop is uninstalled, so order work cannot be replayed.",
    );
  }
}

function assertShopCapability(
  shop: { status: string; grantedScopes: string | null },
  requiredScope: ShopifyCapability,
) {
  if (shop.status === "UNINSTALLED") {
    throw new AttentionRequestError(
      "This shop is uninstalled, so order work cannot be replayed.",
    );
  }
  if (!hasShopifyScope(shop.grantedScopes, requiredScope)) {
    throw new AttentionRequestError(
      `Replay is paused until ${requiredScope} is granted.`,
    );
  }
}

async function assertCurrentMappings(
  tx: Prisma.TransactionClient,
  shopId: string,
  lines: Array<{
    shopifyVariantGid: string | null;
    validationStatus: string;
  }>,
) {
  const variantGids = lines.flatMap((line) =>
    line.shopifyVariantGid ? [line.shopifyVariantGid] : [],
  );
  if (
    lines.length === 0 ||
    lines.some(
      (line) => line.validationStatus !== "VALID" || !line.shopifyVariantGid,
    )
  ) {
    throw new AttentionRequestError(
      "Resolve the order's catalog mappings before replaying it.",
    );
  }
  const activeVariants = await tx.catalogVariant.count({
    where: {
      shopId,
      shopifyVariantGid: { in: [...new Set(variantGids)] },
      deletedAt: null,
    },
  });
  if (activeVariants !== new Set(variantGids).size) {
    throw new AttentionRequestError(
      "One or more mapped variants are no longer active. Resolve the mappings before replaying.",
    );
  }
}

function markDeadLetterReplayed(
  tx: Prisma.TransactionClient,
  deadLetterRecordId: string,
  replayedBy: string,
  now: Date,
) {
  return tx.deadLetterRecord.updateMany({
    where: { id: deadLetterRecordId, replayedAt: null },
    data: { replayedAt: now, replayedBy: replayedBy.slice(0, 100) },
  });
}
