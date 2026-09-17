import { z } from "zod";
const cursorPayloadSchema = z.object({
    v: z.literal(1),
    createdAt: z.string().datetime(),
    id: z.string().min(1),
});
export class InvalidCursorError extends Error {
    constructor() {
        super("Invalid pagination cursor");
        this.name = "InvalidCursorError";
    }
}
export function encodeKeysetCursor(values) {
    return Buffer.from(JSON.stringify({
        v: 1,
        createdAt: values.createdAt.toISOString(),
        id: values.id,
    })).toString("base64url");
}
export function decodeKeysetCursor(cursor) {
    try {
        const decoded = Buffer.from(cursor, "base64url").toString("utf8");
        const parsed = cursorPayloadSchema.parse(JSON.parse(decoded));
        return {
            createdAt: new Date(parsed.createdAt),
            id: parsed.id,
        };
    }
    catch {
        throw new InvalidCursorError();
    }
}
export function buildDescendingKeysetWhere(cursor) {
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
export function buildDescendingKeysetArgs(options) {
    return {
        where: buildDescendingKeysetWhere(options.cursor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: options.first + 1,
    };
}
export function toKeysetPage(records, first) {
    const items = records.slice(0, first);
    const last = items.at(-1);
    return {
        items,
        hasNextPage: records.length > first,
        endCursor: last ? encodeKeysetCursor(last) : null,
    };
}
