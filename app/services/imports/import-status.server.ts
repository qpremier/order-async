import { createHash } from "node:crypto";
import type { ImportBatchStatus, PrismaClient } from "@prisma/client";

export const TERMINAL_IMPORT_STATUSES: ReadonlySet<ImportBatchStatus> = new Set(
  ["PARTIALLY_COMPLETED", "COMPLETED", "FAILED", "CANCELLED"],
);

export async function getImportStatus(
  prisma: PrismaClient,
  input: { shopId: string; batchId: string },
) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: input.batchId, shopId: input.shopId },
    select: {
      id: true,
      status: true,
      version: true,
      totalOrders: true,
      readyOrders: true,
      queuedOrders: true,
      processingOrders: true,
      succeededOrders: true,
      failedOrders: true,
      needsAttentionOrders: true,
      updatedAt: true,
    },
  });
  if (!batch) return null;

  return {
    id: batch.id,
    status: batch.status,
    version: batch.version,
    counts: {
      total: batch.totalOrders,
      ready: batch.readyOrders,
      queued: batch.queuedOrders,
      processing: batch.processingOrders,
      succeeded: batch.succeededOrders,
      failed: batch.failedOrders,
      needsAttention: batch.needsAttentionOrders,
    },
    updatedAt: batch.updatedAt.toISOString(),
    terminal: TERMINAL_IMPORT_STATUSES.has(batch.status),
  };
}

export function buildImportStatusEtag(status: {
  id: string;
  version: number;
  updatedAt: string;
}) {
  const digest = createHash("sha256")
    .update(`${status.id}:${status.version}:${status.updatedAt}`)
    .digest("base64url");
  return `"${digest}"`;
}

export function etagMatches(ifNoneMatch: string | null, currentEtag: string) {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim().replace(/^W\//, ""))
    .some((value) => value === "*" || value === currentEtag);
}

interface StatusLoaderDependencies {
  prisma: PrismaClient;
  authenticateAdmin(request: Request): Promise<{
    session: { shop: string };
  }>;
}

export function createImportStatusLoader(
  dependencies: StatusLoaderDependencies,
) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params: Record<string, string | undefined>;
  }) => {
    const { session } = await dependencies.authenticateAdmin(request);
    const shop = await dependencies.prisma.shop.findUnique({
      where: { domain: session.shop },
      select: { id: true },
    });
    if (!shop || !params.batchId) {
      throw new Response("Import not found", { status: 404 });
    }

    const status = await getImportStatus(dependencies.prisma, {
      shopId: shop.id,
      batchId: params.batchId,
    });
    if (!status) throw new Response("Import not found", { status: 404 });

    const etag = buildImportStatusEtag(status);
    const headers = {
      ETag: etag,
      "Cache-Control": "private, no-cache",
      Vary: "Cookie",
    };
    if (etagMatches(request.headers.get("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return Response.json(status, { headers });
  };
}
