import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  getCatalogCacheStatus,
  listCatalogVariantsPage,
} from "../services/catalog/catalog-cache.server";
import { requestCatalogFullSync } from "../services/catalog/catalog-sync-request.server";
import { listImportBatchesPage } from "../services/imports/import-domain.server";
import { InvalidCursorError } from "../services/pagination/cursor.server";
import { getEnvironment } from "../services/security/environment.server";
import { authenticate } from "../shopify.server";

const VARIANT_PAGE_SIZE = 10;
const IMPORT_PAGE_SIZE = 5;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const environment = getEnvironment();
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const importCursor = url.searchParams.get("importCursor");
  const shop = await db.shop.upsert({
    where: {
      domain: session.shop,
    },
    create: {
      domain: session.shop,
      grantedScopes: session.scope,
    },
    update: {
      grantedScopes: session.scope,
      status: "ACTIVE",
      uninstalledAt: null,
    },
  });

  try {
    const [cacheStatus, variantsPage, importsPage] = await Promise.all([
      getCatalogCacheStatus(db, {
        shopId: shop.id,
        staleAfterMinutes: environment.CATALOG_STALE_AFTER_MINUTES,
      }),
      listCatalogVariantsPage(db, {
        shopId: shop.id,
        cursor,
        first: VARIANT_PAGE_SIZE,
      }),
      listImportBatchesPage(db, {
        shopId: shop.id,
        cursor: importCursor,
        first: IMPORT_PAGE_SIZE,
      }),
    ]);

    return {
      cacheStatus: {
        ...cacheStatus,
        lastCatalogSyncAt: cacheStatus.lastCatalogSyncAt?.toISOString() ?? null,
        runningSyncStartedAt:
          cacheStatus.runningSyncStartedAt?.toISOString() ?? null,
      },
      variantsPage: {
        items: variantsPage.items.map((variant) => ({
          id: variant.id,
          productTitle: variant.productTitle,
          variantTitle: variant.variantTitle,
          sku: variant.sku,
          normalizedSku: variant.normalizedSku,
          price: variant.price?.toString() ?? null,
          cachedAt: variant.cachedAt.toISOString(),
        })),
        hasNextPage: variantsPage.hasNextPage,
        endCursor: variantsPage.endCursor,
      },
      importsPage: {
        items: importsPage.items.map((batch) => ({
          id: batch.id,
          sourceSystem: batch.sourceSystem,
          originalFileName: batch.originalFileName,
          status: batch.status,
          totalOrders: batch.totalOrders,
          readyOrders: batch.readyOrders,
          needsAttentionOrders: batch.needsAttentionOrders,
          createdAt: batch.createdAt.toISOString(),
        })),
        hasNextPage: importsPage.hasNextPage,
        endCursor: importsPage.endCursor,
      },
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
  const formData = await request.formData();

  if (formData.get("intent") !== "catalog-sync") {
    throw new Response("Unsupported action", { status: 400 });
  }

  const result = await requestCatalogFullSync(db, {
    shopDomain: session.shop,
    grantedScopes: session.scope,
    requestedBy: "merchant",
  });

  return Response.json(
    {
      syncRunId: result.syncRunId,
      outboxEventId: result.outboxEventId,
      created: result.created,
    },
    {
      status: result.created ? 202 : 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};

export default function Index() {
  const { cacheStatus, variantsPage, importsPage } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSyncing =
    fetcher.state !== "idle" || cacheStatus.status === "SYNCING";

  useEffect(() => {
    if (fetcher.data?.syncRunId) {
      shopify.toast.show(
        fetcher.data.created
          ? "Catalog sync queued"
          : "Catalog sync already running",
      );
    }
  }, [fetcher.data, shopify]);

  return (
    <s-page heading="OrderRelay">
      <fetcher.Form method="post" slot="primary-action">
        <input type="hidden" name="intent" value="catalog-sync" />
        <s-button type="submit" {...(isSyncing ? { loading: true } : {})}>
          Sync catalog
        </s-button>
      </fetcher.Form>

      <s-section heading="External order imports">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload, validate, and resolve catalog mappings before creating
            Shopify orders.
          </s-paragraph>
          <s-link href="/app/imports/new">Start new import</s-link>
        </s-stack>
      </s-section>

      <s-section heading="Catalog cache">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            {renderMetric("Status", formatStatus(cacheStatus.status))}
            {renderMetric(
              "Active variants",
              String(cacheStatus.activeVariantCount),
            )}
            {renderMetric(
              "Ambiguous SKUs",
              String(cacheStatus.ambiguousSkuCount),
            )}
          </s-stack>
          <s-paragraph>
            <s-text>Last sync: </s-text>
            <s-text>{formatDateTime(cacheStatus.lastCatalogSyncAt)}</s-text>
          </s-paragraph>
          {cacheStatus.runningSyncStartedAt && (
            <s-paragraph>
              <s-text>Running since: </s-text>
              <s-text>
                {formatDateTime(cacheStatus.runningSyncStartedAt)}
              </s-text>
            </s-paragraph>
          )}
          {cacheStatus.isStale && (
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-text>Catalog cache is stale.</s-text>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Recent imports">
        {importsPage.items.length > 0 ? (
          <s-stack direction="block" gap="base">
            {importsPage.items.map((batch) => (
              <s-box
                key={batch.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-link href={`/app/imports/${batch.id}`}>
                    {batch.originalFileName}
                  </s-link>
                  <s-paragraph>
                    {batch.sourceSystem} · {formatStatus(batch.status)} ·{" "}
                    {batch.readyOrders}/{batch.totalOrders} ready
                  </s-paragraph>
                  {batch.needsAttentionOrders > 0 && (
                    <s-text>
                      {batch.needsAttentionOrders} order(s) need mapping
                    </s-text>
                  )}
                </s-stack>
              </s-box>
            ))}
            {importsPage.hasNextPage && importsPage.endCursor && (
              <s-link href={`/app?importCursor=${importsPage.endCursor}`}>
                Next imports
              </s-link>
            )}
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>No imports yet.</s-paragraph>
            <s-link href="/app/imports/new">Start your first import</s-link>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Cached variants">
        {variantsPage.items.length > 0 ? (
          <s-stack direction="block" gap="base">
            {variantsPage.items.map((variant) => (
              <s-box
                key={variant.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="small">
                  <s-heading>{variant.productTitle}</s-heading>
                  <s-paragraph>
                    <s-text>{variant.variantTitle || "Default variant"}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text>SKU: </s-text>
                    <s-text>{variant.sku || "None"}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text>Price: </s-text>
                    <s-text>{variant.price || "Not cached"}</s-text>
                  </s-paragraph>
                </s-stack>
              </s-box>
            ))}
            {variantsPage.hasNextPage && variantsPage.endCursor && (
              <s-link href={`/app?cursor=${variantsPage.endCursor}`}>
                Next variants
              </s-link>
            )}
          </s-stack>
        ) : (
          <s-paragraph>No cached variants yet.</s-paragraph>
        )}
      </s-section>
    </s-page>
  );
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
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
