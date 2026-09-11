-- Phase 4 stores the normalized order-level values required by the later order
-- writer. Raw uploaded CSV files are never persisted.
ALTER TABLE "OrderIntent"
ADD COLUMN "processedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN "email" TEXT NOT NULL,
ADD COLUMN "currency" TEXT NOT NULL,
ADD COLUMN "shippingFirstName" TEXT,
ADD COLUMN "shippingLastName" TEXT,
ADD COLUMN "shippingAddress1" TEXT,
ADD COLUMN "shippingAddress2" TEXT,
ADD COLUMN "shippingCity" TEXT,
ADD COLUMN "shippingProvince" TEXT,
ADD COLUMN "shippingProvinceCode" TEXT,
ADD COLUMN "shippingCountryCode" TEXT,
ADD COLUMN "shippingZip" TEXT,
ADD COLUMN "shippingPhone" TEXT,
ADD COLUMN "note" TEXT;

CREATE TABLE "ImportBatchOrderIntent" (
    "importBatchId" TEXT NOT NULL,
    "orderIntentId" TEXT NOT NULL,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatchOrderIntent_pkey" PRIMARY KEY ("importBatchId", "orderIntentId")
);

CREATE INDEX "ImportBatchOrderIntent_orderIntentId_idx"
ON "ImportBatchOrderIntent"("orderIntentId");

ALTER TABLE "ImportBatchOrderIntent"
ADD CONSTRAINT "ImportBatchOrderIntent_importBatchId_fkey"
FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ImportBatchOrderIntent"
ADD CONSTRAINT "ImportBatchOrderIntent_orderIntentId_fkey"
FOREIGN KEY ("orderIntentId") REFERENCES "OrderIntent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
