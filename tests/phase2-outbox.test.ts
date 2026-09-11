import { QueueEvents } from "bullmq";
import { PrismaClient, type OutboxEvent } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createBullMqRedisConnection } from "../app/queues/connection.server";
import {
  describeOutboxJob,
  JOB_NAMES,
  OUTBOX_EVENT_TYPES,
} from "../app/queues/jobs";
import { QUEUE_NAMES } from "../app/queues/queue-names";
import {
  BullMqOutboxPublisher,
  dispatchPendingOutboxEvents,
  publishOutboxEvent,
  type OutboxPublisher,
  type PublishedQueueJob,
} from "../app/services/outbox/dispatcher.server";
import { createPhase2DiagnosticOutboxEvent } from "../app/services/diagnostics/phase2-diagnostic.server";
import { createSilentLogger } from "../app/services/logging/logger.server";
import {
  createQueueRegistry,
  type QueueRegistry,
} from "../app/queues/queues.server";
import { createQueueWorkers } from "../worker/queue-workers";
import { processMaintenanceJob } from "../worker/processors/maintenance.processor";

const testLogger = createSilentLogger();

describe("Phase 2 queue job descriptors", () => {
  it("routes diagnostic events to the maintenance queue with a BullMQ-safe deterministic job ID", () => {
    const event = createOutboxEventFixture({
      eventType: OUTBOX_EVENT_TYPES.phase2Diagnostic,
      aggregateId: "diagnostic:one",
    });

    const descriptor = describeOutboxJob(
      event,
      new Date("2026-09-10T00:00:00.000Z"),
    );

    expect(descriptor.queueName).toBe(QUEUE_NAMES.maintenance);
    expect(descriptor.jobName).toBe(JOB_NAMES.maintenanceDiagnostic);
    expect(descriptor.jobId).toBe("phase2-diagnostic__diagnostic_one");
    expect(descriptor.options.jobId).toBe(descriptor.jobId);
    expect(descriptor.data).toMatchObject({
      eventId: event.id,
      shopId: event.shopId,
      aggregateId: event.aggregateId,
      eventType: OUTBOX_EVENT_TYPES.phase2Diagnostic,
      operationName: JOB_NAMES.maintenanceDiagnostic,
    });
  });

  it("uses the durable outbox event as the order-create delivery dedupe key", () => {
    const descriptor = describeOutboxJob(
      createOutboxEventFixture({
        eventType: OUTBOX_EVENT_TYPES.orderCreate,
        aggregateType: "OrderIntent",
        aggregateId: "order-intent-1",
      }),
    );

    expect(descriptor.queueName).toBe(QUEUE_NAMES.orderWrite);
    expect(descriptor.jobName).toBe(JOB_NAMES.orderCreate);
    expect(descriptor.jobId).toBe("order-create__outbox-event-1");
  });
});

describe("dispatchPendingOutboxEvents", () => {
  it("publishes pending rows and marks them published only after queue publication succeeds", async () => {
    const event = createOutboxEventFixture();
    const publisher = {
      publish: vi.fn<OutboxPublisher["publish"]>().mockResolvedValue({
        queueName: QUEUE_NAMES.maintenance,
        jobName: JOB_NAMES.maintenanceDiagnostic,
        jobId: "phase2-diagnostic__aggregate-1",
      }),
    };
    const findMany = vi.fn().mockResolvedValue([event]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      outboxEvent: {
        findMany,
        updateMany,
      },
    } as unknown as PrismaClient;

    const result = await dispatchPendingOutboxEvents({
      prisma,
      publisher,
      batchSize: 10,
      now: () => new Date("2026-09-10T00:00:00.000Z"),
      logger: testLogger,
    });

    expect(result).toEqual({
      scanned: 1,
      published: 1,
      alreadyPublished: 0,
      failed: 0,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        publishedAt: null,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 10,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        publishedAt: null,
      },
      data: {
        publishedAt: new Date("2026-09-10T00:00:00.000Z"),
        attemptCount: {
          increment: 1,
        },
        lastPublishError: null,
      },
    });
  });
});

