import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  validateEnvironment,
} from "./environment.server";

const validEnvironment = {
  NODE_ENV: "test",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_APP_URL: "https://example.com",
  SCOPES: "write_products",
  DATABASE_URL:
    "postgresql://orderrelay:orderrelay@localhost:5432/orderrelay_test",
  REDIS_URL: "redis://localhost:6379",
};

describe("validateEnvironment", () => {
  it("applies safe local defaults for non-secret operational settings", () => {
    const environment = validateEnvironment(validEnvironment);

    expect(environment.IMPORT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(environment.IMPORT_MAX_ROWS).toBe(10_000);
    expect(environment.LOG_LEVEL).toBe("info");
    expect(environment.OUTBOX_BATCH_SIZE).toBe(50);
  });

  it("rejects SQLite database URLs", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: "file:dev.sqlite",
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it("rejects missing Shopify secrets", () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SHOPIFY_API_SECRET: "",
      }),
    ).toThrow(EnvironmentValidationError);
  });
});
