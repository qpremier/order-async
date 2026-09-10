import { describe, expect, it } from "vitest";
import {
  buildDescendingKeysetArgs,
  decodeKeysetCursor,
  encodeKeysetCursor,
  InvalidCursorError,
  toKeysetPage,
} from "../app/services/pagination/cursor.server";

describe("Phase 3 local keyset cursors", () => {
  it("round-trips opaque cursor values", () => {
    const createdAt = new Date("2026-09-10T12:00:00.000Z");
    const cursor = encodeKeysetCursor({
      createdAt,
      id: "variant_123",
    });

    expect(cursor).not.toContain("variant_123");
    expect(decodeKeysetCursor(cursor)).toEqual({
      createdAt,
      id: "variant_123",
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeKeysetCursor("not-json")).toThrow(InvalidCursorError);
    expect(() =>
      decodeKeysetCursor(
        Buffer.from(JSON.stringify({ v: 1, id: "missing-date" })).toString(
          "base64url",
        ),
      ),
    ).toThrow(InvalidCursorError);
  });

  it("builds descending keyset args without offset pagination", () => {
    const cursor = encodeKeysetCursor({
      createdAt: new Date("2026-09-10T12:00:00.000Z"),
      id: "variant_123",
    });
    const args = buildDescendingKeysetArgs({
      cursor,
      first: 25,
    });

    expect(args.take).toBe(26);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args).not.toHaveProperty("skip");
    expect(args.where).toEqual({
      OR: [
        {
          createdAt: {
            lt: new Date("2026-09-10T12:00:00.000Z"),
          },
        },
        {
          createdAt: new Date("2026-09-10T12:00:00.000Z"),
          id: {
            lt: "variant_123",
          },
        },
      ],
    });
  });

  it("returns hasNextPage and endCursor from one extra fetched record", () => {
    const records = [
      {
        createdAt: new Date("2026-09-10T12:00:00.000Z"),
        id: "variant_3",
      },
      {
        createdAt: new Date("2026-09-10T11:00:00.000Z"),
        id: "variant_2",
      },
      {
        createdAt: new Date("2026-09-10T10:00:00.000Z"),
        id: "variant_1",
      },
    ];
    const page = toKeysetPage(records, 2);

    expect(page.items.map((item) => item.id)).toEqual([
      "variant_3",
      "variant_2",
    ]);
    expect(page.hasNextPage).toBe(true);
    expect(decodeKeysetCursor(page.endCursor ?? "")).toEqual({
      createdAt: new Date("2026-09-10T11:00:00.000Z"),
      id: "variant_2",
    });
  });
});
