import type { PrismaClient } from "@prisma/client";
import { scheduleStaleCatalogSyncs } from "../app/services/catalog/catalog-sync-request.server.js";
import {
  createSilentLogger,
  sanitizeErrorMessage,
  type Logger,
} from "../app/services/logging/logger.server.js";

export interface CatalogReconciliationSchedulerOptions {
  prisma: PrismaClient;
  staleAfterMinutes: number;
  intervalMs?: number;
  logger?: Logger;
}

export class CatalogReconciliationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly logger: Logger;
  private readonly intervalMs: number;

  constructor(private readonly options: CatalogReconciliationSchedulerOptions) {
    this.logger = options.logger ?? createSilentLogger();
    this.intervalMs =
      options.intervalMs ??
      Math.min(
        60 * 60_000,
        Math.max(5 * 60_000, options.staleAfterMinutes * 60_000),
      );
  }

  start(): void {
    if (this.timer) {
      return;
    }

    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const result = await scheduleStaleCatalogSyncs(this.options.prisma, {
        staleAfterMinutes: this.options.staleAfterMinutes,
      });

      if (result.scheduled > 0) {
        this.logger.info("catalog.reconciliation.scheduled", {
          operationName: "catalog.reconciliation",
          scheduled: result.scheduled,
        });
      }
    } catch (error) {
      this.logger.warn("catalog.reconciliation.failed", {
        operationName: "catalog.reconciliation",
        error: sanitizeErrorMessage(error),
      });
    } finally {
      this.running = false;
    }
  }
}
