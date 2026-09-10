import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const describeIfDatabase = databaseUrl ? describe : describe.skip;

describeIfDatabase("PrismaSessionStorage with PostgreSQL", () => {
  const shop = "phase1-session-storage.myshopify.com";
  let prisma: PrismaClient;
  let storage: PrismaSessionStorage<PrismaClient>;

  beforeAll(() => {
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl,
        },
      },
    });
    storage = new PrismaSessionStorage(prisma);
  });

  afterEach(async () => {
    await prisma.session.deleteMany({ where: { shop } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores, loads, and deletes an offline Shopify session", async () => {
    const session = new Session({
      id: `offline_${shop}`,
      shop,
      state: "phase1-test-state",
      isOnline: false,
      scope: "write_products",
      accessToken: "phase1-test-token",
    });

    await expect(storage.storeSession(session)).resolves.toBe(true);

    const loadedSession = await storage.loadSession(session.id);

    expect(loadedSession?.id).toBe(session.id);
    expect(loadedSession?.shop).toBe(shop);
    expect(loadedSession?.isOnline).toBe(false);
    expect(loadedSession?.accessToken).toBe("phase1-test-token");

    await expect(storage.deleteSession(session.id)).resolves.toBe(true);
    await expect(storage.loadSession(session.id)).resolves.toBeUndefined();
  });
});