describe("processMaintenanceJob", () => {
  it("handles duplicate diagnostic deliveries idempotently", async () => {
    const event = createOutboxEventFixture();
    const descriptor = describeOutboxJob(event);
    const findUnique = vi.fn().mockResolvedValue({
      id: event.id,
      shopId: event.shopId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
    });
    const prisma = {
      outboxEvent: {
        findUnique,
      },
    } as unknown as PrismaClient;
    const job = {
      id: descriptor.jobId,
      name: descriptor.jobName,
      data: descriptor.data,
      attemptsMade: 0,
    };

    await expect(
      processMaintenanceJob(job, { prisma, logger: testLogger }),
    ).resolves.toMatchObject({
      status: "handled",
      eventId: event.id,
      shopId: event.shopId,
      jobId: descriptor.jobId,
    });
    await expect(
      processMaintenanceJob(job, { prisma, logger: testLogger }),
    ).resolves.toMatchObject({
      status: "handled",
      eventId: event.id,
    });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

const databaseUrl = process.env.DATABASE_URL ?? "";
const redisUrl = process.env.REDIS_URL ?? "";
const describeIfInfrastructure =
  databaseUrl && redisUrl ? describe : describe.skip;

describeIfInfrastructure("Phase 2 outbox and BullMQ integration", () => {
  let prisma: PrismaClient;
  let registries: QueueRegistry[] = [];
  let queueEvents: QueueEvents[] = [];

  beforeAll(() => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });
  });

  afterEach(async () => {
    for (const event of queueEvents) {
      await event.close();
    }
    queueEvents = [];

    for (const registry of registries) {
      for (const queue of registry.all()) {
        await queue.obliterate({ force: true });
      }
      await registry.close();
    }
    registries = [];

    await prisma.shop.deleteMany({
      where: {
        domain: {
          startsWith: "phase2-",
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps the database event when Redis publication fails, then publishes it after recovery", async () => {
    const diagnostic = await createDiagnostic(prisma);
    const failingPublisher: OutboxPublisher = {
      publish: async (): Promise<PublishedQueueJob> => {
        throw new Error("Redis unavailable for test");
      },
    };

    const failed = await publishOutboxEvent({
      prisma,
      publisher: failingPublisher,
      event: diagnostic.event,
      logger: testLogger,
    });

    expect(failed).toMatchObject({
      status: "failed",
      eventId: diagnostic.event.id,
    });

    const afterFailure = await prisma.outboxEvent.findUniqueOrThrow({
      where: {
        id: diagnostic.event.id,
      },
    });

    expect(afterFailure.publishedAt).toBeNull();
    expect(afterFailure.attemptCount).toBe(1);
    expect(afterFailure.lastPublishError).toContain("Redis unavailable");

    const registry = createTestQueueRegistry("redis-recovery");
    const recovered = await publishOutboxEvent({
      prisma,
      publisher: new BullMqOutboxPublisher(registry),
      event: afterFailure,
      logger: testLogger,
    });
    const afterRecovery = await prisma.outboxEvent.findUniqueOrThrow({
      where: {
        id: diagnostic.event.id,
      },
    });
    const descriptor = describeOutboxJob(diagnostic.event);
    const job = await registry.maintenance.getJob(descriptor.jobId);

    expect(recovered).toMatchObject({
      status: "published",
      eventId: diagnostic.event.id,
      jobId: descriptor.jobId,
    });
    expect(afterRecovery.publishedAt).toBeInstanceOf(Date);
    expect(afterRecovery.attemptCount).toBe(2);
    expect(job?.id).toBe(descriptor.jobId);
  });

  it("publishes the same event more than once without creating duplicate BullMQ jobs", async () => {
    const diagnostic = await createDiagnostic(prisma);
    const registry = createTestQueueRegistry("duplicate-publication");
    const publisher = new BullMqOutboxPublisher(registry);
    const descriptor = describeOutboxJob(diagnostic.event);

    const first = await publishOutboxEvent({
      prisma,
      publisher,
      event: diagnostic.event,
      logger: testLogger,
    });
    const second = await publishOutboxEvent({
      prisma,
      publisher,
      event: diagnostic.event,
      logger: testLogger,
    });
    const jobCounts = await registry.maintenance.getJobCounts(
      "waiting",
      "prioritized",
      "delayed",
    );

    expect(first).toMatchObject({
      status: "published",
      jobId: descriptor.jobId,
    });
    expect(second).toMatchObject({
      status: "already-published",
      jobId: descriptor.jobId,
    });
    expect(await registry.maintenance.getJob(descriptor.jobId)).not.toBeNull();
    expect(jobCounts.waiting + jobCounts.prioritized + jobCounts.delayed).toBe(
      1,
    );
  });

  it("lets a worker started after dispatch handle the diagnostic job", async () => {
    const diagnostic = await createDiagnostic(prisma);
    const registry = createTestQueueRegistry("worker-restart");
    const descriptor = describeOutboxJob(diagnostic.event);

    await publishOutboxEvent({
      prisma,
      publisher: new BullMqOutboxPublisher(registry),
      event: diagnostic.event,
      logger: testLogger,
    });

    const queuedJob = await registry.maintenance.getJob(descriptor.jobId);
    expect(queuedJob).not.toBeNull();

    const events = createTestQueueEvents("worker-restart");
    await events.waitUntilReady();

    const workers = createQueueWorkers({
      redisUrl,
      prisma,
      orderConcurrency: 1,
      catalogConcurrency: 1,
      prefix: testPrefix("worker-restart"),
      logger: testLogger,
    });

    try {
      await expect(
        queuedJob?.waitUntilFinished(events, 5_000),
      ).resolves.toMatchObject({
        status: "handled",
        eventId: diagnostic.event.id,
        shopId: diagnostic.shop.id,
        jobId: descriptor.jobId,
      });
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  });

  function createTestQueueRegistry(name: string): QueueRegistry {
    const registry = createQueueRegistry({
      redisUrl,
      prefix: testPrefix(name),
      jobMaxAttempts: 1,
    });

    registries.push(registry);

    return registry;
  }

  function createTestQueueEvents(name: string): QueueEvents {
    const events = new QueueEvents(QUEUE_NAMES.maintenance, {
      connection: createBullMqRedisConnection(redisUrl, {
        connectionName: `orderrelay-test-events-${name}`,
      }),
      prefix: testPrefix(name),
    });

    queueEvents.push(events);

    return events;
  }
});

async function createDiagnostic(prisma: PrismaClient) {
  return createPhase2DiagnosticOutboxEvent(prisma, {
    shopDomain: `phase2-${crypto.randomUUID()}.myshopify.com`,
    grantedScopes: "write_products",
    idempotencyKey: crypto.randomUUID(),
    requestedAt: new Date("2026-09-10T00:00:00.000Z"),
  });
}

function testPrefix(name: string): string {
  return `orderrelay-test-${name}-${process.pid}`;
}

function createOutboxEventFixture(
  overrides: Partial<OutboxEvent> = {},
): OutboxEvent {
  const now = new Date("2026-09-10T00:00:00.000Z");

  return {
    id: "outbox-event-1",
    shopId: "shop-1",
    aggregateType: "QueueDiagnostic",
    aggregateId: "aggregate-1",
    eventType: OUTBOX_EVENT_TYPES.phase2Diagnostic,
    payload: {
      diagnosticId: "aggregate-1",
    },
    publishedAt: null,
    attemptCount: 0,
    lastPublishError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
