import { randomUUID } from "node:crypto";
import type { OutboxEvent, PrismaClient, Shop } from "@prisma/client";
import { ShopStatus } from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";

export interface CreatePhase2DiagnosticOutboxEventInput {
  shopDomain: string;
  grantedScopes?: string | null;
  idempotencyKey?: string | null;
  requestedAt?: Date;
}

export interface CreatePhase2DiagnosticOutboxEventResult {
  diagnosticId: string;
  created: boolean;
  shop: Shop;
  event: OutboxEvent;
}

const DIAGNOSTIC_AGGREGATE_TYPE = "QueueDiagnostic";

export async function createPhase2DiagnosticOutboxEvent(
  prisma: PrismaClient,
  input: CreatePhase2DiagnosticOutboxEventInput,
): Promise<CreatePhase2DiagnosticOutboxEventResult> {
  const diagnosticId = normalizeIdempotencyKey(input.idempotencyKey);
  const requestedAt = input.requestedAt ?? new Date();

  return prisma.$transaction(async (tx) => {
    const shop = await tx.shop.upsert({
      where: {
        domain: input.shopDomain,
      },
      update: {
        status: ShopStatus.ACTIVE,
        grantedScopes: input.grantedScopes ?? undefined,
        uninstalledAt: null,
      },
      create: {
        domain: input.shopDomain,
        status: ShopStatus.ACTIVE,
        grantedScopes: input.grantedScopes ?? undefined,
      },
    });

    const existingEvent = await tx.outboxEvent.findFirst({
      where: {
        shopId: shop.id,
        aggregateType: DIAGNOSTIC_AGGREGATE_TYPE,
        aggregateId: diagnosticId,
        eventType: OUTBOX_EVENT_TYPES.phase2Diagnostic,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    if (existingEvent) {
      return {
        diagnosticId,
        created: false,
        shop,
        event: existingEvent,
      };
    }

    const event = await createOutboxEvent(tx, {
      shopId: shop.id,
      aggregateType: DIAGNOSTIC_AGGREGATE_TYPE,
      aggregateId: diagnosticId,
      eventType: OUTBOX_EVENT_TYPES.phase2Diagnostic,
      payload: {
        diagnosticId,
        requestedAt: requestedAt.toISOString(),
        source: "phase2",
      },
    });

    return {
      diagnosticId,
      created: true,
      shop,
      event,
    };
  });
}

function normalizeIdempotencyKey(value: string | null | undefined): string {
  const normalized = value?.trim();

  return normalized && normalized.length > 0 ? normalized : randomUUID();
}
