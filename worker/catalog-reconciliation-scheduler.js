import { scheduleStaleCatalogSyncs } from "../app/services/catalog/catalog-sync-request.server.js";
import { createCorrelationId, createSilentLogger, sanitizeErrorMessage, } from "../app/services/logging/logger.server.js";
export class CatalogReconciliationScheduler {
    options;
    timer;
    running = false;
    logger;
    intervalMs;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? createSilentLogger();
        this.intervalMs =
            options.intervalMs ??
                Math.min(60 * 60_000, Math.max(5 * 60_000, options.staleAfterMinutes * 60_000));
    }
    start() {
        if (this.timer) {
            return;
        }
        void this.runOnce();
        this.timer = setInterval(() => {
            void this.runOnce();
        }, this.intervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    async runOnce() {
        if (this.running) {
            return;
        }
        this.running = true;
        const correlationId = createCorrelationId();
        try {
            const result = await scheduleStaleCatalogSyncs(this.options.prisma, {
                staleAfterMinutes: this.options.staleAfterMinutes,
            });
            if (result.scheduled > 0) {
                this.logger.info("catalog.reconciliation.scheduled", {
                    correlationId,
                    operationName: "catalog.reconciliation",
                    scheduled: result.scheduled,
                });
            }
        }
        catch (error) {
            this.logger.warn("catalog.reconciliation.failed", {
                correlationId,
                operationName: "catalog.reconciliation",
                error: sanitizeErrorMessage(error),
            });
        }
        finally {
            this.running = false;
        }
    }
}
