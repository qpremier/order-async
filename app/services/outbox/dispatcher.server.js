import { describeOutboxJob } from "../../queues/jobs.js";
import { createSilentLogger, sanitizeErrorMessage, } from "../logging/logger.server.js";
export class BullMqOutboxPublisher {
    queues;
    constructor(queues) {
        this.queues = queues;
    }
    async publish(event) {
        const descriptor = describeOutboxJob(event);
        const queue = this.queues.getQueue(descriptor.queueName);
        await queue.add(descriptor.jobName, descriptor.data, descriptor.options);
        return {
            queueName: descriptor.queueName,
            jobName: descriptor.jobName,
            jobId: descriptor.jobId,
        };
    }
}
export async function publishOutboxEvent(options) {
    const logger = options.logger ?? createSilentLogger();
    try {
        const published = await options.publisher.publish(options.event);
        const updated = await options.prisma.outboxEvent.updateMany({
            where: {
                id: options.event.id,
                publishedAt: null,
            },
            data: {
                publishedAt: (options.now ?? (() => new Date()))(),
                attemptCount: {
                    increment: 1,
                },
                lastPublishError: null,
            },
        });
        if (updated.count === 0) {
            logger.debug("outbox.event.already_published", {
                correlationId: options.event.id,
                outboxEventId: options.event.id,
                shopId: options.event.shopId,
                queueName: published.queueName,
                jobId: published.jobId,
                operationName: published.jobName,
            });
            return {
                status: "already-published",
                eventId: options.event.id,
                ...published,
            };
        }
        logger.info("outbox.event.published", {
            correlationId: options.event.id,
            outboxEventId: options.event.id,
            shopId: options.event.shopId,
            queueName: published.queueName,
            jobId: published.jobId,
            operationName: published.jobName,
        });
        return {
            status: "published",
            eventId: options.event.id,
            ...published,
        };
    }
    catch (error) {
        const message = sanitizeErrorMessage(error);
        await options.prisma.outboxEvent.updateMany({
            where: {
                id: options.event.id,
                publishedAt: null,
            },
            data: {
                attemptCount: {
                    increment: 1,
                },
                lastPublishError: message,
            },
        });
        logger.warn("outbox.event.publish_failed", {
            correlationId: options.event.id,
            outboxEventId: options.event.id,
            shopId: options.event.shopId,
            operationName: options.event.eventType,
        });
        return {
            status: "failed",
            eventId: options.event.id,
            error: message,
        };
    }
}
export async function dispatchPendingOutboxEvents(options) {
    const events = await options.prisma.outboxEvent.findMany({
        where: {
            publishedAt: null,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: options.batchSize,
    });
    const result = {
        scanned: events.length,
        published: 0,
        alreadyPublished: 0,
        failed: 0,
    };
    for (const event of events) {
        const publishResult = await publishOutboxEvent({
            prisma: options.prisma,
            publisher: options.publisher,
            event,
            now: options.now,
            logger: options.logger,
        });
        if (publishResult.status === "published") {
            result.published += 1;
        }
        else if (publishResult.status === "already-published") {
            result.alreadyPublished += 1;
        }
        else {
            result.failed += 1;
        }
    }
    return result;
}
export class OutboxDispatcher {
    options;
    loopPromise;
    sleepTimer;
    sleepResolver;
    stopping = false;
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createSilentLogger();
    }
    start() {
        if (!this.loopPromise) {
            this.stopping = false;
            this.loopPromise = this.runLoop();
        }
        return this.loopPromise;
    }
    async stop() {
        this.stopping = true;
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = undefined;
        }
        this.sleepResolver?.();
        await this.loopPromise;
    }
    async runLoop() {
        this.logger.info("outbox.dispatcher.started", {
            operationName: "outbox.dispatcher",
        });
        while (!this.stopping) {
            try {
                const result = await dispatchPendingOutboxEvents({
                    prisma: this.options.prisma,
                    publisher: this.options.publisher,
                    batchSize: this.options.batchSize,
                    logger: this.logger,
                });
                if (result.scanned > 0) {
                    this.logger.debug("outbox.dispatcher.iteration", {
                        operationName: "outbox.dispatcher",
                        scanned: result.scanned,
                        published: result.published,
                        failed: result.failed,
                    });
                }
            }
            catch (error) {
                this.logger.error("outbox.dispatcher.iteration_failed", {
                    operationName: "outbox.dispatcher",
                    error: sanitizeErrorMessage(error),
                });
            }
            if (!this.stopping) {
                await this.sleep(this.options.pollIntervalMs);
            }
        }
        this.logger.info("outbox.dispatcher.stopped", {
            operationName: "outbox.dispatcher",
        });
    }
    sleep(ms) {
        return new Promise((resolve) => {
            this.sleepResolver = resolve;
            this.sleepTimer = setTimeout(() => {
                this.sleepTimer = undefined;
                this.sleepResolver = undefined;
                resolve();
            }, ms);
        });
    }
}
