import { createHash } from "node:crypto";
export const TERMINAL_IMPORT_STATUSES = new Set(["PARTIALLY_COMPLETED", "COMPLETED", "FAILED", "CANCELLED"]);
export async function getImportStatus(prisma, input) {
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
    if (!batch)
        return null;
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
export function buildImportStatusEtag(status) {
    const digest = createHash("sha256")
        .update(`${status.id}:${status.version}:${status.updatedAt}`)
        .digest("base64url");
    return `"${digest}"`;
}
export function etagMatches(ifNoneMatch, currentEtag) {
    if (!ifNoneMatch)
        return false;
    return ifNoneMatch
        .split(",")
        .map((value) => value.trim().replace(/^W\//, ""))
        .some((value) => value === "*" || value === currentEtag);
}
export function createImportStatusLoader(dependencies) {
    return async ({ request, params, }) => {
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
        if (!status)
            throw new Response("Import not found", { status: 404 });
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
