import type { Prisma, PrismaClient, ShopStatus } from "@prisma/client";
import type { ShopifyAdminGraphqlClient } from "../catalog/catalog-sync.server.js";

export type ShopifyCapability =
  "read_orders" | "read_products" | "write_orders";

export class ShopCapabilityError extends Error {
  readonly reason: "missing-scope" | "uninstalled";
  readonly requiredScope: ShopifyCapability | null;

  constructor(
    reason: "missing-scope" | "uninstalled",
    requiredScope: ShopifyCapability | null = null,
  ) {
    super(
      reason === "uninstalled"
        ? "Shopify access is unavailable because the app is uninstalled."
        : `Shopify access is paused until ${requiredScope} is granted.`,
    );
    this.name = "ShopCapabilityError";
    this.reason = reason;
    this.requiredScope = requiredScope;
  }
}

export function parseShopifyScopes(scopes: string | null | undefined) {
  return new Set(
    (scopes ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
}

export function hasShopifyScope(
  scopes: string | null | undefined,
  requiredScope: ShopifyCapability,
) {
  return parseShopifyScopes(scopes).has(requiredScope);
}

export function statusFromGrantedScopes(
  scopes: string | null | undefined,
): ShopStatus {
  return hasShopifyScope(scopes, "write_orders") ? "ACTIVE" : "NEEDS_REAUTH";
}

export async function syncAuthenticatedShop(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { shopDomain: string; grantedScopes: string | null | undefined },
) {
  const status = statusFromGrantedScopes(input.grantedScopes);
  const existing = await prisma.shop.findUnique({
    where: { domain: input.shopDomain },
  });
  if (!existing) {
    return prisma.shop.upsert({
      where: { domain: input.shopDomain },
      create: {
        domain: input.shopDomain,
        grantedScopes: input.grantedScopes,
        status,
      },
      update: {},
    });
  }

  // A request authenticated just before uninstall must not reactivate the shop
  // after the uninstall transaction deletes its sessions.
  await prisma.shop.updateMany({
    where: { id: existing.id, status: { not: "UNINSTALLED" } },
    data: {
      grantedScopes: input.grantedScopes,
      status,
      uninstalledAt: null,
    },
  });
  return prisma.shop.findUniqueOrThrow({ where: { id: existing.id } });
}

export function withShopCapabilityGuard(
  admin: ShopifyAdminGraphqlClient,
  options: {
    prisma: PrismaClient;
    shopId: string;
    requiredScope: ShopifyCapability;
  },
): ShopifyAdminGraphqlClient {
  return {
    async graphql(query, requestOptions) {
      const shop = await options.prisma.shop.findUnique({
        where: { id: options.shopId },
        select: { status: true, grantedScopes: true },
      });
      if (!shop || shop.status === "UNINSTALLED") {
        throw new ShopCapabilityError("uninstalled");
      }
      if (!hasShopifyScope(shop.grantedScopes, options.requiredScope)) {
        throw new ShopCapabilityError("missing-scope", options.requiredScope);
      }
      return admin.graphql(query, requestOptions);
    },
  };
}
