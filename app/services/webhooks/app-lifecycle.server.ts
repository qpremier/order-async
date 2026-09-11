import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";
import { refreshLinkedBatches } from "../orders/order-state.server.js";
import {
  hasShopifyScope,
  statusFromGrantedScopes,
} from "../shops/shop-capabilities.server.js";

export type AppLifecycleTopic = "app/scopes_update" | "app/uninstalled";

export async function ingestAppLifecycleWebhook(
  prisma: PrismaClient,
  input: {
    shopDomain: string;
    topic: string;
    webhookId: string;
    payload: unknown;
    sessionScopes?: string | null;
    now?: Date;
  },
) {
  const topic = normalizeTopic(input.topic);
  if (topic !== "app/uninstalled" && topic !== "app/scopes_update") {
    throw new Error(`Unsupported app lifecycle webhook topic: ${topic}`);
  }
  const now = input.now ?? new Date();
  const grantedScopes =
    topic === "app/scopes_update"
      ? extractGrantedScopes(input.payload)
      : input.sessionScopes;

  try {
    return await prisma.$transaction(async (tx) => {
      const shop = await tx.shop.upsert({
        where: { domain: input.shopDomain },
        create: {
          domain: input.shopDomain,
          grantedScopes,
          status:
            topic === "app/uninstalled"
              ? "UNINSTALLED"
              : statusFromGrantedScopes(grantedScopes),
          uninstalledAt: topic === "app/uninstalled" ? now : null,
        },
        update: {},
      });
      const receipt = await tx.webhookReceipt.create({
        data: {
          shopId: shop.id,
          webhookId: input.webhookId,
          topic,
          payloadHash: hashPayload(input.payload),
        },
      });

      if (topic === "app/uninstalled") {
        await tx.shop.update({
          where: { id: shop.id },
          data: { status: "UNINSTALLED", uninstalledAt: now },
        });
        await tx.session.deleteMany({ where: { shop: input.shopDomain } });
      } else {
        const hasCurrentSession =
          (await tx.session.count({ where: { shop: input.shopDomain } })) > 0;
        const canReactivate =
          shop.status !== "UNINSTALLED" || hasCurrentSession;
        await tx.shop.update({
          where: { id: shop.id },
          data: {
            grantedScopes,
            status: canReactivate
              ? statusFromGrantedScopes(grantedScopes)
              : "UNINSTALLED",
            uninstalledAt: canReactivate ? null : shop.uninstalledAt,
          },
        });
        await tx.session.updateMany({
          where: { shop: input.shopDomain },
          data: { scope: grantedScopes },
        });
      }

      const event = await createOutboxEvent(tx, {
        shopId: shop.id,
        aggregateType: "WebhookReceipt",
        aggregateId: receipt.id,
        eventType: OUTBOX_EVENT_TYPES.webhookProcess,
        payload: { webhookReceiptId: receipt.id },
      });
      return {
        status: "accepted" as const,
        shopId: shop.id,
        webhookReceiptId: receipt.id,
        outboxEventId: event.id,
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        status: "duplicate" as const,
        webhookId: input.webhookId,
      };
    }
    throw error;
  }
}

export async function processAppLifecycleWebhook(
  prisma: PrismaClient,
  input: { shopId: string; webhookReceiptId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const receipt = await tx.webhookReceipt.findFirst({
      where: { id: input.webhookReceiptId, shopId: input.shopId },
      include: { shop: true },
    });
    if (!receipt) return { status: "stale" as const };
    if (receipt.processedAt) return { status: "already-processed" as const };

    const topic = normalizeTopic(receipt.topic);
    if (topic === "app/uninstalled") {
      const cancellableIntentIds = await tx.orderIntent.findMany({
        where: {
          shopId: input.shopId,
          OR: [
            {
              status: {
                in: [
                  "DRAFT",
                  "VALIDATING",
                  "NEEDS_MAPPING",
                  "AMBIGUOUS_MAPPING",
                  "INVALID",
                  "READY",
                  "QUEUED",
                  "PROCESSING",
                  "RETRY_WAIT",
                  "AMBIGUOUS_RESULT",
                ],
              },
            },
            {
              status: "CANCELLED",
              lastErrorCategory: "SHOP_UNINSTALLED",
            },
          ],
          shopifyOrderGid: null,
        },
        select: { id: true },
      });
      const affectedBatchLinks = await tx.importBatchOrderIntent.findMany({
        where: {
          orderIntentId: {
            in: cancellableIntentIds.map((intent) => intent.id),
          },
        },
        select: { importBatchId: true },
      });
      await tx.orderIntent.updateMany({
        where: { id: { in: cancellableIntentIds.map((intent) => intent.id) } },
        data: {
          status: "CANCELLED",
          processingStartedAt: null,
          nextAttemptAt: null,
          lastErrorCategory: "SHOP_UNINSTALLED",
          lastErrorCode: "APP_UNINSTALLED",
          sanitizedLastError:
            "Order work was cancelled because the app was uninstalled.",
          version: { increment: 1 },
        },
      });
      await tx.importBatch.updateMany({
        where: {
          shopId: input.shopId,
          id: {
            in: [
              ...new Set(affectedBatchLinks.map((link) => link.importBatchId)),
            ],
          },
          status: {
            notIn: ["COMPLETED", "PARTIALLY_COMPLETED", "CANCELLED"],
          },
        },
        data: {
          status: "CANCELLED",
          readyOrders: 0,
          queuedOrders: 0,
          processingOrders: 0,
          needsAttentionOrders: 0,
          completedAt: now,
          version: { increment: 1 },
        },
      });
      await tx.catalogSyncRun.updateMany({
        where: { shopId: input.shopId, status: "RUNNING" },
        data: { status: "CANCELLED", completedAt: now },
      });
    } else if (topic === "app/scopes_update") {
      if (receipt.shop.status !== "UNINSTALLED") {
        if (hasShopifyScope(receipt.shop.grantedScopes, "write_orders")) {
          await resumeScopeBlockedWork(tx, input.shopId, now);
        } else {
          const paused = await tx.orderIntent.findMany({
            where: {
              shopId: input.shopId,
              status: { in: ["QUEUED", "RETRY_WAIT"] },
              shopifyOrderGid: null,
            },
            select: { id: true },
          });
          await tx.orderIntent.updateMany({
            where: { id: { in: paused.map((intent) => intent.id) } },
            data: {
              status: "RETRY_WAIT",
              nextAttemptAt: null,
              lastErrorCategory: "MISSING_SCOPE",
              lastErrorCode: "WRITE_ORDERS_REQUIRED",
              sanitizedLastError:
                "Order creation is paused until write_orders is granted.",
              version: { increment: 1 },
            },
          });
          for (const intent of paused) {
            await refreshLinkedBatches(tx, intent.id, now);
          }
        }
      }
    } else {
      throw new Error(`Unsupported stored lifecycle webhook topic: ${topic}`);
    }

    await tx.webhookReceipt.update({
      where: { id: receipt.id },
      data: { processedAt: now, processingError: null },
    });
    return { status: "processed" as const, topic };
  });
}

