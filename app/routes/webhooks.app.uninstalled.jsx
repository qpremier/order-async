import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ingestAppLifecycleWebhook } from "../services/webhooks/app-lifecycle.server";

export const action = async ({ request }) => {
  const { payload, shop, session, topic, webhookId } =
    await authenticate.webhook(request);
  await ingestAppLifecycleWebhook(db, {
    shopDomain: shop,
    topic,
    webhookId,
    payload,
    sessionScopes: session?.scope,
  });

  return new Response();
};
