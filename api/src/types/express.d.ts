import type { AuthenticatedIdentity } from '../auth/service.js';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      identity: AuthenticatedIdentity | null;
    }
  }
}

export {};
