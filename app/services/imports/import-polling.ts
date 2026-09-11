const FAST_POLL_MS = 1_500;
const MAX_POLL_MS = 15_000;

export function shouldPollImport(status: string) {
  return ["VALIDATING", "READY", "QUEUED", "PROCESSING"].includes(status);
}

export function nextImportPollDelay(unchangedResponses: number) {
  return Math.min(
    MAX_POLL_MS,
    FAST_POLL_MS * 2 ** Math.min(Math.max(unchangedResponses, 0), 4),
  );
}
