import db from "../db.server";
import { createImportStatusLoader } from "../services/imports/import-status.server";
import { authenticate } from "../shopify.server";

export const loader = createImportStatusLoader({
  prisma: db,
  authenticateAdmin: async (request) => authenticate.admin(request),
});
