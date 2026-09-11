import { useEffect, useState } from "react";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  createDraftImport,
  ImportRequestError,
} from "../services/imports/import-domain.server";
import {
  ImportValidationError,
  parseImportCsv,
} from "../services/imports/import-parser.server";
import { getEnvironment } from "../services/security/environment.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const environment = getEnvironment();
  const formData = await request.formData();
  const file = formData.get("file");
  const sourceSystem = formData.get("sourceSystem");
  const idempotencyKey = formData.get("idempotencyKey");

  try {
    if (!(file instanceof File)) {
      throw new ImportRequestError("Choose a CSV file to upload.", {
        field: "file",
      });
    }
    if (
      typeof sourceSystem !== "string" ||
      typeof idempotencyKey !== "string"
    ) {
      throw new ImportRequestError("The import form is incomplete.");
    }

    const orders = await parseImportCsv(file, {
      maxBytes: environment.IMPORT_MAX_BYTES,
      maxRows: environment.IMPORT_MAX_ROWS,
    });
    const result = await createDraftImport(db, {
      shopDomain: session.shop,
      grantedScopes: session.scope,
      sourceSystem,
      originalFileName: file.name,
      idempotencyKey,
      orders,
    });

    return redirect(`/app/imports/${result.batch.id}`);
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return Response.json(
        { errors: error.issues, sourceSystem: safeString(sourceSystem) },
        { status: 422 },
      );
    }
    if (error instanceof ImportRequestError) {
      return Response.json(
        {
          errors: [{ row: null, field: error.field, message: error.message }],
          sourceSystem: safeString(sourceSystem),
        },
        { status: error.status },
      );
    }
    throw error;
  }
};

export default function NewImport() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const [idempotencyKey, setIdempotencyKey] = useState("");

  useEffect(() => {
    setIdempotencyKey(window.crypto.randomUUID());
  }, []);

  const isSubmitting = navigation.state !== "idle";

  return (
    <s-page heading="New import" inlineSize="base">
      <s-section heading="Upload external orders">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload a CSV with one row per order line. Rows sharing an external
            order ID are grouped into one order preview.
          </s-paragraph>

          {actionData?.errors?.length > 0 && (
            <s-banner heading="Fix the CSV and try again" tone="critical">
              <s-unordered-list>
                {actionData.errors.map((error, index) => (
                  <s-list-item key={`${error.row}-${error.field}-${index}`}>
                    {formatIssue(error)}
                  </s-list-item>
                ))}
              </s-unordered-list>
            </s-banner>
          )}

          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Source system identifier"
                name="sourceSystem"
                placeholder="erp-main"
                value={actionData?.sourceSystem ?? ""}
                required
              ></s-text-field>
              <s-paragraph>
                Use letters, numbers, periods, underscores, or hyphens. This
                identifier becomes part of the external-order identity.
              </s-paragraph>
              <s-drop-zone
                label="Orders CSV"
                accessibilityLabel="Upload external orders CSV"
                name="file"
                accept=".csv,text/csv"
                required
              ></s-drop-zone>
              <s-button
                type="submit"
                variant="primary"
                disabled={!idempotencyKey || isSubmitting}
                {...(isSubmitting ? { loading: true } : {})}
              >
                Validate and preview
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Required columns">
        <s-paragraph>
          external_order_id, processed_at, email, currency, sku, quantity,
          unit_price
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function formatIssue(issue) {
  const location = [
    issue.row ? `Row ${issue.row}` : null,
    issue.field && issue.field !== "file" ? issue.field : null,
  ]
    .filter(Boolean)
    .join(", ");
  return location ? `${location}: ${issue.message}` : issue.message;
}

function safeString(value) {
  return typeof value === "string" ? value.slice(0, 64) : "";
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
