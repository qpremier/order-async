import { randomUUID } from "node:crypto";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";
import { syncAuthenticatedShop } from "../shops/shop-capabilities.server.js";
const DIAGNOSTIC_AGGREGATE_TYPE = "QueueDiagnostic";
export async function createPhase2DiagnosticOutboxEvent(prisma, input) {
    const diagnosticId = normalizeIdempotencyKey(input.idempotencyKey);
    const requestedAt = input.requestedAt ?? new Date();
    return prisma.$transaction(async (tx) => {
        const shop = await syncAuthenticatedShop(tx, {
            shopDomain: input.shopDomain,
            grantedScopes: input.grantedScopes,
            authenticatedSessionId: input.authenticatedSessionId,
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
function normalizeIdempotencyKey(value) {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : randomUUID();
}
