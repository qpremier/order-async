import { z } from "zod";

const cursorPayloadSchema = z.object({
  v: z.literal(1),
  createdAt: z.string().datetime(),
  id: z.string().min(1),
});

export interface KeysetCursorValues {
  createdAt: Date;
  id: string;
}

export interface KeysetPage<T> {
  items: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("Invalid pagination cursor");
    this.name = "InvalidCursorError";
  }
}

export function encodeKeysetCursor(values: KeysetCursorValues): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      createdAt: values.createdAt.toISOString(),
      id: values.id,
    }),
  ).toString("base64url");
}

export function decodeKeysetCursor(cursor: string): KeysetCursorValues {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = cursorPayloadSchema.parse(JSON.parse(decoded));

    return {
      createdAt: new Date(parsed.createdAt),
      id: parsed.id,
    };
  } catch {
    throw new InvalidCursorError();
  }
}

export function buildDescendingKeysetWhere(cursor?: string | null) {
  if (!cursor) {
    return undefined;
  }

  const decoded = decodeKeysetCursor(cursor);

  return {
    OR: [
      {
        createdAt: {
          lt: decoded.createdAt,
        },
      },
      {
        createdAt: decoded.createdAt,
        id: {
          lt: decoded.id,
        },
      },
    ],
  };
}

export function buildDescendingKeysetArgs(options: {
  cursor?: string | null;
  first: number;
}) {
  return {
    where: buildDescendingKeysetWhere(options.cursor),
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: options.first + 1,
  };
}

export function toKeysetPage<T extends KeysetCursorValues>(
  records: T[],
  first: number,
): KeysetPage<T> {
  const items = records.slice(0, first);
  const last = items.at(-1);

  return {
    items,
    hasNextPage: records.length > first,
    endCursor: last ? encodeKeysetCursor(last) : null,
  };
}
