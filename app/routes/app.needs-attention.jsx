import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  AttentionRequestError,
  listNeedsAttentionPage,
  replayDeadLetterOrder,
  requestAmbiguousReconciliation,
} from "../services/orders/order-attention.server";
import { InvalidCursorError } from "../services/pagination/cursor.server";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 20;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  try {
    const cursor = new URL(request.url).searchParams.get("cursor");
    const page = await listNeedsAttentionPage(db, {
      shopId: shop.id,
      cursor,
      first: PAGE_SIZE,
    });
    return {
      items: page.items.map((intent) => ({
        id: intent.id,
        externalOrderId: intent.externalOrderId,
        status: intent.status,
        lastErrorCategory: intent.lastErrorCategory,
        sanitizedLastError: intent.sanitizedLastError,
        sourceSystem: intent.sourceSystem,
        createdAt: intent.createdAt.toISOString(),
        importBatch: intent.originatingBatch,
        unresolvedSkus: intent.orderLines
          .filter((line) => line.validationStatus !== "VALID")
          .map((line) => line.originalSku),
        deadLetter: intent.deadLetterRecords[0]
          ? {
              id: intent.deadLetterRecords[0].id,
              attempts: intent.deadLetterRecords[0].attempts,
              errorCategory: intent.deadLetterRecords[0].errorCategory,
              errorCode: intent.deadLetterRecords[0].errorCode,
              sanitizedMessage: intent.deadLetterRecords[0].sanitizedMessage,
              replayedAt:
                intent.deadLetterRecords[0].replayedAt?.toISOString() ?? null,
            }
          : null,
      })),
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    };
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new Response("Invalid cursor", { status: 400 });
    }
    throw error;
  }
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const formData = await request.formData();
  const actionIntent = formData.get("intent");
  const orderIntentId = formData.get("orderIntentId");
  if (typeof orderIntentId !== "string" || !orderIntentId) {
    throw new Response("Order not found", { status: 400 });
  }

  try {
    const result =
      actionIntent === "replay"
        ? await replayDeadLetterOrder(db, {
            shopId: shop.id,
            orderIntentId,
            replayedBy: "merchant",
          })
        : actionIntent === "reconcile"
          ? await requestAmbiguousReconciliation(db, {
              shopId: shop.id,
              orderIntentId,
            })
          : null;
    if (!result) throw new Response("Unsupported action", { status: 400 });
    return Response.json(result, {
      status: result.status === "queued" ? 202 : 200,
    });
  } catch (error) {
    if (error instanceof AttentionRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
};

export default function NeedsAttention() {
  const page = useLoaderData();
  const actionData = useActionData();

  return (
    <s-page heading="Needs attention" inlineSize="base">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Review mapping problems, permanent failures, and inconclusive
            Shopify results. Replays keep the original order identity.
          </s-paragraph>
          {actionData?.error && (
            <s-banner heading="Order work was not queued" tone="critical">
              {actionData.error}
            </s-banner>
          )}
          {page.items.length === 0 ? (
            <s-paragraph>No orders currently need attention.</s-paragraph>
          ) : (
            page.items.map((intent) => (
              <s-box
                key={intent.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base">
                    <s-heading>{intent.externalOrderId}</s-heading>
                    <s-text>{formatStatus(intent.status)}</s-text>
                  </s-stack>
                  <s-paragraph>
                    {intent.sourceSystem} ·{" "}
                    {intent.importBatch.originalFileName}
                  </s-paragraph>
                  <s-link href={`/app/imports/${intent.importBatch.id}`}>
                    Open import details
                  </s-link>
                  {intent.unresolvedSkus.length > 0 && (
                    <s-text>
                      Resolve SKU mapping: {intent.unresolvedSkus.join(", ")}
                    </s-text>
                  )}
                  {(intent.deadLetter?.sanitizedMessage ||
                    intent.sanitizedLastError) && (
                    <s-banner heading="Safe error details" tone="critical">
                      {intent.deadLetter?.sanitizedMessage ||
                        intent.sanitizedLastError}
                    </s-banner>
                  )}
                  {intent.deadLetter && (
                    <s-text>
                      Attempts: {intent.deadLetter.attempts}
                      {intent.deadLetter.errorCode
                        ? ` · Code: ${intent.deadLetter.errorCode}`
                        : ""}
                    </s-text>
                  )}
                  {intent.status === "DEAD_LETTER" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="replay" />
                      <input
                        type="hidden"
                        name="orderIntentId"
                        value={intent.id}
                      />
                      <s-button type="submit">Replay safely</s-button>
                    </Form>
                  )}
                  {intent.status === "AMBIGUOUS_RESULT" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="reconcile" />
                      <input
                        type="hidden"
                        name="orderIntentId"
                        value={intent.id}
                      />
                      <s-button type="submit">Recheck Shopify</s-button>
                    </Form>
                  )}
                </s-stack>
              </s-box>
            ))
          )}
          {page.hasNextPage && page.endCursor && (
            <s-link href={`/app/needs-attention?cursor=${page.endCursor}`}>
              Next orders
            </s-link>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function formatStatus(status) {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
