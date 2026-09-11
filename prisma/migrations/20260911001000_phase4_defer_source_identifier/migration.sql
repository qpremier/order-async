-- The deterministic Shopify source identifier belongs to the Phase 5 order
-- creation contract. Phase 4 drafts intentionally leave it unset.
ALTER TABLE "OrderIntent"
ALTER COLUMN "sourceIdentifier" DROP NOT NULL;
