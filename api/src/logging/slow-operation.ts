import type { Logger } from './logger.js';

/** Warn once when work exceeds the configured threshold; fast operations stay silent. */
export const withSlowOperationWarning = async <T>({
  logger,
  thresholdMs,
  caller,
  loggerKey,
  label,
  context = {},
  task
}: {
  logger: Logger;
  thresholdMs: number;
  caller: string;
  loggerKey: string;
  label: string;
  context?: Record<string, unknown>;
  task: () => Promise<T>;
}): Promise<T> => {
  const started = Date.now();
  let warned = false;
  const warn = () => {
    warned = true;
    logger.warn({
      caller,
      loggerKey,
      message: `${label} exceeded ${thresholdMs} ms.`,
      context: { ...context, thresholdMs, elapsedMs: Date.now() - started }
    });
  };
  const timer = setTimeout(warn, thresholdMs + 1);
  timer.unref();
  try {
    return await task();
  } finally {
    clearTimeout(timer);
    // Synchronous work may finish before the event loop can fire the timer.
    if (!warned && Date.now() - started > thresholdMs) warn();
  }
};
