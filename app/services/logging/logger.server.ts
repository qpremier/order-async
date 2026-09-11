import { randomUUID } from "node:crypto";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogContext = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface Logger {
  trace(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

const LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const REDACTED = "[REDACTED]";
const SENSITIVE_CONTEXT_KEY =
  /(?:address|authorization|cookie|csv|email|password|payload|phone|raw|secret|token)/i;
const RESERVED_CONTEXT_KEYS = new Set(["timestamp", "level", "message"]);
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
  now?: () => Date;
  write?: (level: LogLevel, line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimumLevel = options.level ?? "info";
  const baseContext = sanitizeLogContext(options.context ?? {});

  const write = (
    level: LogLevel,
    message: string,
    context: LogContext = {},
  ) => {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[minimumLevel]) {
      return;
    }

    const entry = {
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
      level,
      message: redactSensitiveText(message),
      ...baseContext,
      ...sanitizeLogContext(context),
    };

    const line = JSON.stringify(entry);

    if (options.write) {
      options.write(level, line);
      return;
    }

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };

  return {
    trace: (message, context) => write("trace", message, context),
    debug: (message, context) => write("debug", message, context),
    info: (message, context) => write("info", message, context),
    warn: (message, context) => write("warn", message, context),
    error: (message, context) => write("error", message, context),
    child: (context) =>
      createLogger({
        level: minimumLevel,
        now: options.now,
        write: options.write,
        context: {
          ...baseContext,
          ...context,
        },
      }),
  };
}

export function createSilentLogger(): Logger {
  const noop = () => undefined;

  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => createSilentLogger(),
  };
}

export function sanitizeErrorMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : "Unknown error";

  return redactSensitiveText(message).replace(/\s+/g, " ").slice(0, 500);
}

export function createCorrelationId(): string {
  return randomUUID();
}

export function getRequestCorrelationId(request: Request): string {
  const candidate =
    request.headers.get("x-correlation-id") ??
    request.headers.get("x-request-id") ??
    "";

  return SAFE_CORRELATION_ID.test(candidate)
    ? candidate
    : createCorrelationId();
}

export function resolveLogLevel(value: string | undefined): LogLevel {
  return value && Object.prototype.hasOwnProperty.call(LEVEL_VALUES, value)
    ? (value as LogLevel)
    : "info";
}

export function createProcessLogger(processRole: string): Logger {
  return createLogger({
    level: resolveLogLevel(process.env.LOG_LEVEL),
    context: { processRole },
  });
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, "Bearer [REDACTED]")
    .replace(/\bshp(?:at|ca|pa|ss)_[A-Za-z0-9_-]+\b/gi, "[REDACTED_TOKEN]")
    .replace(
      /\b(password|secret|token|authorization)\s*[=:]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(?=(?:\D*\d){9,}\b)(?:\+?\d[\d ().-]{7,}\d)\b/g,
      "[REDACTED_PHONE]",
    );
}

function sanitizeLogContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context)
      .filter(
        ([key, value]) =>
          value !== undefined && !RESERVED_CONTEXT_KEYS.has(key),
      )
      .map(([key, value]) => [
        key,
        SENSITIVE_CONTEXT_KEY.test(key)
          ? REDACTED
          : typeof value === "string"
            ? redactSensitiveText(value)
            : value,
      ]),
  );
}
