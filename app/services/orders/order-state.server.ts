import { createHash } from "node:crypto";
import {
  type ErrorCategory,
  type ImportBatchStatus,
  type OrderIntentStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import {
  ImportRequestError,
  aggregateStatuses,
} from "../imports/import-domain.server.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";

type TransactionClient = Prisma.TransactionClient;

export interface ConfirmImportBatchResult {
  batchId: string;
  status: ImportBatchStatus;
  queuedOrderIntentIds: string[];
  alreadyConfirmed: boolean;
}

export function buildOrderSourceIdentifier(
  sourceSystem: string,
  externalOrderId: string,
): string {
  const digest = createHash("sha256")
    .update(externalOrderId, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `orderrelay:${sourceSystem}:${digest}`;
}

export async function confirmImportBatch(
  prisma: PrismaClient,
  input: { shopId: string; batchId: string; now?: Date },
): Promise<ConfirmImportBatchResult> {
  const now = input.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findFirst({
      where: { id: input.batchId, shopId: input.shopId },
      select: { id: true, status: true, confirmedAt: true },
    });
    if (!batch) {
      throw new ImportRequestError("Import not found.", { status: 404 });
    }
    if (batch.confirmedAt) {
      return {
        batchId: batch.id,
        status: batch.status,
        queuedOrderIntentIds: [],
        alreadyConfirmed: true,
      };
    }
    if (batch.status !== "DRAFT") {
      throw new ImportRequestError("This import cannot be confirmed.", {
        status: 409,
      });
    }

    const intents = await tx.orderIntent.findMany({
      where: {
        shopId: input.shopId,
        importBatchLinks: { some: { importBatchId: batch.id } },
      },
      select: {
        id: true,
        sourceSystem: true,
        externalOrderId: true,
        status: true,
        shopifyOrderGid: true,
      },
    });
    const allowedStatuses: OrderIntentStatus[] = [
      "READY",
      "QUEUED",
      "PROCESSING",
      "RETRY_WAIT",
      "AMBIGUOUS_RESULT",
      "SUCCEEDED",
    ];
    const canConfirm =
      intents.length > 0 &&
      intents.every(
        (intent) =>
          allowedStatuses.includes(intent.status) ||
          Boolean(intent.shopifyOrderGid),
      ) &&
      intents.some(
        (intent) =>
          intent.status === "READY" ||
          intent.status === "QUEUED" ||
          intent.status === "PROCESSING" ||
          intent.status === "RETRY_WAIT" ||
          intent.status === "AMBIGUOUS_RESULT" ||
          intent.status === "SUCCEEDED" ||
          Boolean(intent.shopifyOrderGid),
      );
    if (!canConfirm) {
      throw new ImportRequestError(
        "Resolve all blocked orders before confirming this import.",
      );
    }

    const queuedOrderIntentIds: string[] = [];
    for (const intent of intents) {
      if (intent.status !== "READY" || intent.shopifyOrderGid) continue;

      const sourceIdentifier = buildOrderSourceIdentifier(
        intent.sourceSystem,
        intent.externalOrderId,
      );
      const claimed = await tx.orderIntent.updateMany({
        where: {
          id: intent.id,
          shopId: input.shopId,
          status: "READY",
          shopifyOrderGid: null,
        },
        data: {
          status: "QUEUED",
          sourceIdentifier,
          nextAttemptAt: null,
          lastErrorCategory: null,
          lastErrorCode: null,
          sanitizedLastError: null,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;

      await createOutboxEvent(tx, {
        shopId: input.shopId,
        aggregateType: "OrderIntent",
        aggregateId: intent.id,
        eventType: OUTBOX_EVENT_TYPES.orderCreate,
        payload: { orderIntentId: intent.id },
      });
      queuedOrderIntentIds.push(intent.id);
    }

    const updatedBatch = await refreshBatch(tx, batch.id, now, {
      confirmedAt: now,
    });
    return {
      batchId: batch.id,
      status: updatedBatch.status,
      queuedOrderIntentIds,
      alreadyConfirmed: false,
    };
  });
}

export async function claimOrderIntentForProcessing(
  prisma: PrismaClient,
  input: { shopId: string; orderIntentId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const claimed = await prisma.orderIntent.updateMany({
    where: {
      id: input.orderIntentId,
      shopId: input.shopId,
      shopifyOrderGid: null,
      OR: [
        { status: "QUEUED" },
        {
          status: "RETRY_WAIT",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
      ],
    },
    data: {
      status: "PROCESSING",
      processingStartedAt: now,
      nextAttemptAt: null,
      attemptCount: { increment: 1 },
      version: { increment: 1 },
    },
  });

  if (claimed.count !== 1) return null;
  return prisma.orderIntent.findFirst({
    where: { id: input.orderIntentId, shopId: input.shopId },
    include: {
      shop: true,
      orderLines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
}

export async function deferOrderIntentWithoutClaim(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    category: ErrorCategory;
    code: string;
    message: string;
    nextAttemptAt: Date;
  },
) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.orderIntent.updateMany({
      where: {
        id: input.orderIntentId,
        shopId: input.shopId,
        status: { in: ["QUEUED", "RETRY_WAIT"] },
        shopifyOrderGid: null,
      },
      data: {
        status: "RETRY_WAIT",
        lastErrorCategory: input.category,
        lastErrorCode: input.code,
        sanitizedLastError: input.message,
        nextAttemptAt: input.nextAttemptAt,
        processingStartedAt: null,
        version: { increment: 1 },
      },
    });
    if (updated.count === 1) {
      await refreshLinkedBatches(tx, input.orderIntentId, new Date());
    }
    return updated.count === 1;
  });
}

export async function scheduleOrderIntentRetry(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    category: ErrorCategory;
    code?: string | null;
    message: string;
    nextAttemptAt: Date;
  },
) {
  return updateIntentAndBatches(prisma, input.orderIntentId, async (tx) =>
    tx.orderIntent.updateMany({
      where: {
        id: input.orderIntentId,
        shopId: input.shopId,
        status: "PROCESSING",
        shopifyOrderGid: null,
      },
      data: {
        status: "RETRY_WAIT",
        lastErrorCategory: input.category,
        lastErrorCode: input.code ?? null,
        sanitizedLastError: input.message,
        nextAttemptAt: input.nextAttemptAt,
        processingStartedAt: null,
        version: { increment: 1 },
      },
    }),
  );
}

export async function markOrderIntentSucceeded(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    shopifyOrderGid: string;
    shopifyOrderName: string;
    now?: Date;
    allowedStatuses?: OrderIntentStatus[];
  },
) {
  const now = input.now ?? new Date();
  return updateIntentAndBatches(prisma, input.orderIntentId, async (tx) =>
    tx.orderIntent.updateMany({
      where: {
        id: input.orderIntentId,
        shopId: input.shopId,
        status: {
          in: input.allowedStatuses ?? ["PROCESSING", "AMBIGUOUS_RESULT"],
        },
        shopifyOrderGid: null,
      },
      data: {
        status: "SUCCEEDED",
        shopifyOrderGid: input.shopifyOrderGid,
        shopifyOrderName: input.shopifyOrderName,
        succeededAt: now,
        processingStartedAt: null,
        nextAttemptAt: null,
        lastErrorCategory: null,
        lastErrorCode: null,
        sanitizedLastError: null,
        version: { increment: 1 },
      },
    }),
  );
}

export async function markOrderIntentPermanentFailure(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    category: ErrorCategory;
    code?: string | null;
    message: string;
  },
) {
  return updateIntentAndBatches(prisma, input.orderIntentId, async (tx) =>
    tx.orderIntent.updateMany({
      where: {
        id: input.orderIntentId,
        shopId: input.shopId,
        status: "PROCESSING",
        shopifyOrderGid: null,
      },
      data: {
        status: "DEAD_LETTER",
        lastErrorCategory: input.category,
        lastErrorCode: input.code ?? null,
        sanitizedLastError: input.message,
        processingStartedAt: null,
        nextAttemptAt: null,
        version: { increment: 1 },
      },
    }),
  );
}

export async function markOrderIntentAmbiguous(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    message: string;
    reconcileDelayMs: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.orderIntent.updateMany({
      where: {
        id: input.orderIntentId,
        shopId: input.shopId,
        status: "PROCESSING",
        shopifyOrderGid: null,
      },
      data: {
        status: "AMBIGUOUS_RESULT",
        lastErrorCategory: "AMBIGUOUS_WRITE_RESULT",
        lastErrorCode: "INCONCLUSIVE_RESPONSE",
        sanitizedLastError: input.message,
        processingStartedAt: null,
        nextAttemptAt: new Date(now.getTime() + input.reconcileDelayMs),
        version: { increment: 1 },
      },
    });
    if (updated.count === 1) {
      await createOutboxEvent(tx, {
        shopId: input.shopId,
        aggregateType: "OrderIntent",
        aggregateId: input.orderIntentId,
        eventType: OUTBOX_EVENT_TYPES.orderReconcileAmbiguous,
        payload: {
          orderIntentId: input.orderIntentId,
          delayMs: input.reconcileDelayMs,
        },
      });
      await refreshLinkedBatches(tx, input.orderIntentId, now);
    }
    return updated.count === 1;
  });
}

