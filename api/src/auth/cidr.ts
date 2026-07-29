import { isIP } from 'node:net';

interface ParsedIp {
  version: 4 | 6;
  bits: 32 | 128;
  value: bigint;
}

export const normalizeIpAddress = ({ value }: { value: string }) => {
  let normalized = value.trim().replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.toLowerCase().startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return mapped;
  }
  return normalized;
};

const ipv4Value = ({ value }: { value: string }) => {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
};

const ipv6Value = ({ value }: { value: string }) => {
  let normalized = value.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4Value({ value: normalized.slice(lastColon + 1) });
    if (lastColon < 0 || ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const segments = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (segments.length !== 8) return null;
  let result = 0n;
  for (const segment of segments) {
    if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(segment, 16));
  }
  return result;
};

const parseIp = ({ value }: { value: string }): ParsedIp | null => {
  const normalized = normalizeIpAddress({ value });
  const version = isIP(normalized);
  if (version === 4) {
    const parsed = ipv4Value({ value: normalized });
    return parsed === null ? null : { version, bits: 32, value: parsed };
  }
  if (version === 6) {
    const parsed = ipv6Value({ value: normalized });
    return parsed === null ? null : { version, bits: 128, value: parsed };
  }
  return null;
};

export interface CidrRule {
  version: 4 | 6;
  mask: bigint;
  network: bigint;
  prefixLength: number;
  raw: string;
}

export const parseCidr = ({ value }: { value: string }): CidrRule => {
  const [address, prefixInput, ...extra] = value.trim().split('/');
  if (!address || extra.length > 0) throw new Error(`Invalid CIDR: ${value}`);
  const parsed = parseIp({ value: address });
  if (!parsed) throw new Error(`Invalid CIDR: ${value}`);
  const prefixLength = prefixInput === undefined ? parsed.bits : Number(prefixInput);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsed.bits) {
    throw new Error(`Invalid CIDR: ${value}`);
  }
  const mask = prefixLength === 0
    ? 0n
    : ((1n << BigInt(prefixLength)) - 1n) << BigInt(parsed.bits - prefixLength);
  return {
    version: parsed.version,
    mask,
    network: parsed.value & mask,
    prefixLength,
    raw: value
  };
};

export const isIpInCidrs = ({
  address,
  cidrs
}: {
  address: string;
  cidrs: CidrRule[];
}) => {
  const parsed = parseIp({ value: address });
  if (!parsed) return false;
  return cidrs.some((cidr) => (
    cidr.version === parsed.version
    && (parsed.value & cidr.mask) === cidr.network
  ));
};
