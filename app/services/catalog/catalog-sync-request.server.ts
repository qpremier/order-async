import type { PrismaClient } from "@prisma/client";
import { OUTBOX_EVENT_TYPES } from "../../queues/jobs.js";
import { createOutboxEvent } from "../outbox/outbox.server.js";
import { syncAuthenticatedShop } from "../shops/shop-capabilities.server.js";

export interface CatalogSyncRequestResult {
  shopId: string;
  syncRunId: string;
  outboxEventId: string | null;
  created: boolean;
}

export async function requestCatalogFullSync(
  prisma: PrismaClient,
  input: {
    shopDomain: string;
    grantedScopes?: string | null;
    requestedBy: "merchant" | "reconciliation";
    requestedAt?: Date;
  },
): Promise<CatalogSyncRequestResult> {
  return prisma.$transaction(async (tx) => {
    const shop = await syncAuthenticatedShop(tx, {
      shopDomain: input.shopDomain,
      grantedScopes: input.grantedScopes,
    });
    if (shop.status === "UNINSTALLED") {
      throw new Error("Catalog sync is unavailable for an uninstalled shop");
    }
    await tx.shop.update({
      where: { id: shop.id },
      data: { catalogSyncStatus: "SYNCING" },
    });

    const existingRun = await tx.catalogSyncRun.findFirst({
      where: {
        shopId: shop.id,
        status: "RUNNING",
      },
      orderBy: {
        startedAt: "desc",
      },
    });

    const syncRun =
      existingRun ??
      (await tx.catalogSyncRun.create({
        data: {
          shopId: shop.id,
          status: "RUNNING",
          startedAt: input.requestedAt ?? new Date(),
        },
      }));

    const outboxEvent = await createOutboxEvent(tx, {
      shopId: shop.id,
      aggregateType: "CatalogSyncRun",
      aggregateId: syncRun.id,
      eventType: OUTBOX_EVENT_TYPES.catalogBootstrap,
      payload: {
        syncRunId: syncRun.id,
        requestedBy: input.requestedBy,
        requestedAt: (input.requestedAt ?? new Date()).toISOString(),
      },
    });

    return {
      shopId: shop.id,
      syncRunId: syncRun.id,
      outboxEventId: outboxEvent.id,
      created: !existingRun,
    };
  });
}

export async function scheduleStaleCatalogSyncs(
  prisma: PrismaClient,
  input: {
    staleAfterMinutes: number;
    now?: Date;
    take?: number;
  },
): Promise<{ scheduled: number }> {
  const now = input.now ?? new Date();
  const staleCutoff = new Date(
    now.getTime() - input.staleAfterMinutes * 60_000,
  );
  const shops = await prisma.shop.findMany({
    where: {
      status: "ACTIVE",
      catalogSyncRuns: {
        none: {
          status: "RUNNING",
        },
      },
      OR: [
        {
          catalogSyncStatus: {
            in: ["NEVER_SYNCED", "STALE", "FAILED"],
          },
        },
        {
          lastCatalogSyncAt: null,
        },
        {
          lastCatalogSyncAt: {
            lt: staleCutoff,
          },
        },
      ],
    },
    orderBy: [{ lastCatalogSyncAt: "asc" }, { createdAt: "asc" }],
    take: input.take ?? 25,
    select: {
      domain: true,
      grantedScopes: true,
    },
  });

  for (const shop of shops) {
    await requestCatalogFullSync(prisma, {
      shopDomain: shop.domain,
      grantedScopes: shop.grantedScopes,
      requestedBy: "reconciliation",
      requestedAt: now,
    });
  }

  return {
    scheduled: shops.length,
  };
}
