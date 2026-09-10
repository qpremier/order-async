import { z, type ZodIssue } from "zod";

const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const requiredString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1),
);

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);

const requiredUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().url(),
);

const positiveInteger = (defaultValue: number) =>
  z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().int().positive().default(defaultValue),
  );

const decimalRatio = (defaultValue: number) =>
  z.preprocess(
    emptyStringToUndefined,
    z.coerce.number().gt(0).lte(1).default(defaultValue),
  );

const postgresUrl = requiredUrl.refine(
  (value) =>
    value.startsWith("postgresql://") || value.startsWith("postgres://"),
  "must be a PostgreSQL connection URL",
);

const redisUrl = requiredUrl.refine(
  (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
  "must be a Redis connection URL",
);

export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SHOPIFY_API_KEY: requiredString,
  SHOPIFY_API_SECRET: requiredString,
  SHOPIFY_APP_URL: requiredUrl,
  SCOPES: requiredString,
  SHOP_CUSTOM_DOMAIN: optionalString,
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  ORDER_WORKER_CONCURRENCY: positiveInteger(5),
  CATALOG_WORKER_CONCURRENCY: positiveInteger(2),
  CATALOG_SYNC_PAGE_SIZE: positiveInteger(100),
  CATALOG_STALE_AFTER_MINUTES: positiveInteger(60),
  IMPORT_MAX_BYTES: positiveInteger(5 * 1024 * 1024),
  IMPORT_MAX_ROWS: positiveInteger(10_000),
  JOB_MAX_ATTEMPTS: positiveInteger(5),
  RATE_LIMIT_SAFETY_MARGIN: decimalRatio(0.8),
  OUTBOX_POLL_INTERVAL_MS: positiveInteger(2_000),
  OUTBOX_BATCH_SIZE: positiveInteger(50),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface EnvironmentIssue {
  name: string;
  message: string;
}

export class EnvironmentValidationError extends Error {
  readonly issues: EnvironmentIssue[];

  constructor(issues: EnvironmentIssue[]) {
    super(
      `Environment validation failed: ${issues
        .map((issue) => `${issue.name} ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

export function validateEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  const parsed = environmentSchema.safeParse(source);

  if (!parsed.success) {
    throw new EnvironmentValidationError(
      parsed.error.issues.map(toEnvironmentIssue),
    );
  }

  return parsed.data;
}

export function getEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Environment {
  return validateEnvironment(source);
}

export function formatEnvironmentIssues(error: unknown): EnvironmentIssue[] {
  if (error instanceof EnvironmentValidationError) {
    return error.issues;
  }

  return [{ name: "environment", message: "validation failed" }];
}

function toEnvironmentIssue(issue: ZodIssue): EnvironmentIssue {
  return {
    name: issue.path.join(".") || "environment",
    message: issue.message,
  };
}
