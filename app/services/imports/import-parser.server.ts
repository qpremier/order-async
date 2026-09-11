import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createHash } from "node:crypto";
import { parse } from "csv-parse";
import { z } from "zod";
import { normalizeSku } from "../catalog/catalog-cache.server.js";

const REQUIRED_COLUMNS = [
  "external_order_id",
  "processed_at",
  "email",
  "currency",
  "sku",
  "quantity",
  "unit_price",
] as const;

const OPTIONAL_COLUMNS = [
  "shipping_first_name",
  "shipping_last_name",
  "shipping_address1",
  "shipping_address2",
  "shipping_city",
  "shipping_province",
  "shipping_province_code",
  "shipping_country_code",
  "shipping_zip",
  "shipping_phone",
  "note",
] as const;

const ALLOWED_COLUMNS = new Set<string>([
  ...REQUIRED_COLUMNS,
  ...OPTIONAL_COLUMNS,
]);

const nonEmpty = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => value || null);

const rowSchema = z.object({
  external_order_id: nonEmpty(128),
  processed_at: z.string().trim().datetime({ offset: true }),
  email: z.string().trim().email().max(320),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  sku: nonEmpty(255),
  quantity: z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number(value) <= 1_000_000, "must be 1,000,000 or less"),
  unit_price: z
    .string()
    .trim()
    .regex(
      /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/,
      "must be a non-negative decimal with at most two decimal places",
    ),
  shipping_first_name: optionalText(100),
  shipping_last_name: optionalText(100),
  shipping_address1: optionalText(255),
  shipping_address2: optionalText(255),
  shipping_city: optionalText(100),
  shipping_province: optionalText(100),
  shipping_province_code: optionalText(20),
  shipping_country_code: z
    .string()
    .trim()
    .max(2)
    .refine((value) => value === "" || /^[A-Za-z]{2}$/.test(value))
    .transform((value) => value.toUpperCase() || null),
  shipping_zip: optionalText(32),
  shipping_phone: optionalText(32),
  note: optionalText(5_000),
});

type CsvRow = z.infer<typeof rowSchema>;

export interface ImportValidationIssue {
  row: number | null;
  field: string | null;
  message: string;
}

export class ImportValidationError extends Error {
  readonly issues: ImportValidationIssue[];

  constructor(issues: ImportValidationIssue[]) {
    super("The CSV could not be imported");
    this.name = "ImportValidationError";
    this.issues = issues.slice(0, 50);
  }
}

export class ImportLimitError extends ImportValidationError {
  constructor(message: string) {
    super([{ row: null, field: null, message }]);
    this.name = "ImportLimitError";
  }
}

export interface CanonicalOrderLine {
  originalSku: string;
  normalizedSku: string;
  quantity: number;
  unitPrice: string;
}

export interface CanonicalImportOrder {
  externalOrderId: string;
  processedAt: string;
  email: string;
  currency: string;
  shippingFirstName: string | null;
  shippingLastName: string | null;
  shippingAddress1: string | null;
  shippingAddress2: string | null;
  shippingCity: string | null;
  shippingProvince: string | null;
  shippingProvinceCode: string | null;
  shippingCountryCode: string | null;
  shippingZip: string | null;
  shippingPhone: string | null;
  note: string | null;
  lines: CanonicalOrderLine[];
  payloadHash: string;
}

export async function parseImportCsv(
  file: File,
  limits: { maxBytes: number; maxRows: number },
): Promise<CanonicalImportOrder[]> {
  if (file.size === 0) {
    throw new ImportValidationError([
      { row: null, field: "file", message: "Choose a non-empty CSV file." },
    ]);
  }

  if (file.size > limits.maxBytes) {
    throw new ImportLimitError(
      `The file exceeds the ${formatBytes(limits.maxBytes)} upload limit.`,
    );
  }

  let byteCount = 0;
  const byteLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteCount += chunk.byteLength;
      if (byteCount > limits.maxBytes) {
        callback(
          new ImportLimitError(
            `The file exceeds the ${formatBytes(limits.maxBytes)} upload limit.`,
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });

  let headersValidated = false;
  const parser = parse<Record<string, string>>({
    bom: true,
    columns(headers: string[]) {
      const normalized = headers.map((header) => header.trim());
      validateHeaders(normalized);
      headersValidated = true;
      return normalized;
    },
    skip_empty_lines: true,
    relax_column_count: false,
    max_record_size: limits.maxBytes,
  });

  Readable.fromWeb(file.stream() as unknown as NodeReadableStream<Uint8Array>)
    .pipe(byteLimiter)
    .pipe(parser);

  const rows: Array<{ rowNumber: number; value: CsvRow }> = [];
  const issues: ImportValidationIssue[] = [];
  let recordCount = 0;

  try {
    for await (const untrustedRecord of parser) {
      recordCount += 1;
      if (recordCount > limits.maxRows) {
        throw new ImportLimitError(
          `The CSV exceeds the ${limits.maxRows.toLocaleString("en-US")} row limit.`,
        );
      }

      const rowNumber = recordCount + 1;
      const record = toStringRecord(untrustedRecord);
      const parsed = rowSchema.safeParse(withOptionalDefaults(record));

      if (!parsed.success) {
        const remainingIssueSlots = Math.max(0, 50 - issues.length);
        issues.push(
          ...parsed.error.issues.slice(0, remainingIssueSlots).map((issue) => ({
            row: rowNumber,
            field: issue.path[0]?.toString() ?? null,
            message: friendlyValidationMessage(
              issue.path[0]?.toString(),
              issue.message,
            ),
          })),
        );
        continue;
      }

      rows.push({ rowNumber, value: normalizeRow(parsed.data) });
    }
  } catch (error) {
    if (error instanceof ImportValidationError) {
      throw error;
    }

    throw new ImportValidationError([
      {
        row: null,
        field: "file",
        message: "The file is not valid CSV or has inconsistent columns.",
      },
    ]);
  }

  if (!headersValidated || rows.length === 0) {
    issues.push({
      row: null,
      field: "file",
      message: "The CSV must contain a header and at least one data row.",
    });
  }

  if (issues.length > 0) {
    throw new ImportValidationError(issues);
  }

  return groupCanonicalOrders(rows);
}

function validateHeaders(headers: string[]) {
  if (new Set(headers).size !== headers.length) {
    throw new ImportValidationError([
      { row: 1, field: null, message: "CSV headers must not be duplicated." },
    ]);
  }

  const missing = REQUIRED_COLUMNS.filter(
    (column) => !headers.includes(column),
  );
  const unknown = headers.filter((column) => !ALLOWED_COLUMNS.has(column));
  const issues: ImportValidationIssue[] = [];

  if (missing.length > 0) {
    issues.push({
      row: 1,
      field: null,
      message: `Missing required columns: ${missing.join(", ")}.`,
    });
  }
  if (unknown.length > 0) {
    issues.push({
      row: 1,
      field: null,
      message: `Unsupported columns: ${unknown.join(", ")}.`,
    });
  }
  if (issues.length > 0) {
    throw new ImportValidationError(issues);
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => [
      key,
      typeof fieldValue === "string" ? fieldValue : "",
    ]),
  );
}

