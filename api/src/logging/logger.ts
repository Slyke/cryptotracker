import { appendFile, mkdir } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { RuntimeConfig } from '../config/schema.js';
import { AppError } from '../errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogInput {
  level: LogLevel;
  caller: string;
  loggerKey?: string;
  errorKey?: string;
  errorCode?: string;
  message: string;
  correlationId?: string | null;
  username?: string | null;
  context?: unknown;
  rootCause?: unknown;
}

const sensitiveKeyPattern = /(secret|password|token|cookie|authorization|api[-_]?key|signature|private[-_]?key)/i;
const sensitiveUrlQueryPattern = /(api[_-]?key|key|token|signature|secret)=([^&]+)/gi;
const supportedLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const redactUrl = ({ value }: { value: string }) => (
  value.replace(sensitiveUrlQueryPattern, '$1=[REDACTED]')
);

export const redact = ({ value, key = '' }: { value: unknown; key?: string }): unknown => {
  if (sensitiveKeyPattern.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactUrl({ value });
  if (Array.isArray(value)) return value.map((entry) => redact({ value: entry }));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redactUrl({ value: value.message }),
        ...(value instanceof AppError
          ? {
              errorKey: value.errorKey,
              errorCode: value.errorCode,
              context: redact({ value: value.context })
            }
          : {})
      };
    }

    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact({ value: entryValue, key: entryKey })
      ])
    );
  }
  return value;
};

const kubernetesMetadata = () => {
  const mapping: Record<string, string> = {
    podName: 'K8S_POD_NAME',
    deployment: 'K8S_DEPLOYMENT',
    namespace: 'K8S_NAMESPACE',
    podIp: 'K8S_POD_IP',
    podIps: 'K8S_POD_IPS',
    nodeName: 'K8S_NODE_NAME'
  };
  return Object.fromEntries(
    Object.entries(mapping)
      .filter(([, envKey]) => Boolean(process.env[envKey]))
      .map(([key, envKey]) => [key, process.env[envKey]])
  );
};

const shouldWrite = ({
  level,
  levels
}: {
  level: LogLevel;
  levels: LogLevel[];
}) => levels.length === 0 || levels.includes(level);

const interpolateLog = ({
  format,
  entry
}: {
  format: string;
  entry: Record<string, unknown>;
}) => format.replace(/\{\$([A-Za-z0-9_]+)\}/g, (_match, key: string) => String(entry[key] ?? ''));

const syslogSeverity = ({ level }: { level: LogLevel }) => ({
  debug: 7,
  info: 6,
  warn: 4,
  error: 3
})[level];

const sendSyslog = async ({
  config,
  level,
  message
}: {
  config: RuntimeConfig['logging']['sinks']['syslog'];
  level: LogLevel;
  message: string;
}) => {
  const facilityCode = /^local([0-7])$/.test(config.facility)
    ? 16 + Number(config.facility.slice(-1))
    : 16;
  const priority = (facilityCode * 8) + syslogSeverity({ level });
  const payload = `<${priority}>1 ${new Date().toISOString()} ${config.hostname || hostname()} ${config.appName} ${process.pid} cryptotracker - ${message}`;

  if (config.protocol === 'udp') {
    await new Promise<void>((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.send(payload, config.port, config.host, (error) => {
        socket.close();
        if (error) return reject(error);
        return resolve();
      });
    });
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const socket = config.protocol === 'tls'
      ? connectTls({ host: config.host, port: config.port })
      : connectTcp({ host: config.host, port: config.port });
    socket.setTimeout(config.timeoutMs);
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('Syslog timeout')));
    socket.once(config.protocol === 'tls' ? 'secureConnect' : 'connect', () => {
      socket.end(`${Buffer.byteLength(payload)} ${payload}`, () => resolve());
    });
  });
};

export class Logger {
  constructor(private readonly config: RuntimeConfig['logging']) {}

  private async emit({ input }: { input: LogInput }) {
    const gateKey = input.errorKey ?? input.loggerKey ?? '';
    const gate = gateKey ? this.config.gates[gateKey] : undefined;
    if (gate?.enabled === false) return;
    const level = gate?.level ?? input.level;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      caller: input.caller,
      message: input.message,
      ...(input.loggerKey ? { loggerKey: input.loggerKey } : {}),
      ...(input.errorKey ? { errorKey: input.errorKey } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.context !== undefined ? { context: redact({ value: input.context }) } : {}),
      ...(input.rootCause !== undefined ? { rootCause: redact({ value: input.rootCause }) } : {}),
      ...(this.config.kubernetes.enabled ? { kubernetes: kubernetesMetadata() } : {})
    };
    const json = JSON.stringify(entry);
    const text = interpolateLog({
      format: this.config.logTextFormat,
      entry
    }).trim();
    const pending: Promise<unknown>[] = [];

    if (
      this.config.sinks.console.enabled
      && gate?.console !== false
      && shouldWrite({ level, levels: this.config.sinks.console.levels })
    ) {
      const rendered = this.config.sinks.console.format === 'json' ? json : text;
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](rendered);
    }

    const file = this.config.sinks.file;
    if (
      file.enabled
      && file.path
      && gate?.file !== false
      && shouldWrite({ level, levels: file.levels })
    ) {
      pending.push(
        mkdir(dirname(file.path), { recursive: true })
          .then(() => appendFile(file.path!, `${file.format === 'json' ? json : text}\n`, 'utf8'))
      );
    }

    const http = this.config.sinks.http;
    if (
      http.enabled
      && http.url
      && gate?.http !== false
      && shouldWrite({ level, levels: http.levels })
    ) {
      pending.push(fetch(http.url, {
        method: http.method,
        headers: {
          'content-type': 'application/json',
          ...http.headers
        },
        body: json,
        signal: AbortSignal.timeout(http.timeoutMs)
      }));
    }

    const syslog = this.config.sinks.syslog;
    if (
      syslog.enabled
      && gate?.syslog !== false
      && shouldWrite({ level, levels: syslog.levels })
    ) {
      pending.push(sendSyslog({
        config: syslog,
        level,
        message: syslog.format === 'json' ? json : text
      }));
    }

    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }

  log(input: LogInput) {
    void this.emit({ input }).catch((error) => {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        caller: 'logger::emit',
        loggerKey: 'LOGGER_SINK_FAILED',
        message: 'A configured logging sink failed.',
        rootCause: redact({ value: error })
      }));
    });
  }

  debug(input: Omit<LogInput, 'level'>) {
    this.log({ ...input, level: 'debug' });
  }

  info(input: Omit<LogInput, 'level'>) {
    this.log({ ...input, level: 'info' });
  }

  warn(input: Omit<LogInput, 'level'>) {
    this.log({ ...input, level: 'warn' });
  }

  error({
    error,
    ...input
  }: Omit<LogInput, 'level' | 'rootCause'> & { error: unknown }) {
    const appError = error instanceof AppError ? error : null;
    this.log({
      ...input,
      level: 'error',
      ...(appError
        ? {
            errorKey: appError.errorKey,
            errorCode: appError.errorCode,
            context: appError.context
          }
        : {}),
      rootCause: error
    });
  }
}

export const loggerInternals = {
  interpolateLog,
  redactUrl,
  shouldWrite
};
