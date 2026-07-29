import errorCodes from './errors.json' with { type: 'json' };

export interface AppErrorOptions {
  errorKey: string;
  reason: string;
  status?: number;
  context?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly errorKey: string;
  readonly errorCode: string;
  readonly status: number;
  readonly context: unknown;

  constructor({
    errorKey,
    reason,
    status = 500,
    context = null,
    cause
  }: AppErrorOptions) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.errorKey = errorKey;
    this.errorCode = errorCodes[errorKey as keyof typeof errorCodes] ?? errorCodes.ERR_UNKNOWN;
    this.status = status;
    this.context = context;
  }
}

export const asAppError = ({
  error,
  errorKey,
  reason,
  status = 500,
  context = null
}: {
  error: unknown;
  errorKey: string;
  reason: string;
  status?: number;
  context?: unknown;
}) => {
  if (error instanceof AppError) return error;
  return new AppError({
    errorKey,
    reason,
    status,
    context,
    cause: error
  });
};

export const errorResponse = ({
  error,
  correlationId
}: {
  error: AppError;
  correlationId: string;
}) => ({
  ok: false,
  error: {
    key: error.errorKey,
    code: error.errorCode,
    message: error.message,
    correlationId
  }
});
