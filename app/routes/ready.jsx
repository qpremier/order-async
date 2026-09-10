import db from "../db.server";
import { checkRedisReady } from "../services/health/redis.server";
import {
  formatEnvironmentIssues,
  getEnvironment,
} from "../services/security/environment.server";

const pass = () => ({ status: "pass" });
const fail = (message) => ({ status: "fail", message });
const skip = (message) => ({ status: "skip", message });

export const loader = async () => {
  const checks = {};
  let environment;

  try {
    environment = getEnvironment();
    checks.environment = pass();
  } catch (error) {
    checks.environment = {
      status: "fail",
      issues: formatEnvironmentIssues(error),
    };
  }

  if (environment) {
    try {
      await db.$queryRaw`SELECT 1`;
      checks.database = pass();
    } catch {
      checks.database = fail("PostgreSQL readiness check failed");
    }

    try {
      await checkRedisReady(environment.REDIS_URL);
      checks.redis = pass();
    } catch {
      checks.redis = fail("Redis readiness check failed");
    }
  } else {
    checks.database = skip("environment validation failed");
    checks.redis = skip("environment validation failed");
  }

  const isReady = Object.values(checks).every(
    (check) => check.status === "pass",
  );

  return Response.json(
    {
      status: isReady ? "ready" : "not_ready",
      checks,
    },
    {
      status: isReady ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
};
