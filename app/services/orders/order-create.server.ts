import type { OrderIntent, OrderLine } from "@prisma/client";
import { z } from "zod";
import type { RateLimitedGraphqlClient } from "../shopify/shopify-rate-gate.server.js";
import { ShopCapabilityError } from "../shops/shop-capabilities.server.js";

export const ORDER_CREATE_MUTATION = `#graphql
  mutation OrderRelayCreateOrder($order: OrderCreateOrderInput!) {
    orderCreate(order: $order) {
      order {
        id
        name
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const graphqlErrorSchema = z.object({
  message: z.string().optional(),
  extensions: z
    .object({ code: z.string().optional() })
    .passthrough()
    .optional(),
});

const orderCreateResponseSchema = z.object({
  data: z
    .object({
      orderCreate: z
        .object({
          order: z
            .object({ id: z.string().min(1), name: z.string().min(1) })
            .nullable(),
          userErrors: z.array(
            z.object({
              field: z.array(z.string()).nullable().optional(),
              message: z.string().min(1),
            }),
          ),
        })
        .nullable(),
    })
    .optional(),
  errors: z.array(graphqlErrorSchema).optional(),
});

export type OrderIntentForCreate = OrderIntent & { orderLines: OrderLine[] };

export type ShopifyOrderCreateResult =
  | { outcome: "succeeded"; orderGid: string; orderName: string }
  | {
      outcome: "permanent-error";
      category: "SHOPIFY_USER_ERROR" | "MISSING_SCOPE" | "INTERNAL_BUG";
      code: string;
      message: string;
    }
  | {
      outcome: "retry";
      category: "THROTTLED" | "SHOPIFY_SERVER_TRANSIENT";
      code: string;
      message: string;
    }
  | { outcome: "ambiguous"; code: string; message: string };

export async function createShopifyOrder(
  admin: RateLimitedGraphqlClient,
  intent: OrderIntentForCreate,
): Promise<ShopifyOrderCreateResult> {
  if (!intent.sourceIdentifier) {
    return {
      outcome: "permanent-error",
      category: "INTERNAL_BUG",
      code: "MISSING_SOURCE_IDENTIFIER",
      message: "The order is missing its deterministic source identifier.",
    };
  }
  if (
    intent.orderLines.length === 0 ||
    intent.orderLines.some((line) => !line.shopifyVariantGid)
  ) {
    return {
      outcome: "permanent-error",
      category: "INTERNAL_BUG",
      code: "INVALID_ORDER_LINES",
      message: "The order has unresolved catalog lines.",
    };
  }

  let body: unknown;
  try {
    const response = await admin.graphql(ORDER_CREATE_MUTATION, {
      variables: { order: buildOrderCreateInput(intent) },
    });
    body = await response.json();
  } catch (error) {
    if (isRateLimitDeferred(error) || error instanceof ShopCapabilityError) {
      throw error;
    }
    return {
      outcome: "ambiguous",
      code: "INCONCLUSIVE_RESPONSE",
      message:
        "Shopify did not return a conclusive order creation response; reconciliation is required.",
    };
  }

  const parsed = orderCreateResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      outcome: "ambiguous",
      code: "INVALID_RESPONSE",
      message:
        "Shopify returned an unexpected order creation response; reconciliation is required.",
    };
  }

  const topLevelError = classifyTopLevelErrors(parsed.data.errors);
  if (topLevelError) return topLevelError;

  const payload = parsed.data.data?.orderCreate;
  const userError = payload?.userErrors[0];
  if (userError) {
    return {
      outcome: "permanent-error",
      category: "SHOPIFY_USER_ERROR",
      code: userError.field?.join(".") || "ORDER_CREATE_USER_ERROR",
      message: sanitizeShopifyMessage(userError.message),
    };
  }
  if (!payload?.order) {
    return {
      outcome: "ambiguous",
      code: "ORDER_MISSING_FROM_RESPONSE",
      message:
        "Shopify did not confirm the created order; reconciliation is required.",
    };
  }

  return {
    outcome: "succeeded",
    orderGid: payload.order.id,
    orderName: payload.order.name,
  };
}

export function buildOrderCreateInput(intent: OrderIntentForCreate) {
  const shippingAddress = compactObject({
    firstName: intent.shippingFirstName,
    lastName: intent.shippingLastName,
    address1: intent.shippingAddress1,
    address2: intent.shippingAddress2,
    city: intent.shippingCity,
    province: intent.shippingProvince,
    provinceCode: intent.shippingProvinceCode,
    countryCode: intent.shippingCountryCode,
    zip: intent.shippingZip,
    phone: intent.shippingPhone,
  });

  return {
    email: intent.email,
    currency: intent.currency,
    processedAt: intent.processedAt.toISOString(),
    sourceIdentifier: intent.sourceIdentifier,
    tags: ["orderrelay", `orderrelay-source-${intent.sourceSystem}`],
    note: intent.note ?? undefined,
    shippingAddress:
      Object.keys(shippingAddress).length > 0 ? shippingAddress : undefined,
    lineItems: intent.orderLines.map((line) => ({
      variantId: line.shopifyVariantGid,
      quantity: line.quantity,
      priceSet: {
        shopMoney: {
          amount: line.unitPrice.toFixed(2),
          currencyCode: intent.currency,
        },
      },
    })),
  };
}

function classifyTopLevelErrors(
  errors: Array<z.infer<typeof graphqlErrorSchema>> | undefined,
): ShopifyOrderCreateResult | null {
  if (!errors?.length) return null;
  const error = errors[0];
  const code = error.extensions?.code ?? "GRAPHQL_ERROR";
  const message = sanitizeShopifyMessage(
    error.message ?? "Shopify rejected the order request.",
  );

  if (code === "THROTTLED") {
    return { outcome: "retry", category: "THROTTLED", code, message };
  }
  if (code === "ACCESS_DENIED") {
    return {
      outcome: "permanent-error",
      category: "MISSING_SCOPE",
      code,
      message: "Shopify order access is unavailable for this shop.",
    };
  }
  if (code === "INTERNAL_SERVER_ERROR") {
    return {
      outcome: "ambiguous",
      code,
      message:
        "Shopify returned an inconclusive server response; reconciliation is required.",
    };
  }
  return {
    outcome: "permanent-error",
    category: "INTERNAL_BUG",
    code,
    message,
  };
}

function compactObject(values: Record<string, string | null>) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] =>
      Boolean(entry[1]),
    ),
  );
}

function sanitizeShopifyMessage(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isRateLimitDeferred(error: unknown) {
  return (
    error instanceof Error && error.name === "ShopifyRateLimitDeferredError"
  );
}
