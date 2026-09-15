import { describe, expect, it } from "vitest";
import { formatImportProgress } from "../app/services/imports/import-progress";

describe("formatImportProgress", () => {
  it("shows ready orders before an import is confirmed", () => {
    expect(
      formatImportProgress({
        status: "DRAFT",
        totalOrders: 20,
        readyOrders: 18,
        succeededOrders: 0,
      }),
    ).toBe("18/20 ready");
  });

  it("shows created orders while an import is running", () => {
    expect(
      formatImportProgress({
        status: "PROCESSING",
        totalOrders: 20,
        readyOrders: 0,
        succeededOrders: 12,
      }),
    ).toBe("12/20 created");
  });

  it("shows all created orders for a completed import", () => {
    expect(
      formatImportProgress({
        status: "COMPLETED",
        totalOrders: 20,
        readyOrders: 0,
        succeededOrders: 20,
      }),
    ).toBe("20/20 created");
  });
});
