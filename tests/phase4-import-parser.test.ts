import { describe, expect, it } from "vitest";
import {
  ImportLimitError,
  ImportValidationError,
  parseImportCsv,
} from "../app/services/imports/import-parser.server";

describe("Phase 4 streaming CSV parser", () => {
  it("groups rows and produces a stable canonical payload hash", async () => {
    const first = await parseImportCsv(
      csvFile(
        `${headers}\n${row("order-1", "SKU-B", "2", "10")}\n${row("order-1", "sku-a", "1", "4.5")}`,
      ),
      limits,
    );
    const reordered = await parseImportCsv(
      csvFile(
        `${headers}\n${row("order-1", "sku-a", "1", "4.50")}\n${row("order-1", "SKU-B", "2", "10.00")}`,
      ),
      limits,
    );

    expect(first).toHaveLength(1);
    expect(first[0].lines.map((line) => line.normalizedSku)).toEqual([
      "SKU-A",
      "SKU-B",
    ]);
    expect(first[0].payloadHash).toBe(reordered[0].payloadHash);
  });

  it("returns safe row and field errors for invalid input", async () => {
    await expect(
      parseImportCsv(
        csvFile(`${headers}\n${row("order-1", "SKU-A", "0", "12.345")}`),
        limits,
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ row: 2, field: "quantity" }),
        expect.objectContaining({ row: 2, field: "unit_price" }),
      ]),
    });
  });

  it("rejects missing headers and inconsistent order-level values", async () => {
    await expect(
      parseImportCsv(csvFile("external_order_id,sku\norder-1,SKU-A"), limits),
    ).rejects.toBeInstanceOf(ImportValidationError);

    await expect(
      parseImportCsv(
        csvFile(
          `${headers}\n${row("order-1", "SKU-A", "1", "10", "first@example.com")}\n${row("order-1", "SKU-B", "1", "10", "second@example.com")}`,
        ),
        limits,
      ),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ row: 3 })],
    });
  });

  it("enforces row and byte limits", async () => {
    await expect(
      parseImportCsv(
        csvFile(
          `${headers}\n${row("order-1", "SKU-A", "1", "10")}\n${row("order-2", "SKU-B", "1", "10")}`,
        ),
        { maxBytes: 10_000, maxRows: 1 },
      ),
    ).rejects.toBeInstanceOf(ImportLimitError);

    await expect(
      parseImportCsv(
        csvFile(`${headers}\n${row("order-1", "SKU-A", "1", "10")}`),
        {
          maxBytes: 10,
          maxRows: 100,
        },
      ),
    ).rejects.toBeInstanceOf(ImportLimitError);
  });
});

const headers =
  "external_order_id,processed_at,email,currency,sku,quantity,unit_price";
const limits = { maxBytes: 10_000, maxRows: 100 };

function row(
  externalOrderId: string,
  sku: string,
  quantity: string,
  unitPrice: string,
  email = "buyer@example.com",
) {
  return `${externalOrderId},2026-09-10T12:00:00Z,${email},usd,${sku},${quantity},${unitPrice}`;
}

function csvFile(contents: string) {
  return new File([contents], "orders.csv", { type: "text/csv" });
}
