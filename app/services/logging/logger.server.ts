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

export function createLogger(options: {
  level?: LogLevel;
  context?: LogContext;
}): Logger {
  const minimumLevel = options.level ?? "info";
  const baseContext = compactContext(options.context ?? {});

  const write = (
    level: LogLevel,
    message: string,
    context: LogContext = {},
  ) => {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[minimumLevel]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...baseContext,
      ...compactContext(context),
    };

    const line = JSON.stringify(entry);

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

  return message.replace(/\s+/g, " ").slice(0, 500);
}

function compactContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}
