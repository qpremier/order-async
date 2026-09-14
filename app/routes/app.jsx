import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import db from "../db.server";
import { syncAuthenticatedShop } from "../services/shops/shop-capabilities.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await syncAuthenticatedShop(db, {
    shopDomain: session.shop,
    grantedScopes: session.scope,
    authenticatedSessionId: session.id,
  });

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    needsReauth: shop.status === "NEEDS_REAUTH",
  };
};

export default function App() {
  const { apiKey, needsReauth } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/imports/new">New import</s-link>
        <s-link href="/app/needs-attention">Needs attention</s-link>
      </s-app-nav>
      {needsReauth && (
        <s-banner heading="Order access needs authorization" tone="warning">
          Order creation is paused until the app has the write_orders scope.
        </s-banner>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 401) {
    return (
      <s-page heading="Authentication needs to be refreshed" inlineSize="base">
        <s-section>
          <s-banner
            heading="Session expired or system clock is incorrect"
            tone="warning"
          >
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Shopify could not verify this request. This can happen when the
                short-lived session expires or this computer&apos;s date and
                time are out of sync.
              </s-paragraph>
              <s-paragraph>
                Turn on automatic date and time synchronization, then reload the
                app and try the action again.
              </s-paragraph>
              <s-button
                variant="primary"
                onClick={() => window.location.reload()}
              >
                Reload app
              </s-button>
            </s-stack>
          </s-banner>
        </s-section>
      </s-page>
    );
  }

  return boundary.error(error);
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
