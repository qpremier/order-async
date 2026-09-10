import type { Prisma } from "@prisma/client";

export type OutboxWritableClient = Pick<
  Prisma.TransactionClient,
  "outboxEvent"
>;

export interface CreateOutboxEventInput {
  shopId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload?: Prisma.InputJsonValue;
}

export async function createOutboxEvent(
  client: OutboxWritableClient,
  input: CreateOutboxEventInput,
) {
  return client.outboxEvent.create({
    data: {
      shopId: input.shopId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload ?? {},
    },
  });
}
