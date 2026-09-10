import Redis from "ioredis";

export async function checkRedisReady(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, {
    enableReadyCheck: true,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });

  try {
    await redis.connect();
    const response = await redis.ping();

    if (response !== "PONG") {
      throw new Error("Redis ping failed");
    }
  } finally {
    redis.disconnect();
  }
}
