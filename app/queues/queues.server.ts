import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { createBullMqRedisConnection } from "./connection.server.js";
import { ALL_QUEUE_NAMES, QUEUE_NAMES, type QueueName } from "./queue-names.js";
import type { QueueJobData } from "./jobs.js";

export interface QueueRegistry {
  readonly orderWrite: Queue<QueueJobData>;
  readonly catalogSync: Queue<QueueJobData>;
  readonly maintenance: Queue<QueueJobData>;
  getQueue(queueName: QueueName): Queue<QueueJobData>;
  all(): Queue<QueueJobData>[];
  close(): Promise<void>;
}

interface QueueRegistryOptions {
  redisUrl: string;
  prefix?: string;
  jobMaxAttempts?: number;
  connectionFactory?: (queueName: QueueName) => Redis;
}

export function createQueueRegistry(
  options: QueueRegistryOptions,
): QueueRegistry {
  const defaultJobOptions = createDefaultJobOptions(options.jobMaxAttempts);
  const createQueue = (queueName: QueueName) =>
    new Queue<QueueJobData>(queueName, {
      connection:
        options.connectionFactory?.(queueName) ??
        createBullMqRedisConnection(options.redisUrl, {
          connectionName: `orderrelay-queue-${queueName}`,
        }),
      defaultJobOptions,
      prefix: options.prefix,
    });

  return new BullMqQueueRegistry({
    orderWrite: createQueue(QUEUE_NAMES.orderWrite),
    catalogSync: createQueue(QUEUE_NAMES.catalogSync),
    maintenance: createQueue(QUEUE_NAMES.maintenance),
  });
}

export function createDefaultJobOptions(jobMaxAttempts = 5): JobsOptions {
  return {
    attempts: Math.max(1, jobMaxAttempts),
    backoff: {
      type: "exponential",
      delay: 1_000,
      jitter: 0.25,
    },
    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 1_000,
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60,
      count: 1_000,
    },
  };
}

class BullMqQueueRegistry implements QueueRegistry {
  readonly orderWrite: Queue<QueueJobData>;
  readonly catalogSync: Queue<QueueJobData>;
  readonly maintenance: Queue<QueueJobData>;

  constructor(queues: {
    orderWrite: Queue<QueueJobData>;
    catalogSync: Queue<QueueJobData>;
    maintenance: Queue<QueueJobData>;
  }) {
    this.orderWrite = queues.orderWrite;
    this.catalogSync = queues.catalogSync;
    this.maintenance = queues.maintenance;
  }

  getQueue(queueName: QueueName): Queue<QueueJobData> {
    switch (queueName) {
      case QUEUE_NAMES.orderWrite:
        return this.orderWrite;
      case QUEUE_NAMES.catalogSync:
        return this.catalogSync;
      case QUEUE_NAMES.maintenance:
        return this.maintenance;
      default:
        return assertNever(queueName);
    }
  }

  all(): Queue<QueueJobData>[] {
    return ALL_QUEUE_NAMES.map((queueName) => this.getQueue(queueName));
  }

  async close(): Promise<void> {
    await Promise.all(this.all().map((queue) => queue.close()));
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported queue name: ${value}`);
}
