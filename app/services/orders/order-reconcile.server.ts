import { z } from "zod";
import type { RateLimitedGraphqlClient } from "../shopify/shopify-rate-gate.server.js";
import { ShopCapabilityError } from "../shops/shop-capabilities.server.js";

export const ORDER_RECONCILIATION_QUERY = `#graphql
  query OrderRelayReconcileOrder($query: String!) {
    orders(first: 2, query: $query) {
      nodes {
        id
        name
      }
    }
  }
`;

const responseSchema = z.object({
  data: z
    .object({
      orders: z.object({
        nodes: z.array(
          z.object({ id: z.string().min(1), name: z.string().min(1) }),
        ),
      }),
    })
    .optional(),
  errors: z
    .array(
      z.object({
        message: z.string().optional(),
        extensions: z
          .object({ code: z.string().optional() })
          .passthrough()
          .optional(),
      }),
    )
    .optional(),
});

export type OrderReconciliationResult =
  | { outcome: "found"; orderGid: string; orderName: string }
  | { outcome: "not-found" }
  | { outcome: "multiple" }
  | { outcome: "retry"; code: string; message: string };

export async function reconcileShopifyOrder(
  admin: RateLimitedGraphqlClient,
  sourceIdentifier: string,
): Promise<OrderReconciliationResult> {
  try {
    const response = await admin.graphql(ORDER_RECONCILIATION_QUERY, {
      variables: {
        query: `source_identifier:"${escapeSearchValue(sourceIdentifier)}"`,
      },
    });
    const body = responseSchema.safeParse(await response.json());
    if (!body.success) {
      return {
        outcome: "retry",
        code: "INVALID_RESPONSE",
        message: "Shopify returned an unexpected reconciliation response.",
      };
    }
    if (body.data.errors?.length) {
      const error = body.data.errors[0];
      return {
        outcome: "retry",
        code: error.extensions?.code ?? "GRAPHQL_ERROR",
        message: sanitizeMessage(
          error.message ?? "Shopify reconciliation failed temporarily.",
        ),
      };
    }

    const orders = body.data.data?.orders.nodes ?? [];
    if (orders.length === 0) return { outcome: "not-found" };
    if (orders.length > 1) return { outcome: "multiple" };
    return {
      outcome: "found",
      orderGid: orders[0].id,
      orderName: orders[0].name,
    };
  } catch (error) {
    if (
      (error instanceof Error &&
        error.name === "ShopifyRateLimitDeferredError") ||
      error instanceof ShopCapabilityError
    ) {
      throw error;
    }
    return {
      outcome: "retry",
      code: "NETWORK_TRANSIENT",
      message: "Shopify reconciliation is temporarily unavailable.",
    };
  }
}

function escapeSearchValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sanitizeMessage(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}
