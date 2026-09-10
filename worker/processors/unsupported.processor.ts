import type { QueueJobData } from "../../app/queues/jobs.js";
import type { QueueName } from "../../app/queues/queue-names.js";
import type { ProcessableJob } from "./maintenance.processor.js";

export async function processUnsupportedPhase2Job(
  job: ProcessableJob<QueueJobData>,
  queueName: QueueName,
): Promise<never> {
  throw new Error(
    `Queue ${queueName} has no Phase 2 processor for job ${job.name}`,
  );
}
