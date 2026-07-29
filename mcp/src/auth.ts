import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClientIdentity, McpRuntimeSecrets } from './config.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

export const authenticateBearer = ({
  authorization,
  secrets
}: {
  authorization: string | string[] | undefined;
  secrets: McpRuntimeSecrets;
}): ClientIdentity | null => {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  const supplied = digest(match[1]);
  for (const entry of secrets.clientApiKeys) {
    if (timingSafeEqual(supplied, digest(entry.key))) {
      return {
        name: entry.name,
        role: entry.role
      };
    }
  }
  return null;
};

export const toMcpAuthInfo = ({ identity }: { identity: ClientIdentity }) => ({
  token: '<redacted>',
  clientId: identity.name,
  scopes: identity.role === 'readwrite' ? ['read', 'write'] : ['read']
});
