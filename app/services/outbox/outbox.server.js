export async function createOutboxEvent(client, input) {
    return client.outboxEvent.create({
        data: {
            shopId: input.shopId,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            eventType: input.eventType,
            payload: input.payload ?? {},
        },
    });
}
