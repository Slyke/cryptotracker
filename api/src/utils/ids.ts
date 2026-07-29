import { randomBytes, randomUUID } from 'node:crypto';

export const createId = ({ prefix }: { prefix: string }) => `${prefix}_${randomUUID().replaceAll('-', '')}`;

export const createOpaqueToken = ({ bytes = 32 }: { bytes?: number } = {}) => randomBytes(bytes).toString('base64url');

export const redactIdentifier = ({ value }: { value: string }) => {
  if (value.length <= 8) return '[redacted]';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
};
