/**
 * Structured JSON logger for consistent log output across web app and worker.
 *
 * Emits JSON lines that Cloudflare's log viewer parses as structured data.
 * Context (userId, receiptId, workflowId, requestId) is set once per request
 * and included on every log line.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  service: string;
  requestId?: string;
  userId?: string;
  receiptId?: string;
  workflowId?: string;
  [key: string]: unknown;
};

export type Logger = {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  /** Return a new logger with additional context merged in. */
  child(extra: Partial<LogContext>): Logger;
};

function emit(level: LogLevel, context: LogContext, message: string, extra?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
    ...(extra ?? {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(context: LogContext): Logger {
  return {
    debug(message, extra) {
      emit("debug", context, message, extra);
    },
    info(message, extra) {
      emit("info", context, message, extra);
    },
    warn(message, extra) {
      emit("warn", context, message, extra);
    },
    error(message, extra) {
      // Serialize Error objects cleanly
      let serializedExtra = extra;
      if (extra?.error instanceof Error) {
        serializedExtra = {
          ...extra,
          error: {
            name: extra.error.name,
            message: extra.error.message,
            stack: extra.error.stack,
          },
        };
      }
      emit("error", context, message, serializedExtra);
    },
    child(additional) {
      return createLogger({ ...context, ...additional });
    },
  };
}

/**
 * Generate a short request ID for correlating log lines within a single request.
 * Uses first 8 chars of a UUID for readability.
 */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}
