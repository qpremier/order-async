import { Redis, type RedisOptions } from "ioredis";

export interface RedisConnectionOptions {
  connectionName?: string;
  lazyConnect?: boolean;
}

export function createBullMqRedisConnection(
  redisUrl: string,
  options: RedisConnectionOptions = {},
): Redis {
  const redisOptions: RedisOptions = {
    connectionName: options.connectionName,
    enableReadyCheck: true,
    lazyConnect: options.lazyConnect ?? false,
    maxRetriesPerRequest: null,
  };

  return new Redis(redisUrl, redisOptions);
}
