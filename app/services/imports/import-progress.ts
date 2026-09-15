import type { ImportBatchStatus } from "@prisma/client";

type ImportProgress = {
  status: ImportBatchStatus;
  totalOrders: number;
  readyOrders: number;
  succeededOrders: number;
};

const PRE_CONFIRMATION_STATUSES: ImportBatchStatus[] = [
  "DRAFT",
  "VALIDATING",
  "READY",
];

export function formatImportProgress(batch: ImportProgress): string {
  if (PRE_CONFIRMATION_STATUSES.includes(batch.status)) {
    return `${batch.readyOrders}/${batch.totalOrders} ready`;
  }

  return `${batch.succeededOrders}/${batch.totalOrders} created`;
}
