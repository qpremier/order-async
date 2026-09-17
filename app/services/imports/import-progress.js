const PRE_CONFIRMATION_STATUSES = [
    "DRAFT",
    "VALIDATING",
    "READY",
];
export function formatImportProgress(batch) {
    if (PRE_CONFIRMATION_STATUSES.includes(batch.status)) {
        return `${batch.readyOrders}/${batch.totalOrders} ready`;
    }
    return `${batch.succeededOrders}/${batch.totalOrders} created`;
}