async function resumeScopeBlockedWork(
  tx: Prisma.TransactionClient,
  shopId: string,
  now: Date,
) {
  const [creates, reconciliations] = await Promise.all([
    tx.orderIntent.findMany({
      where: {
        shopId,
        status: "RETRY_WAIT",
        lastErrorCategory: "MISSING_SCOPE",
        shopifyOrderGid: null,
      },
      select: { id: true },
    }),
    tx.orderIntent.findMany({
      where: {
        shopId,
        status: "AMBIGUOUS_RESULT",
        nextAttemptAt: { not: null },
        processingStartedAt: null,
        shopifyOrderGid: null,
      },
      select: { id: true },
    }),
  ]);

  for (const intent of creates) {
    const updated = await tx.orderIntent.updateMany({
      where: {
        id: intent.id,
        shopId,
        status: "RETRY_WAIT",
        lastErrorCategory: "MISSING_SCOPE",
      },
      data: { nextAttemptAt: now, version: { increment: 1 } },
    });
    if (updated.count !== 1) continue;
    await createOutboxEvent(tx, {
      shopId,
      aggregateType: "OrderIntent",
      aggregateId: intent.id,
      eventType: OUTBOX_EVENT_TYPES.orderCreate,
      payload: { orderIntentId: intent.id },
    });
    await refreshLinkedBatches(tx, intent.id, now);
  }

  if (
    !hasShopifyScope(
      (await tx.shop.findUniqueOrThrow({ where: { id: shopId } }))
        .grantedScopes,
      "read_orders",
    )
  ) {
    return;
  }
  for (const intent of reconciliations) {
    await tx.orderIntent.update({
      where: { id: intent.id },
      data: { nextAttemptAt: now, version: { increment: 1 } },
    });
    await createOutboxEvent(tx, {
      shopId,
      aggregateType: "OrderIntent",
      aggregateId: intent.id,
      eventType: OUTBOX_EVENT_TYPES.orderReconcileAmbiguous,
      payload: { orderIntentId: intent.id, delayMs: 0 },
    });
  }
}

export function extractGrantedScopes(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return "";
  }
  const current = (payload as Record<string, unknown>).current;
  const scopes = Array.isArray(current)
    ? current.filter((scope): scope is string => typeof scope === "string")
    : typeof current === "string"
      ? current.split(",")
      : [];
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))]
    .sort()
    .join(",");
}

function normalizeTopic(topic: string) {
  const normalized = topic.trim().toLowerCase();
  if (normalized === "app_uninstalled") return "app/uninstalled";
  if (normalized === "app_scopes_update") return "app/scopes_update";
  return normalized;
}

function hashPayload(payload: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(payload ?? null))
    .digest("hex");
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
