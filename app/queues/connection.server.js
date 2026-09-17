import { Redis } from "ioredis";
export function createBullMqRedisConnection(redisUrl, options = {}) {
    const redisOptions = {
        connectionName: options.connectionName,
        enableReadyCheck: true,
        lazyConnect: options.lazyConnect ?? false,
        maxRetriesPerRequest: null,
    };
    return new Redis(redisUrl, redisOptions);
}
