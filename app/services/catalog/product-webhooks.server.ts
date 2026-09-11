import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";

export interface ProductWebhookIngestionInput {
  shopDomain: string;
  topic: string;
  webhookId: string;
  payload: unknown;
  eventId?: string;
  grantedScopes?: string | null;
}

export type ProductWebhookIngestionResult =
  | {
      status: "accepted";
      shopId: string;
      webhookReceiptId: string;
      outboxEventId: string;
      productGid: string;
    }
  | {
      status: "duplicate";
      webhookId: string;
    }
  | {
      status: "ignored";
      webhookReceiptId: string;
      reason: string;
    };

export async function ingestProductWebhook(
  prisma: PrismaClient,
  input: ProductWebhookIngestionInput,
): Promise<ProductWebhookIngestionResult> {
  const productReference = extractProductReference(input.payload);
  const payloadHash = hashPayload(input.payload);
  const normalizedTopic = normalizeWebhookTopic(input.topic);
  const deleted = normalizedTopic === "products/delete";

  try {
    return await prisma.$transaction(async (tx) => {
      const shop = await tx.shop.upsert({
        where: {
          domain: input.shopDomain,
        },
        create: {
          domain: input.shopDomain,
          grantedScopes: input.grantedScopes,
        },
        update: {
          grantedScopes: input.grantedScopes ?? undefined,
        },
      });

      const receipt = await tx.webhookReceipt.create({
        data: {
          shopId: shop.id,
          webhookId: input.webhookId,
          topic: normalizedTopic,
          payloadHash,
        },
      });

      if (!productReference) {
        await tx.webhookReceipt.update({
          where: {
            id: receipt.id,
          },
          data: {
            processedAt: new Date(),
            processingError: "Product identifier missing from webhook payload",
          },
        });

        return {
          status: "ignored",
          webhookReceiptId: receipt.id,
          reason: "missing-product-identifier",
        };
      }

      const event = await createOutboxEvent(tx, {
        shopId: shop.id,
        aggregateType: "CatalogProduct",
        aggregateId: productReference.productGid,
        eventType: OUTBOX_EVENT_TYPES.catalogRefreshProduct,
        payload: {
          webhookReceiptId: receipt.id,
          webhookId: input.webhookId,
          eventId: input.eventId,
          topic: normalizedTopic,
          productGid: productReference.productGid,
          productNumericId: productReference.productNumericId,
          deleted,
        },
      });

      return {
        status: "accepted",
        shopId: shop.id,
        webhookReceiptId: receipt.id,
        outboxEventId: event.id,
        productGid: productReference.productGid,
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return {
        status: "duplicate",
        webhookId: input.webhookId,
      };
    }

    throw error;
  }
}

export function extractProductReference(payload: unknown):
  | {
      productGid: string;
      productNumericId: string;
    }
  | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const adminGraphqlId = payload.admin_graphql_api_id;
  if (typeof adminGraphqlId === "string" && adminGraphqlId.trim()) {
    const numericId = extractNumericId(adminGraphqlId);

    return {
      productGid: adminGraphqlId,
      productNumericId: numericId ?? adminGraphqlId,
    };
  }

  const id = payload.id;
  if (typeof id === "string" || typeof id === "number") {
    const productNumericId = String(id);

    return {
      productGid: `gid://shopify/Product/${productNumericId}`,
      productNumericId,
    };
  }

  return undefined;
}

export function normalizeWebhookTopic(topic: string): string {
  return topic.trim().toLowerCase().replaceAll("_", "/");
}

function hashPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload ?? null))
    .digest("hex");
}

function extractNumericId(gid: string): string | undefined {
  return gid.split("/").at(-1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
