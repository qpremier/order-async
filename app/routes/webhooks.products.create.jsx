import db from "../db.server";
import { ingestProductWebhook } from "../services/catalog/product-webhooks.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { eventId, payload, session, shop, topic, webhookId } =
    await authenticate.webhook(request);

  await ingestProductWebhook(db, {
    shopDomain: shop,
    topic,
    webhookId,
    eventId,
    payload,
    grantedScopes: session?.scope,
  });

  return new Response(null, { status: 202 });
};
