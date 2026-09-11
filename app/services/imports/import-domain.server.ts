import {
  Prisma,
  type ImportBatch,
  type OrderIntentStatus,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import {
  buildDescendingKeysetArgs,
  toKeysetPage,
  type KeysetPage,
} from "../pagination/cursor.server.js";
import type { CanonicalImportOrder } from "./import-parser.server.js";
import { syncAuthenticatedShop } from "../shops/shop-capabilities.server.js";

const sourceSystemSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    "Use only letters, numbers, periods, underscores, and hyphens.",
  )
  .transform((value) => value.toLowerCase());

const idempotencyKeySchema = z.string().trim().uuid();

export class ImportRequestError extends Error {
  readonly status: number;
  readonly field: string | null;

  constructor(
    message: string,
    options: { status?: number; field?: string | null } = {},
  ) {
    super(message);
    this.name = "ImportRequestError";
    this.status = options.status ?? 422;
    this.field = options.field ?? null;
  }
}

export class ExternalOrderConflictError extends ImportRequestError {
  readonly externalOrderIds: string[];

  constructor(externalOrderIds: string[]) {
    super(
      `Existing external orders have different content: ${externalOrderIds.join(", ")}. Use new external order IDs or review the earlier imports.`,
      { status: 409 },
    );
    this.name = "ExternalOrderConflictError";
    this.externalOrderIds = externalOrderIds;
  }
}

export interface DraftImportResult {
  batch: ImportBatch;
  created: boolean;
  reusedOrderCount: number;
}

export function normalizeSourceSystem(value: unknown): string {
  const parsed = sourceSystemSchema.safeParse(value);
  if (!parsed.success) {
    throw new ImportRequestError(
      parsed.error.issues[0]?.message ??
        "Enter a valid source system identifier.",
      { field: "sourceSystem" },
    );
  }
  return parsed.data;
}

export function validateIdempotencyKey(value: unknown): string {
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new ImportRequestError("Reload the page and try the upload again.", {
      field: "idempotencyKey",
    });
  }
  return parsed.data;
}

export async function createDraftImport(
  prisma: PrismaClient,
  input: {
    shopDomain: string;
    grantedScopes?: string | null;
    sourceSystem: string;
    originalFileName: string;
    idempotencyKey: string;
    orders: CanonicalImportOrder[];
  },
): Promise<DraftImportResult> {
  const sourceSystem = normalizeSourceSystem(input.sourceSystem);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const originalFileName = sanitizeFileName(input.originalFileName);

  const shop = await syncAuthenticatedShop(prisma, {
    shopDomain: input.shopDomain,
    grantedScopes: input.grantedScopes,
  });
  if (shop.status === "UNINSTALLED") {
    throw new ImportRequestError(
      "This shop is uninstalled, so new imports are unavailable.",
      { status: 409 },
    );
  }

  const original = await findBatchByIdempotencyKey(
    prisma,
    shop.id,
    idempotencyKey,
  );
  if (original) {
    return { batch: original, created: false, reusedOrderCount: 0 };
  }

  // A concurrent request can win either the batch key or external-order unique
  // constraint after our first read. Retrying reloads the durable winner.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const activeShop = await tx.shop.updateMany({
          where: { id: shop.id, status: { not: "UNINSTALLED" } },
          data: { updatedAt: new Date() },
        });
        if (activeShop.count !== 1) {
          throw new ImportRequestError(
            "This shop is uninstalled, so new imports are unavailable.",
            { status: 409 },
          );
        }

        const existingBatch = await findBatchByIdempotencyKey(
          tx,
          shop.id,
          idempotencyKey,
        );
        if (existingBatch) {
          return { batch: existingBatch, created: false, reusedOrderCount: 0 };
        }

        const externalOrderIds = input.orders.map(
          (order) => order.externalOrderId,
        );
        const existingIntents = await tx.orderIntent.findMany({
          where: {
            shopId: shop.id,
            sourceSystem,
            externalOrderId: { in: externalOrderIds },
          },
          select: {
            id: true,
            externalOrderId: true,
            payloadHash: true,
            status: true,
          },
        });
        const existingByExternalId = new Map(
          existingIntents.map((intent) => [intent.externalOrderId, intent]),
        );
        const conflicts = input.orders
          .filter((order) => {
            const existing = existingByExternalId.get(order.externalOrderId);
            return existing && existing.payloadHash !== order.payloadHash;
          })
          .map((order) => order.externalOrderId);

        if (conflicts.length > 0) {
          throw new ExternalOrderConflictError(conflicts);
        }

        const resolution = await loadSkuResolution(tx, {
          shopId: shop.id,
          sourceSystem,
          normalizedSkus: [
            ...new Set(
              input.orders.flatMap((order) =>
                order.lines.map((line) => line.normalizedSku),
              ),
            ),
          ],
        });

        const batch = await tx.importBatch.create({
          data: {
            shopId: shop.id,
            sourceSystem,
            originalFileName,
            idempotencyKey,
            status: "DRAFT",
            totalOrders: input.orders.length,
          },
        });

        const statuses: OrderIntentStatus[] = [];
        let reusedOrderCount = 0;
        for (const order of input.orders) {
          const existing = existingByExternalId.get(order.externalOrderId);
          if (existing) {
            await tx.importBatchOrderIntent.create({
              data: {
                importBatchId: batch.id,
                orderIntentId: existing.id,
                reused: true,
              },
            });
            statuses.push(existing.status);
            reusedOrderCount += 1;
            continue;
          }

          const resolvedLines = order.lines.map((line) =>
            resolveLine(line, resolution),
          );
          const status = statusFromLines(resolvedLines);
          const intent = await tx.orderIntent.create({
            data: {
              shopId: shop.id,
              importBatchId: batch.id,
              sourceSystem,
              externalOrderId: order.externalOrderId,
              payloadHash: order.payloadHash,
              status,
              processedAt: new Date(order.processedAt),
              email: order.email,
              currency: order.currency,
              shippingFirstName: order.shippingFirstName,
              shippingLastName: order.shippingLastName,
              shippingAddress1: order.shippingAddress1,
              shippingAddress2: order.shippingAddress2,
              shippingCity: order.shippingCity,
              shippingProvince: order.shippingProvince,
              shippingProvinceCode: order.shippingProvinceCode,
              shippingCountryCode: order.shippingCountryCode,
              shippingZip: order.shippingZip,
              shippingPhone: order.shippingPhone,
              note: order.note,
              orderLines: {
                create: resolvedLines.map((line) => ({
                  shopId: shop.id,
                  originalSku: line.originalSku,
                  normalizedSku: line.normalizedSku,
                  shopifyVariantGid: line.shopifyVariantGid,
                  quantity: line.quantity,
                  unitPrice: new Prisma.Decimal(line.unitPrice),
                  validationStatus: line.validationStatus,
                  validationMessage: line.validationMessage,
                })),
              },
              importBatchLinks: {
                create: {
                  importBatchId: batch.id,
                  reused: false,
                },
              },
            },
          });
          statuses.push(intent.status);
        }

        const counts = aggregateStatuses(statuses);
        const updatedBatch = await tx.importBatch.update({
          where: { id: batch.id },
          data: counts,
        });

        return { batch: updatedBatch, created: true, reusedOrderCount };
      });
    } catch (error) {
      if (error instanceof ExternalOrderConflictError) {
        throw error;
      }
      if (isUniqueConstraintError(error) && attempt < 2) {
        const concurrentBatch = await findBatchByIdempotencyKey(
          prisma,
          shop.id,
          idempotencyKey,
        );
        if (concurrentBatch) {
          return {
            batch: concurrentBatch,
            created: false,
            reusedOrderCount: 0,
          };
        }
        continue;
      }
      throw error;
    }
  }

  throw new ImportRequestError("The import could not be created safely.", {
    status: 409,
  });
}

