import db from "../db.server";
import { createPhase2DiagnosticOutboxEvent } from "../services/diagnostics/phase2-diagnostic.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const idempotencyKey = await readIdempotencyKey(request);
  const result = await createPhase2DiagnosticOutboxEvent(db, {
    shopDomain: session.shop,
    grantedScopes: session.scope,
    idempotencyKey,
  });

  return Response.json(
    {
      diagnosticId: result.diagnosticId,
      outboxEventId: result.event.id,
      outboxCreated: result.created,
      published: Boolean(result.event.publishedAt),
    },
    {
      status: result.created ? 202 : 200,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};

async function readIdempotencyKey(request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => undefined);

    return isRecord(body) && typeof body.idempotencyKey === "string"
      ? body.idempotencyKey
      : undefined;
  }

  const formData = await request.formData().catch(() => undefined);
  const value = formData?.get("idempotencyKey");

  return typeof value === "string" ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
