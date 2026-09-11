-- Phase 5 tracks bounded ambiguity reconciliation separately from create
-- attempts and protects the deterministic Shopify source identity per shop.
ALTER TABLE "OrderIntent"
ADD COLUMN "reconciliationAttemptCount" INTEGER NOT NULL DEFAULT 0;

DROP INDEX "OrderIntent_shopId_sourceIdentifier_idx";

CREATE UNIQUE INDEX "OrderIntent_shopId_sourceIdentifier_key"
ON "OrderIntent"("shopId", "sourceIdentifier");