function withOptionalDefaults(record: Record<string, string>) {
  return Object.fromEntries(
    [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].map((column) => [
      column,
      record[column] ?? "",
    ]),
  );
}

function normalizeRow(row: CsvRow): CsvRow {
  return {
    ...row,
    processed_at: new Date(row.processed_at).toISOString(),
    email: row.email.toLowerCase(),
    currency: row.currency.toUpperCase(),
    shipping_province_code: row.shipping_province_code?.toUpperCase() ?? null,
  };
}

function groupCanonicalOrders(
  rows: Array<{ rowNumber: number; value: CsvRow }>,
): CanonicalImportOrder[] {
  const groups = new Map<string, Array<{ rowNumber: number; value: CsvRow }>>();
  for (const row of rows) {
    const group = groups.get(row.value.external_order_id) ?? [];
    group.push(row);
    groups.set(row.value.external_order_id, group);
  }

  const issues: ImportValidationIssue[] = [];
  const orders: CanonicalImportOrder[] = [];
  for (const [externalOrderId, group] of groups) {
    const first = group[0].value;
    const orderFields = canonicalOrderFields(first);

    for (const row of group.slice(1)) {
      if (
        JSON.stringify(canonicalOrderFields(row.value)) !==
        JSON.stringify(orderFields)
      ) {
        issues.push({
          row: row.rowNumber,
          field: "external_order_id",
          message: `Order ${externalOrderId} has inconsistent order-level values.`,
        });
      }
    }

    const lines = group
      .map(({ value }) => ({
        originalSku: value.sku,
        normalizedSku: normalizeSku(value.sku) ?? "",
        quantity: Number(value.quantity),
        unitPrice: normalizeMoney(value.unit_price),
      }))
      .sort(compareLines);
    const canonicalPayload = { externalOrderId, ...orderFields, lines };

    orders.push({
      ...canonicalPayload,
      payloadHash: createHash("sha256")
        .update(JSON.stringify(canonicalPayload))
        .digest("hex"),
    });
  }

  if (issues.length > 0) {
    throw new ImportValidationError(issues);
  }

  return orders;
}

function canonicalOrderFields(row: CsvRow) {
  return {
    processedAt: row.processed_at,
    email: row.email,
    currency: row.currency,
    shippingFirstName: row.shipping_first_name,
    shippingLastName: row.shipping_last_name,
    shippingAddress1: row.shipping_address1,
    shippingAddress2: row.shipping_address2,
    shippingCity: row.shipping_city,
    shippingProvince: row.shipping_province,
    shippingProvinceCode: row.shipping_province_code,
    shippingCountryCode: row.shipping_country_code,
    shippingZip: row.shipping_zip,
    shippingPhone: row.shipping_phone,
    note: row.note,
  };
}

function compareLines(a: CanonicalOrderLine, b: CanonicalOrderLine) {
  return (
    a.normalizedSku.localeCompare(b.normalizedSku) ||
    a.originalSku.localeCompare(b.originalSku) ||
    a.unitPrice.localeCompare(b.unitPrice) ||
    a.quantity - b.quantity
  );
}

function normalizeMoney(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function friendlyValidationMessage(
  field: string | undefined,
  fallback: string,
) {
  switch (field) {
    case "quantity":
      return "Quantity must be a positive whole number no greater than 1,000,000.";
    case "unit_price":
      return "Unit price must be a non-negative decimal with at most two decimal places.";
    case "processed_at":
      return "Processed at must be an ISO 8601 timestamp with a timezone.";
    case "currency":
      return "Currency must be a three-letter code such as USD.";
    case "shipping_country_code":
      return "Shipping country code must be a two-letter code.";
    default:
      return fallback;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.floor(bytes / 1024))} KB`;
  }
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}
