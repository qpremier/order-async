import type { OutboxEvent, PrismaClient } from "@prisma/client";
import type { QueueRegistry } from "../../queues/queues.server.js";
import { describeOutboxJob } from "../../queues/jobs.js";
import {
  createSilentLogger,
  sanitizeErrorMessage,
  type Logger,
} from "../logging/logger.server.js";

export interface OutboxPublisher {
  publish(event: OutboxEvent): Promise<PublishedQueueJob>;
}

export interface PublishedQueueJob {
  queueName: string;
  jobName: string;
  jobId: string;
}

export class BullMqOutboxPublisher implements OutboxPublisher {
  constructor(private readonly queues: QueueRegistry) {}

  async publish(event: OutboxEvent): Promise<PublishedQueueJob> {
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

export interface PublishOutboxEventOptions {
  prisma: PrismaClient;
  publisher: OutboxPublisher;
  event: OutboxEvent;
  now?: () => Date;
  logger?: Logger;
}

export type PublishOutboxEventResult =
  | {
      status: "published";
      eventId: string;
      queueName: string;
      jobName: string;
      jobId: string;
    }
  | {
      status: "already-published";
      eventId: string;
      queueName: string;
      jobName: string;
      jobId: string;
    }
  | {
      status: "failed";
      eventId: string;
      error: string;
    };

export async function publishOutboxEvent(
  options: PublishOutboxEventOptions,
): Promise<PublishOutboxEventResult> {
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
        outboxEventId: options.event.id,
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
  } catch (error) {
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

export interface DispatchPendingOutboxEventsOptions {
  prisma: PrismaClient;
  publisher: OutboxPublisher;
  batchSize: number;
  now?: () => Date;
  logger?: Logger;
}

export interface DispatchPendingOutboxEventsResult {
  scanned: number;
  published: number;
  alreadyPublished: number;
  failed: number;
}

export async function dispatchPendingOutboxEvents(
  options: DispatchPendingOutboxEventsOptions,
): Promise<DispatchPendingOutboxEventsResult> {
  const events = await options.prisma.outboxEvent.findMany({
    where: {
      publishedAt: null,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: options.batchSize,
  });

  const result: DispatchPendingOutboxEventsResult = {
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
    } else if (publishResult.status === "already-published") {
      result.alreadyPublished += 1;
    } else {
      result.failed += 1;
    }
  }

  return result;
}

export interface OutboxDispatcherOptions {
  prisma: PrismaClient;
  publisher: OutboxPublisher;
  batchSize: number;
  pollIntervalMs: number;
  logger?: Logger;
}

export class OutboxDispatcher {
  private loopPromise: Promise<void> | undefined;
  private sleepTimer: NodeJS.Timeout | undefined;
  private sleepResolver: (() => void) | undefined;
  private stopping = false;
  private readonly logger: Logger;

  constructor(private readonly options: OutboxDispatcherOptions) {
    this.logger = options.logger ?? createSilentLogger();
  }

  start(): Promise<void> {
    if (!this.loopPromise) {
      this.stopping = false;
      this.loopPromise = this.runLoop();
    }

    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }

    this.sleepResolver?.();
    await this.loopPromise;
  }

  private async runLoop(): Promise<void> {
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
      } catch (error) {
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

  private sleep(ms: number): Promise<void> {
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