export async function claimOrderIntentForReconciliation(
  prisma: PrismaClient,
  input: { shopId: string; orderIntentId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const claimed = await prisma.orderIntent.updateMany({
    where: {
      id: input.orderIntentId,
      shopId: input.shopId,
      status: "AMBIGUOUS_RESULT",
      shopifyOrderGid: null,
      processingStartedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    data: {
      processingStartedAt: now,
      nextAttemptAt: null,
      reconciliationAttemptCount: { increment: 1 },
      version: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;
  return prisma.orderIntent.findFirst({
    where: { id: input.orderIntentId, shopId: input.shopId },
    include: { shop: true },
  });
}

export async function releaseOrderIntentReconciliation(
  prisma: PrismaClient,
  input: {
    shopId: string;
    orderIntentId: string;
    message: string;
    nextAttemptAt: Date | null;
  },
) {
  return prisma.orderIntent.updateMany({
    where: {
      id: input.orderIntentId,
      shopId: input.shopId,
      status: "AMBIGUOUS_RESULT",
      shopifyOrderGid: null,
    },
    data: {
      processingStartedAt: null,
      nextAttemptAt: input.nextAttemptAt,
      sanitizedLastError: input.message,
      version: { increment: 1 },
    },
  });
}

async function updateIntentAndBatches(
  prisma: PrismaClient,
  orderIntentId: string,
  update: (tx: TransactionClient) => Promise<{ count: number }>,
) {
  return prisma.$transaction(async (tx) => {
    const result = await update(tx);
    if (result.count === 1) {
      await refreshLinkedBatches(tx, orderIntentId, new Date());
    }
    return result.count === 1;
  });
}

async function refreshLinkedBatches(
  tx: TransactionClient,
  orderIntentId: string,
  now: Date,
) {
  const links = await tx.importBatchOrderIntent.findMany({
    where: { orderIntentId },
    select: { importBatchId: true },
  });
  for (const link of links) {
    await refreshBatch(tx, link.importBatchId, now);
  }
}

async function refreshBatch(
  tx: TransactionClient,
  batchId: string,
  now: Date,
  overrides: { confirmedAt?: Date } = {},
) {
  const [batch, intents] = await Promise.all([
    tx.importBatch.findUniqueOrThrow({ where: { id: batchId } }),
    tx.orderIntent.findMany({
      where: { importBatchLinks: { some: { importBatchId: batchId } } },
      select: { status: true },
    }),
  ]);
  const confirmedAt = overrides.confirmedAt ?? batch.confirmedAt;
  const statuses = intents.map((intent) => intent.status);
  const status = deriveBatchStatus(statuses, Boolean(confirmedAt));
  return tx.importBatch.update({
    where: { id: batchId },
    data: {
      ...aggregateStatuses(statuses),
      status,
      confirmedAt,
      completedAt:
        status === "COMPLETED" ||
        status === "PARTIALLY_COMPLETED" ||
        status === "FAILED"
          ? (batch.completedAt ?? now)
          : null,
      version: { increment: 1 },
    },
  });
}

function deriveBatchStatus(
  statuses: OrderIntentStatus[],
  confirmed: boolean,
): ImportBatchStatus {
  if (!confirmed) return "DRAFT";
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "SUCCEEDED")
  ) {
    return "COMPLETED";
  }
  if (statuses.some((status) => status === "PROCESSING")) return "PROCESSING";
  if (statuses.some((status) => ["QUEUED", "RETRY_WAIT"].includes(status))) {
    return "QUEUED";
  }
  if (statuses.some((status) => status === "AMBIGUOUS_RESULT")) {
    return "PROCESSING";
  }

  const succeeded = statuses.some((status) => status === "SUCCEEDED");
  if (succeeded) return "PARTIALLY_COMPLETED";
  return "FAILED";
}
