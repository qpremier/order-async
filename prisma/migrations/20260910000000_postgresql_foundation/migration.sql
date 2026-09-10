-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "CatalogSyncStatus" AS ENUM ('NEVER_SYNCED', 'SYNCING', 'FRESH', 'STALE', 'FAILED');

-- CreateEnum
CREATE TYPE "CatalogSyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('DRAFT', 'VALIDATING', 'READY', 'QUEUED', 'PROCESSING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderIntentStatus" AS ENUM ('DRAFT', 'VALIDATING', 'NEEDS_MAPPING', 'AMBIGUOUS_MAPPING', 'INVALID', 'READY', 'QUEUED', 'PROCESSING', 'RETRY_WAIT', 'AMBIGUOUS_RESULT', 'SUCCEEDED', 'DEAD_LETTER', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderLineValidationStatus" AS ENUM ('UNVALIDATED', 'VALID', 'NEEDS_MAPPING', 'AMBIGUOUS_MAPPING', 'INVALID');

-- CreateEnum
CREATE TYPE "ErrorCategory" AS ENUM ('VALIDATION', 'MISSING_MAPPING', 'AMBIGUOUS_MAPPING', 'SHOPIFY_USER_ERROR', 'AUTHENTICATION', 'MISSING_SCOPE', 'SHOP_UNINSTALLED', 'THROTTLED', 'NETWORK_TRANSIENT', 'SHOPIFY_SERVER_TRANSIENT', 'AMBIGUOUS_WRITE_RESULT', 'INTERNAL_BUG', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'ACTIVE',
    "grantedScopes" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "lastCatalogSyncAt" TIMESTAMP(3),
    "catalogSyncStatus" "CatalogSyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSyncRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "status" "CatalogSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastProcessedCursor" TEXT,
    "lastErrorCategory" "ErrorCategory",
    "sanitizedLastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogVariant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyVariantGid" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "sku" TEXT,
    "normalizedSku" TEXT,
    "variantTitle" TEXT,
    "productTitle" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "currency" TEXT,
    "productStatus" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "lastSeenSyncRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkuMapping" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "externalSku" TEXT NOT NULL,
    "normalizedExternalSku" TEXT NOT NULL,
    "shopifyVariantGid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkuMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ImportBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "totalOrders" INTEGER NOT NULL DEFAULT 0,
    "readyOrders" INTEGER NOT NULL DEFAULT 0,
    "queuedOrders" INTEGER NOT NULL DEFAULT 0,
    "processingOrders" INTEGER NOT NULL DEFAULT 0,
    "succeededOrders" INTEGER NOT NULL DEFAULT 0,
    "failedOrders" INTEGER NOT NULL DEFAULT 0,
    "needsAttentionOrders" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderIntent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceIdentifier" TEXT NOT NULL,
    "status" "OrderIntentStatus" NOT NULL DEFAULT 'DRAFT',
    "shopifyOrderGid" TEXT,
    "shopifyOrderName" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCategory" "ErrorCategory",
    "lastErrorCode" TEXT,
    "sanitizedLastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "processingStartedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderIntentId" TEXT NOT NULL,
    "originalSku" TEXT NOT NULL,
    "normalizedSku" TEXT NOT NULL,
    "shopifyVariantGid" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "validationStatus" "OrderLineValidationStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "validationMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastPublishError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetterRecord" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderIntentId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "errorCategory" "ErrorCategory" NOT NULL,
    "errorCode" TEXT,
    "sanitizedMessage" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "lastFailedAt" TIMESTAMP(3) NOT NULL,
    "replayedAt" TIMESTAMP(3),
    "replayedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadLetterRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "CatalogSyncRun_shopId_status_createdAt_idx" ON "CatalogSyncRun"("shopId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogVariant_shopId_shopifyVariantGid_key" ON "CatalogVariant"("shopId", "shopifyVariantGid");

-- CreateIndex
CREATE INDEX "CatalogVariant_shopId_normalizedSku_idx" ON "CatalogVariant"("shopId", "normalizedSku");

-- CreateIndex
CREATE INDEX "CatalogVariant_shopId_deletedAt_idx" ON "CatalogVariant"("shopId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SkuMapping_shopId_sourceSystem_normalizedExternalSku_key" ON "SkuMapping"("shopId", "sourceSystem", "normalizedExternalSku");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_shopId_idempotencyKey_key" ON "ImportBatch"("shopId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ImportBatch_shopId_createdAt_id_idx" ON "ImportBatch"("shopId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIntent_shopId_sourceSystem_externalOrderId_key" ON "OrderIntent"("shopId", "sourceSystem", "externalOrderId");

-- CreateIndex
CREATE INDEX "OrderIntent_shopId_status_createdAt_id_idx" ON "OrderIntent"("shopId", "status", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OrderIntent_importBatchId_createdAt_id_idx" ON "OrderIntent"("importBatchId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "OrderIntent_shopId_sourceIdentifier_idx" ON "OrderIntent"("shopId", "sourceIdentifier");

-- CreateIndex
CREATE INDEX "OrderLine_orderIntentId_idx" ON "OrderLine"("orderIntentId");

-- CreateIndex
CREATE INDEX "OrderLine_shopId_normalizedSku_idx" ON "OrderLine"("shopId", "normalizedSku");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_eventType_publishedAt_idx" ON "OutboxEvent"("eventType", "publishedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_shopId_createdAt_idx" ON "OutboxEvent"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_shopId_webhookId_key" ON "WebhookReceipt"("shopId", "webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_shopId_topic_receivedAt_idx" ON "WebhookReceipt"("shopId", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "DeadLetterRecord_shopId_createdAt_idx" ON "DeadLetterRecord"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "DeadLetterRecord_shopId_orderIntentId_idx" ON "DeadLetterRecord"("shopId", "orderIntentId");

-- AddForeignKey
ALTER TABLE "CatalogSyncRun" ADD CONSTRAINT "CatalogSyncRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogVariant" ADD CONSTRAINT "CatalogVariant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkuMapping" ADD CONSTRAINT "SkuMapping_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderIntent" ADD CONSTRAINT "OrderIntent_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetterRecord" ADD CONSTRAINT "DeadLetterRecord_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetterRecord" ADD CONSTRAINT "DeadLetterRecord_orderIntentId_fkey" FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
