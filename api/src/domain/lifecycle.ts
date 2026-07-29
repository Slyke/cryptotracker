import { Decimal } from 'decimal.js';

export interface AssetIdentity {
  canonicalId: string;
  symbol: string;
  network: string | null;
  contractOrMint: string | null;
  wrappedUnderlyingId?: string | null;
  stablecoin?: boolean;
}

export interface LifecycleEvent {
  id: string;
  eventType: 'migration' | 'redenomination' | 'swap' | 'fork' | 'delisting';
  sourceAssetId: string;
  destinationAssetId: string | null;
  effectiveAtMs: number;
  conversionRatio: string | null;
}

export const sameAssetIdentity = ({
  left,
  right
}: {
  left: AssetIdentity;
  right: AssetIdentity;
}) => (
  left.canonicalId === right.canonicalId
  && left.network === right.network
  && left.contractOrMint === right.contractOrMint
);

export const deriveLifecycleQuantity = ({
  assetId,
  quantity,
  timestampMs,
  events
}: {
  assetId: string;
  quantity: string;
  timestampMs: number;
  events: LifecycleEvent[];
}) => {
  let currentAssetId = assetId;
  let currentQuantity = new Decimal(quantity);
  const appliedEventIds: string[] = [];
  const ordered = events.slice().sort((left, right) => left.effectiveAtMs - right.effectiveAtMs || left.id.localeCompare(right.id));

  for (const event of ordered) {
    if (
      event.effectiveAtMs > timestampMs
      || event.sourceAssetId !== currentAssetId
      || !event.destinationAssetId
      || !event.conversionRatio
      || !['migration', 'redenomination', 'swap'].includes(event.eventType)
    ) {
      continue;
    }
    currentQuantity = currentQuantity.times(event.conversionRatio);
    currentAssetId = event.destinationAssetId;
    appliedEventIds.push(event.id);
  }

  return {
    assetId: currentAssetId,
    quantity: currentQuantity.toString(),
    derived: appliedEventIds.length > 0,
    appliedEventIds
  };
};

export const resolveObservedValue = ({
  asset,
  quantity,
  observedPrice
}: {
  asset: AssetIdentity;
  quantity: string;
  observedPrice: string | null;
}) => {
  if (observedPrice === null) {
    return {
      value: null,
      priced: false,
      reason: asset.stablecoin
        ? 'Stablecoin has no observed price; its named peg is not assumed.'
        : 'Asset has no trustworthy observed price.'
    };
  }

  return {
    value: new Decimal(quantity).times(observedPrice).toString(),
    priced: true,
    reason: null
  };
};