export async function listImportBatchesPage(
  prisma: PrismaClient,
  options: { shopId: string; cursor?: string | null; first: number },
): Promise<KeysetPage<ImportBatch>> {
  const keysetArgs = buildDescendingKeysetArgs(options);
  const batches = await prisma.importBatch.findMany({
    where: { shopId: options.shopId, ...keysetArgs.where },
    orderBy: keysetArgs.orderBy,
    take: keysetArgs.take,
  });
  return toKeysetPage(batches, options.first);
}

export async function getImportDetails(
  prisma: PrismaClient,
  options: {
    shopId: string;
    batchId: string;
    cursor?: string | null;
    first: number;
  },
) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, shopId: options.shopId },
  });
  if (!batch) {
    return null;
  }

  const keysetArgs = buildDescendingKeysetArgs(options);
  const records = await prisma.orderIntent.findMany({
    where: {
      shopId: options.shopId,
      importBatchLinks: { some: { importBatchId: batch.id } },
      ...keysetArgs.where,
    },
    orderBy: keysetArgs.orderBy,
    take: keysetArgs.take,
    include: {
      orderLines: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      importBatchLinks: {
        where: { importBatchId: batch.id },
        select: { reused: true },
      },
    },
  });

  return { batch, intentsPage: toKeysetPage(records, options.first) };
}

