import { useEffect, useRef, useState } from "react";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  getImportDetails,
  ImportRequestError,
  listMappingCandidates,
} from "../services/imports/import-domain.server";
import { applySkuMapping } from "../services/imports/sku-mapping.server";
import { confirmImportBatch } from "../services/orders/order-state.server";
import { InvalidCursorError } from "../services/pagination/cursor.server";
import {
  nextImportPollDelay,
  shouldPollImport,
} from "../services/imports/import-polling";
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
          shopifyOrderGid: intent.shopifyOrderGid,
          shopifyOrderName: intent.shopifyOrderName,
          lastErrorCategory: intent.lastErrorCategory,
          sanitizedLastError: intent.sanitizedLastError,
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
  const actionIntent = formData.get("intent");
  if (actionIntent !== "map-sku" && actionIntent !== "confirm-batch") {
    throw new Response("Unsupported action", { status: 400 });
  }

  try {
    if (actionIntent === "confirm-batch") {
      await db.shop.update({
        where: { id: shop.id },
        data: { grantedScopes: session.scope },
      });
      await confirmImportBatch(db, {
        shopId: shop.id,
        batchId: params.batchId,
      });
      return redirect(`/app/imports/${params.batchId}`);
    }

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
  const liveStatus = useImportStatusPolling(batch);

  return (
    <s-page heading={`Import ${batch.originalFileName}`} inlineSize="base">
      <s-section heading="Preview">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            {renderMetric("Status", formatStatus(liveStatus.status))}
            {renderMetric("Orders", String(liveStatus.counts.total))}
            {renderMetric("Queued", String(liveStatus.counts.queued))}
            {renderMetric("Processing", String(liveStatus.counts.processing))}
            {renderMetric("Succeeded", String(liveStatus.counts.succeeded))}
            {renderMetric(
              "Needs attention",
              String(liveStatus.counts.needsAttention),
            )}
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
              this draft while you resolve the remaining mappings.
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
          {batch.status === "DRAFT" &&
            batch.needsAttentionOrders === 0 &&
            batch.failedOrders === 0 && (
              <Form method="post">
                <input type="hidden" name="intent" value="confirm-batch" />
                <s-button type="submit" variant="primary">
                  Confirm {batch.readyOrders} ready order(s)
                </s-button>
              </Form>
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
                {intent.shopifyOrderGid && (
                  <s-link href={shopifyAdminOrderHref(intent.shopifyOrderGid)}>
                    Open {intent.shopifyOrderName || "Shopify order"}
                  </s-link>
                )}
                {intent.sanitizedLastError && (
                  <s-banner
                    heading={
                      intent.lastErrorCategory === "AMBIGUOUS_WRITE_RESULT"
                        ? "Creation result is being reconciled"
                        : "Order could not be created"
                    }
                    tone={
                      intent.lastErrorCategory === "AMBIGUOUS_WRITE_RESULT"
                        ? "warning"
                        : "critical"
                    }
                  >
                    {intent.sanitizedLastError}
                  </s-banner>
                )}
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
                      {batch.status === "DRAFT" &&
                        line.validationStatus !== "VALID" &&
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
    confirmedAt: batch.confirmedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
  };
}

function shopifyAdminOrderHref(orderGid) {
  const numericId = orderGid.split("/").at(-1);
  return `shopify:admin/orders/${encodeURIComponent(numericId)}`;
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

function useImportStatusPolling(batch) {
  const initialStatus = toLiveStatus(batch);
  const [status, setStatus] = useState(initialStatus);
  const statusRef = useRef(initialStatus);
  const etagRef = useRef(null);

  useEffect(() => {
    const nextInitialStatus = toLiveStatus(batch);
    statusRef.current = nextInitialStatus;
    setStatus(nextInitialStatus);
    etagRef.current = null;

    let disposed = false;
    let inFlight = false;
    let timer;
    let unchangedResponses = 0;
    let controller;

    const schedule = (delay) => {
      if (
        disposed ||
        document.visibilityState === "hidden" ||
        !shouldPollImport(statusRef.current.status)
      ) {
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(poll, delay);
    };

    const poll = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      if (!shouldPollImport(statusRef.current.status)) return;

      inFlight = true;
      controller = new AbortController();
      try {
        const response = await fetch(`/app/api/imports/${batch.id}/status`, {
          credentials: "same-origin",
          headers: etagRef.current
            ? { "If-None-Match": etagRef.current }
            : undefined,
          signal: controller.signal,
        });
        if (response.status === 304) {
          unchangedResponses += 1;
        } else if (response.ok) {
          const nextStatus = await response.json();
          const changed = nextStatus.version !== statusRef.current.version;
          unchangedResponses = changed ? 0 : unchangedResponses + 1;
          statusRef.current = nextStatus;
          etagRef.current = response.headers.get("ETag");
          setStatus(nextStatus);
        } else {
          unchangedResponses += 1;
        }
      } catch (error) {
        if (error.name !== "AbortError") unchangedResponses += 1;
      } finally {
        inFlight = false;
        schedule(nextImportPollDelay(unchangedResponses));
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        controller?.abort();
      } else {
        schedule(0);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(nextImportPollDelay(0));

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [batch]);

  return status;
}

function toLiveStatus(batch) {
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
    updatedAt: batch.updatedAt,
  };
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
