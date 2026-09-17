import { Queue } from "bullmq";
import { createBullMqRedisConnection } from "./connection.server.js";
import { ALL_QUEUE_NAMES, QUEUE_NAMES } from "./queue-names.js";
export function createQueueRegistry(options) {
    const defaultJobOptions = createDefaultJobOptions(options.jobMaxAttempts);
    const createQueue = (queueName) => new Queue(queueName, {
        connection: options.connectionFactory?.(queueName) ??
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
export function createDefaultJobOptions(jobMaxAttempts = 5) {
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
class BullMqQueueRegistry {
    orderWrite;
    catalogSync;
    maintenance;
    constructor(queues) {
        this.orderWrite = queues.orderWrite;
        this.catalogSync = queues.catalogSync;
        this.maintenance = queues.maintenance;
    }
    getQueue(queueName) {
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
    all() {
        return ALL_QUEUE_NAMES.map((queueName) => this.getQueue(queueName));
    }
    async close() {
        await Promise.all(this.all().map((queue) => queue.close()));
    }
}
function assertNever(value) {
    throw new Error(`Unsupported queue name: ${value}`);
}