export async function listMappingCandidates(
  prisma: PrismaClient,
  options: {
    shopId: string;
    normalizedSkus: string[];
    query?: string | null;
    first?: number;
  },
) {
  const query = options.query?.trim().slice(0, 100);
  const [matching, fallback] = await Promise.all([
    prisma.catalogVariant.findMany({
      where: {
        shopId: options.shopId,
        deletedAt: null,
        normalizedSku: { in: options.normalizedSkus },
      },
      orderBy: [
        { productTitle: "asc" },
        { variantTitle: "asc" },
        { id: "asc" },
      ],
    }),
    prisma.catalogVariant.findMany({
      where: {
        shopId: options.shopId,
        deletedAt: null,
        ...(query
          ? {
              OR: [
                { sku: { contains: query, mode: "insensitive" } },
                { productTitle: { contains: query, mode: "insensitive" } },
                { variantTitle: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [
        { productTitle: "asc" },
        { variantTitle: "asc" },
        { id: "asc" },
      ],
      take: options.first ?? 100,
    }),
  ]);
  return [
    ...new Map(
      [...matching, ...fallback].map((variant) => [variant.id, variant]),
    ).values(),
  ];
}

type ResolutionMaps = {
  mappingBySku: Map<string, string>;
  variantsBySku: Map<string, Array<{ shopifyVariantGid: string }>>;
  activeVariantGids: Set<string>;
};

async function loadSkuResolution(
  tx: Prisma.TransactionClient,
  options: { shopId: string; sourceSystem: string; normalizedSkus: string[] },
): Promise<ResolutionMaps> {
  const mappings = await tx.skuMapping.findMany({
    where: {
      shopId: options.shopId,
      sourceSystem: options.sourceSystem,
      normalizedExternalSku: { in: options.normalizedSkus },
    },
  });
  const variants = await tx.catalogVariant.findMany({
    where: {
      shopId: options.shopId,
      deletedAt: null,
      OR: [
        { normalizedSku: { in: options.normalizedSkus } },
        {
          shopifyVariantGid: {
            in: mappings.map((mapping) => mapping.shopifyVariantGid),
          },
        },
      ],
    },
    select: { normalizedSku: true, shopifyVariantGid: true },
  });

  const variantsBySku = new Map<string, Array<{ shopifyVariantGid: string }>>();
  for (const variant of variants) {
    if (!variant.normalizedSku) continue;
    const values = variantsBySku.get(variant.normalizedSku) ?? [];
    values.push(variant);
    variantsBySku.set(variant.normalizedSku, values);
  }
  return {
    mappingBySku: new Map(
      mappings.map((mapping) => [
        mapping.normalizedExternalSku,
        mapping.shopifyVariantGid,
      ]),
    ),
    variantsBySku,
    activeVariantGids: new Set(
      variants.map((variant) => variant.shopifyVariantGid),
    ),
  };
}

function resolveLine(
  line: CanonicalImportOrder["lines"][number],
  resolution: ResolutionMaps,
) {
  const mappedGid = resolution.mappingBySku.get(line.normalizedSku);
  if (mappedGid && resolution.activeVariantGids.has(mappedGid)) {
    return {
      ...line,
      shopifyVariantGid: mappedGid,
      validationStatus: "VALID" as const,
      validationMessage: null,
    };
  }

  const variants = resolution.variantsBySku.get(line.normalizedSku) ?? [];
  if (variants.length === 1) {
    return {
      ...line,
      shopifyVariantGid: variants[0].shopifyVariantGid,
      validationStatus: "VALID" as const,
      validationMessage: null,
    };
  }
  if (variants.length > 1) {
    return {
      ...line,
      shopifyVariantGid: null,
      validationStatus: "AMBIGUOUS_MAPPING" as const,
      validationMessage: "Multiple active catalog variants use this SKU.",
    };
  }
  return {
    ...line,
    shopifyVariantGid: null,
    validationStatus: "NEEDS_MAPPING" as const,
    validationMessage: "No active catalog variant matches this SKU.",
  };
}

function statusFromLines(
  lines: Array<{
    validationStatus: "VALID" | "NEEDS_MAPPING" | "AMBIGUOUS_MAPPING";
  }>,
): OrderIntentStatus {
  if (lines.some((line) => line.validationStatus === "AMBIGUOUS_MAPPING")) {
    return "AMBIGUOUS_MAPPING";
  }
  if (lines.some((line) => line.validationStatus === "NEEDS_MAPPING")) {
    return "NEEDS_MAPPING";
  }
  return "READY";
}

export function aggregateStatuses(statuses: OrderIntentStatus[]) {
  return {
    readyOrders: statuses.filter((status) => status === "READY").length,
    queuedOrders: statuses.filter((status) =>
      ["QUEUED", "RETRY_WAIT"].includes(status),
    ).length,
    processingOrders: statuses.filter((status) => status === "PROCESSING")
      .length,
    succeededOrders: statuses.filter((status) => status === "SUCCEEDED").length,
    failedOrders: statuses.filter((status) =>
      ["INVALID", "DEAD_LETTER"].includes(status),
    ).length,
    needsAttentionOrders: statuses.filter((status) =>
      ["NEEDS_MAPPING", "AMBIGUOUS_MAPPING", "AMBIGUOUS_RESULT"].includes(
        status,
      ),
    ).length,
  };
}

async function findBatchByIdempotencyKey(
  client: PrismaClient | Prisma.TransactionClient,
  shopId: string,
  idempotencyKey: string,
) {
  return client.importBatch.findUnique({
    where: { shopId_idempotencyKey: { shopId, idempotencyKey } },
  });
}

function sanitizeFileName(fileName: string) {
  const name = fileName.split(/[\\/]/).at(-1)?.trim() || "orders.csv";
  return name.slice(0, 255);
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}
