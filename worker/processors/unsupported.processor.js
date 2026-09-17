export async function processUnsupportedPhase2Job(job, queueName) {
    throw new Error(`Queue ${queueName} has no Phase 2 processor for job ${job.name}`);
}
