import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  getImportDetails,
  ImportRequestError,
  listMappingCandidates,
} from "../services/imports/import-domain.server";
import { applySkuMapping } from "../services/imports/sku-mapping.server";
import { InvalidCursorError } from "../services/pagination/cursor.server";
import { authenticate } from "../shopify.server";

const ORDER_PAGE_SIZE = 20;

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Import not found", { status: 404 });

  const cursor = new URL(request.url).searchParams.get("cursor");
  const variantQuery = new URL(request.url).searchParams.get("variantQuery");
  try {
    const details = await getImportDetails(db, {
      shopId: shop.id,
      batchId: params.batchId,
      cursor,
      first: ORDER_PAGE_SIZE,
    });
    if (!details) throw new Response("Import not found", { status: 404 });

    const unresolvedSkus = [
      ...new Set(
        details.intentsPage.items.flatMap((intent) =>
          intent.orderLines
            .filter((line) => line.validationStatus !== "VALID")
            .map((line) => line.normalizedSku),
        ),
      ),
    ];
    const candidates =
      unresolvedSkus.length > 0
        ? await listMappingCandidates(db, {
            shopId: shop.id,
            normalizedSkus: unresolvedSkus,
            query: variantQuery,
          })
        : [];

    return {
      cursor: cursor ?? "",
      variantQuery: variantQuery ?? "",
      batch: serializeBatch(details.batch),
      intentsPage: {
        items: details.intentsPage.items.map((intent) => ({
          id: intent.id,
          externalOrderId: intent.externalOrderId,
          status: intent.status,
          reused: intent.importBatchLinks[0]?.reused ?? false,
          createdAt: intent.createdAt.toISOString(),
          lines: intent.orderLines.map((line) => ({
            id: line.id,
            originalSku: line.originalSku,
            normalizedSku: line.normalizedSku,
            quantity: line.quantity,
            unitPrice: line.unitPrice.toString(),
            shopifyVariantGid: line.shopifyVariantGid,
            validationStatus: line.validationStatus,
            validationMessage: line.validationMessage,
          })),
        })),
        hasNextPage: details.intentsPage.hasNextPage,
        endCursor: details.intentsPage.endCursor,
      },
      candidates: candidates.map((variant) => ({
        id: variant.id,
        shopifyVariantGid: variant.shopifyVariantGid,
        productTitle: variant.productTitle,
        variantTitle: variant.variantTitle,
        sku: variant.sku,
      })),
    };
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw new Response("Invalid cursor", { status: 400 });
    }
    throw error;
  }
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Import not found", { status: 404 });

  const formData = await request.formData();
  if (formData.get("intent") !== "map-sku") {
    throw new Response("Unsupported action", { status: 400 });
  }

  try {
    const normalizedSku = formData.get("normalizedSku");
    const shopifyVariantGid = formData.get("shopifyVariantGid");
    if (
      typeof normalizedSku !== "string" ||
      typeof shopifyVariantGid !== "string"
    ) {
      throw new ImportRequestError("Choose a catalog variant.");
    }
    await applySkuMapping(db, {
      shopId: shop.id,
      batchId: params.batchId,
      normalizedSku,
      shopifyVariantGid,
    });
    const cursor = formData.get("cursor");
    const variantQuery = formData.get("variantQuery");
    const search = new URLSearchParams();
    if (typeof cursor === "string" && cursor) search.set("cursor", cursor);
    if (typeof variantQuery === "string" && variantQuery) {
      search.set("variantQuery", variantQuery);
    }
    const query = search.size > 0 ? `?${search.toString()}` : "";
    return redirect(`/app/imports/${params.batchId}${query}`);
  } catch (error) {
    if (error instanceof ImportRequestError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
};

export default function ImportDetails() {
  const { batch, intentsPage, candidates, cursor, variantQuery } =
    useLoaderData();
  const actionData = useActionData();

  return (
    <s-page heading={`Import ${batch.originalFileName}`} inlineSize="base">
      <s-section heading="Preview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            {renderMetric("Status", formatStatus(batch.status))}
            {renderMetric("Orders", String(batch.totalOrders))}
            {renderMetric("Ready", String(batch.readyOrders))}
            {renderMetric("Needs mapping", String(batch.needsAttentionOrders))}
          </s-stack>
          <s-paragraph>
            Source: {batch.sourceSystem}. Uploaded{" "}
            {formatDateTime(batch.createdAt)}.
          </s-paragraph>
          {actionData?.error && (
            <s-banner heading="Mapping was not saved" tone="critical">
              {actionData.error}
            </s-banner>
          )}
          {batch.needsAttentionOrders > 0 && (
            <s-banner
              heading="Resolve mappings before confirmation"
              tone="warning"
            >
              Only affected orders are blocked. Ready orders remain ready in
              this draft.
            </s-banner>
          )}
          {batch.needsAttentionOrders > 0 && (
            <Form method="get">
              <input type="hidden" name="cursor" value={cursor} />
              <s-stack direction="inline" gap="base" alignItems="end">
                <s-text-field
                  label="Find mapping candidates"
                  name="variantQuery"
                  value={variantQuery}
                  placeholder="Search product title or SKU"
                ></s-text-field>
                <s-button type="submit">Search catalog</s-button>
              </s-stack>
            </Form>
          )}
          {batch.readyOrders === batch.totalOrders && (
            <s-banner heading="Draft is ready" tone="success">
              Order creation and batch confirmation begin in Phase 5 and are
              intentionally unavailable in this phase.
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Orders">
        <s-stack direction="block" gap="base">
          {intentsPage.items.map((intent) => (
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
                  {intent.reused && (
                    <s-text>Reused existing order intent</s-text>
                  )}
                </s-stack>
                {intent.lines.map((line) => (
                  <s-box
                    key={line.id}
                    padding="small"
                    background="subdued"
                    borderRadius="base"
                  >
                    <s-stack direction="block" gap="small">
                      <s-paragraph>
                        SKU {line.originalSku} · quantity {line.quantity} ·{" "}
                        {line.unitPrice}
                      </s-paragraph>
                      {line.validationMessage && (
                        <s-text>{line.validationMessage}</s-text>
                      )}
                      {line.validationStatus !== "VALID" &&
                        renderMappingForm(
                          line,
                          candidates,
                          cursor,
                          variantQuery,
                        )}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            </s-box>
          ))}
          {intentsPage.hasNextPage && intentsPage.endCursor && (
            <s-link
              href={`/app/imports/${batch.id}?cursor=${intentsPage.endCursor}`}
            >
              Next orders
            </s-link>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function renderMappingForm(line, candidates, cursor, variantQuery) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="map-sku" />
      <input type="hidden" name="normalizedSku" value={line.normalizedSku} />
      <input type="hidden" name="cursor" value={cursor} />
      <input type="hidden" name="variantQuery" value={variantQuery} />
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-select
          label={`Map ${line.originalSku} to`}
          name="shopifyVariantGid"
          required
        >
          <s-option value="">Choose a cached variant</s-option>
          {candidates.map((variant) => (
            <s-option key={variant.id} value={variant.shopifyVariantGid}>
              {variant.productTitle} —{" "}
              {variant.variantTitle || "Default variant"} (
              {variant.sku || "no SKU"})
            </s-option>
          ))}
        </s-select>
        <s-button type="submit">Save mapping</s-button>
      </s-stack>
    </Form>
  );
}

function serializeBatch(batch) {
  return {
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}

function renderMetric(label, value) {
  return (
    <s-box key={label} padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-text>{label}</s-text>
        <s-heading>{value}</s-heading>
      </s-stack>
    </s-box>
  );
}

function formatStatus(status) {
  return status
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
