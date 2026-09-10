export const QUEUE_NAMES = {
  orderWrite: "order-write",
  catalogSync: "catalog-sync",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES = [
  QUEUE_NAMES.orderWrite,
  QUEUE_NAMES.catalogSync,
  QUEUE_NAMES.maintenance,
] as const satisfies readonly QueueName[];
