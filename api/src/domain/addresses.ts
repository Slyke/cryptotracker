import { Decimal } from 'decimal.js';

export type AddressNetwork = 'bitcoin' | 'dogecoin' | 'ethereum' | 'polkadot' | 'solana';

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const bech32Alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const decodeBase58 = ({ value }: { value: string }) => {
  let number = 0n;
  for (const character of value) {
    const index = base58Alphabet.indexOf(character);
    if (index === -1) return null;
    number = (number * 58n) + BigInt(index);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
};

const bech32Polymod = ({ values }: { values: number[] }) => {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let index = 0; index < 5; index += 1) {
      if ((top >>> index) & 1) checksum ^= generators[index]!;
    }
  }
  return checksum >>> 0;
};

const bech32PrefixExpand = ({ prefix }: { prefix: string }) => [
  ...[...prefix].map((character) => character.charCodeAt(0) >>> 5),
  0,
  ...[...prefix].map((character) => character.charCodeAt(0) & 31)
];

const validBitcoinBech32 = ({ value }: { value: string }) => {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return false;
  const normalized = value.toLowerCase();
  const separator = normalized.lastIndexOf('1');
  if (separator < 1 || (normalized.length - separator) < 7 || normalized.length > 90) return false;
  const prefix = normalized.slice(0, separator);
  if (prefix !== 'bc') return false;
  const data = [...normalized.slice(separator + 1)].map((character) => bech32Alphabet.indexOf(character));
  if (data.some((entry) => entry < 0)) return false;
  const polymod = bech32Polymod({ values: [...bech32PrefixExpand({ prefix }), ...data] });
  const witnessVersion = data[0];
  return witnessVersion === 0 ? polymod === 1 : polymod === 0x2bc830a3;
};

const validBase58Check = async ({
  value,
  versions
}: {
  value: string;
  versions: number[];
}) => {
  const bytes = decodeBase58({ value });
  if (!bytes || bytes.length !== 25 || !versions.includes(bytes[0]!)) return false;
  const { createHash } = await import('node:crypto');
  const payload = bytes.slice(0, 21);
  const checksum = createHash('sha256').update(
    createHash('sha256').update(payload).digest()
  ).digest().subarray(0, 4);
  return checksum.every((byte, index) => byte === bytes[21 + index]);
};

const validPolkadotSs58 = async ({ value }: { value: string }) => {
  const bytes = decodeBase58({ value });
  if (!bytes || bytes.length !== 35 || bytes[0] !== 0) return false;
  const { createHash } = await import('node:crypto');
  const payload = bytes.slice(0, 33);
  const prefix = new TextEncoder().encode('SS58PRE');
  const checksum = createHash('blake2b512')
    .update(prefix)
    .update(payload)
    .digest()
    .subarray(0, 2);
  return checksum[0] === bytes[33] && checksum[1] === bytes[34];
};

export const normalizeAddress = ({
  network,
  address
}: {
  network: AddressNetwork;
  address: string;
}) => {
  const trimmed = address.trim();
  return network === 'ethereum' ? trimmed.toLowerCase() : trimmed;
};

export const validateAddress = async ({
  network,
  address
}: {
  network: AddressNetwork;
  address: string;
}) => {
  const normalized = normalizeAddress({ network, address });
  if (network === 'ethereum') {
    return /^0x[0-9a-f]{40}$/.test(normalized);
  }
  if (network === 'solana') {
    const decoded = decodeBase58({ value: normalized });
    return decoded?.length === 32;
  }
  if (network === 'polkadot') {
    return validPolkadotSs58({ value: normalized });
  }
  if (network === 'dogecoin') {
    return validBase58Check({ value: normalized, versions: [0x1e, 0x16] });
  }
  if (/^(bc1)[02-9ac-hj-np-z]{11,71}$/i.test(normalized)) {
    return validBitcoinBech32({ value: normalized });
  }
  return validBase58Check({ value: normalized, versions: [0x00, 0x05] });
};

export interface BalanceEvent {
  id: string;
  assetId: string;
  occurredAtMs: number;
  orderingKey: string;
  quantityDelta: string;
}

export interface BalancePoint {
  timestampMs: number;
  assetId: string;
  quantity: string;
}

export const reconstructBalance = ({
  events,
  buckets
}: {
  events: BalanceEvent[];
  buckets: number[];
}): BalancePoint[] => {
  const orderedEvents = events.slice().sort((left, right) => (
    left.occurredAtMs - right.occurredAtMs
    || left.orderingKey.localeCompare(right.orderingKey)
    || left.id.localeCompare(right.id)
  ));
  const orderedBuckets = buckets.slice().sort((left, right) => left - right);
  const assetIds = [...new Set(orderedEvents.map((event) => event.assetId))].sort();
  const balances = new Map(assetIds.map((assetId) => [assetId, new Decimal(0)]));
  const points: BalancePoint[] = [];
  let eventIndex = 0;

  for (const timestampMs of orderedBuckets) {
    while (
      eventIndex < orderedEvents.length
      && orderedEvents[eventIndex]!.occurredAtMs <= timestampMs
    ) {
      const event = orderedEvents[eventIndex]!;
      balances.set(event.assetId, (balances.get(event.assetId) ?? new Decimal(0)).plus(event.quantityDelta));
      eventIndex += 1;
    }

    for (const assetId of assetIds) {
      points.push({
        timestampMs,
        assetId,
        quantity: balances.get(assetId)!.toString()
      });
    }
  }

  return points;
};

export const valueHoldings = ({
  quantities,
  prices
}: {
  quantities: Record<string, string>;
  prices: Record<string, string | null>;
}) => {
  let total = new Decimal(0);
  let pricedAssets = 0;
  const assetIds = Object.keys(quantities);
  const values = Object.fromEntries(assetIds.map((assetId) => {
    const price = prices[assetId] ?? null;
    if (price === null) return [assetId, null];
    pricedAssets += 1;
    const value = new Decimal(quantities[assetId]!).times(price);
    total = total.plus(value);
    return [assetId, value.toString()];
  }));
  return {
    total: total.toString(),
    values,
    pricedAssets,
    totalAssets: assetIds.length,
    coveragePercent: assetIds.length === 0
      ? '100'
      : new Decimal(pricedAssets).dividedBy(assetIds.length).times(100).toString()
  };
};

export const addressInternals = {
  decodeBase58,
  validBitcoinBech32,
  validPolkadotSs58
};
