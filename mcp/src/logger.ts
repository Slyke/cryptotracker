const sensitiveKey = (key: string) => {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return (
    normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'key'
    || normalized === 'password'
    || normalized === 'secret'
    || normalized === 'token'
    || normalized.endsWith('apikey')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
  );
};

export const redactForLog = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (!value || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    sensitiveKey(key) ? '[REDACTED]' : redactForLog(entry)
  ]));
};

interface LogInput {
  event: string;
  message: string;
  correlationId: string | null;
  context?: unknown;
  error?: unknown;
}

export class McpLogger {
  constructor(private readonly service = 'cryptotracker-mcp') {}

  private write(level: 'debug' | 'info' | 'warn' | 'error', input: LogInput) {
    const output = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      event: input.event,
      message: input.message,
      correlationId: input.correlationId,
      ...(input.context === undefined ? {} : { context: redactForLog(input.context) }),
      ...(input.error === undefined ? {} : { error: redactForLog(input.error) })
    };
    const line = JSON.stringify(output);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(input: LogInput) {
    this.write('debug', input);
  }

  info(input: LogInput) {
    this.write('info', input);
  }

  warn(input: LogInput) {
    this.write('warn', input);
  }

  error(input: LogInput) {
    this.write('error', input);
  }
}
