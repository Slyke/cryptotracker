import { Decimal } from 'decimal.js';

export type CostBasisMethod = 'acb' | 'fifo' | 'lifo';

export interface BasisEvent {
  id: string;
  assetId: string;
  occurredAtMs: number;
  type: 'acquisition' | 'disposition' | 'reward' | 'internal_in' | 'internal_out';
  quantity: string;
  valueCad: string | null;
  feeCad?: string | null;
  linkedLotIds?: string[];
}

interface WorkingLot {
  id: string;
  assetId: string;
  acquiredAtMs: number;
  quantity: Decimal;
  remaining: Decimal;
  basisCad: Decimal | null;
  sourceEventId: string;
}

export interface DispositionResult {
  eventId: string;
  quantity: string;
  proceedsCad: string | null;
  knownBasisCad: string;
  unknownQuantity: string;
  realisedPnlCad: string | null;
  consumedLots: Array<{
    lotId: string;
    quantity: string;
    basisCad: string | null;
  }>;
}

const calculateCoverage = ({
  knownQuantity,
  totalQuantity
}: {
  knownQuantity: Decimal;
  totalQuantity: Decimal;
}) => totalQuantity.isZero()
  ? '100'
  : knownQuantity.dividedBy(totalQuantity).times(100).toDecimalPlaces(8).toString();

const calculateAcb = ({
  events
}: {
  events: BasisEvent[];
}) => {
  const quantities = new Map<string, Decimal>();
  const knownQuantities = new Map<string, Decimal>();
  const knownBasis = new Map<string, Decimal>();
  const dispositions: DispositionResult[] = [];

  for (const event of events) {
    const quantity = new Decimal(event.quantity).abs();
    const fee = new Decimal(event.feeCad ?? '0');
    const currentQuantity = quantities.get(event.assetId) ?? new Decimal(0);
    const currentKnownQuantity = knownQuantities.get(event.assetId) ?? new Decimal(0);
    const currentBasis = knownBasis.get(event.assetId) ?? new Decimal(0);

    if (['acquisition', 'reward', 'internal_in'].includes(event.type)) {
      quantities.set(event.assetId, currentQuantity.plus(quantity));
      if (event.valueCad === null) {
        knownQuantities.set(event.assetId, currentKnownQuantity);
        knownBasis.set(event.assetId, currentBasis);
      } else {
        knownQuantities.set(event.assetId, currentKnownQuantity.plus(quantity));
        knownBasis.set(event.assetId, currentBasis.plus(event.valueCad).plus(fee));
      }
      continue;
    }

    const knownRatio = currentQuantity.isZero()
      ? new Decimal(0)
      : currentKnownQuantity.dividedBy(currentQuantity);
    const consumedKnownQuantity = Decimal.min(quantity.times(knownRatio), currentKnownQuantity);
    const unknownQuantity = quantity.minus(consumedKnownQuantity);
    const unitBasis = currentKnownQuantity.isZero()
      ? new Decimal(0)
      : currentBasis.dividedBy(currentKnownQuantity);
    const consumedBasis = consumedKnownQuantity.times(unitBasis);
    const proceeds = event.valueCad === null ? null : new Decimal(event.valueCad).minus(fee);
    dispositions.push({
      eventId: event.id,
      quantity: quantity.toString(),
      proceedsCad: proceeds?.toString() ?? null,
      knownBasisCad: consumedBasis.toString(),
      unknownQuantity: unknownQuantity.toString(),
      realisedPnlCad: proceeds !== null && unknownQuantity.isZero()
        ? proceeds.minus(consumedBasis).toString()
        : null,
      consumedLots: [{
        lotId: `acb:${event.assetId}`,
        quantity: consumedKnownQuantity.toString(),
        basisCad: consumedBasis.toString()
      }]
    });
    quantities.set(event.assetId, Decimal.max(0, currentQuantity.minus(quantity)));
    knownQuantities.set(event.assetId, Decimal.max(0, currentKnownQuantity.minus(consumedKnownQuantity)));
    knownBasis.set(event.assetId, Decimal.max(0, currentBasis.minus(consumedBasis)));
  }

  const totalQuantity = Decimal.sum(0, ...quantities.values());
  const totalKnownQuantity = Decimal.sum(0, ...knownQuantities.values());
  return {
    method: 'acb' as const,
    dispositions,
    lots: [...quantities.entries()].map(([assetId, quantity]) => ({
      id: `acb:${assetId}`,
      assetId,
      remainingQuantity: quantity.toString(),
      basisCad: (knownBasis.get(assetId) ?? new Decimal(0)).toString(),
      basisKnown: (knownQuantities.get(assetId) ?? new Decimal(0)).equals(quantity)
    })),
    basisCoveragePercent: calculateCoverage({
      knownQuantity: totalKnownQuantity,
      totalQuantity
    })
  };
};

const calculateLotMethod = ({
  events,
  method
}: {
  events: BasisEvent[];
  method: 'fifo' | 'lifo';
}) => {
  const lots: WorkingLot[] = [];
  const dispositions: DispositionResult[] = [];

  for (const event of events) {
    const quantity = new Decimal(event.quantity).abs();
    const fee = new Decimal(event.feeCad ?? '0');
    if (['acquisition', 'reward', 'internal_in'].includes(event.type)) {
      lots.push({
        id: `lot:${event.id}`,
        assetId: event.assetId,
        acquiredAtMs: event.occurredAtMs,
        quantity,
        remaining: quantity,
        basisCad: event.valueCad === null ? null : new Decimal(event.valueCad).plus(fee),
        sourceEventId: event.id
      });
      continue;
    }

    let remaining = quantity;
    let knownBasis = new Decimal(0);
    let unknownQuantity = new Decimal(0);
    const consumedLots: DispositionResult['consumedLots'] = [];
    const candidates = lots
      .filter((lot) => lot.assetId === event.assetId && lot.remaining.greaterThan(0))
      .sort((left, right) => (
        method === 'fifo'
          ? left.acquiredAtMs - right.acquiredAtMs
          : right.acquiredAtMs - left.acquiredAtMs
      ));

    for (const lot of candidates) {
      if (remaining.isZero()) break;
      const consumed = Decimal.min(lot.remaining, remaining);
      const consumedBasis = lot.basisCad === null
        ? null
        : lot.basisCad.times(consumed.dividedBy(lot.quantity));
      if (consumedBasis === null) {
        unknownQuantity = unknownQuantity.plus(consumed);
      } else {
        knownBasis = knownBasis.plus(consumedBasis);
      }
      lot.remaining = lot.remaining.minus(consumed);
      remaining = remaining.minus(consumed);
      consumedLots.push({
        lotId: lot.id,
        quantity: consumed.toString(),
        basisCad: consumedBasis?.toString() ?? null
      });
    }
    unknownQuantity = unknownQuantity.plus(remaining);
    const proceeds = event.valueCad === null ? null : new Decimal(event.valueCad).minus(fee);
    dispositions.push({
      eventId: event.id,
      quantity: quantity.toString(),
      proceedsCad: proceeds?.toString() ?? null,
      knownBasisCad: knownBasis.toString(),
      unknownQuantity: unknownQuantity.toString(),
      realisedPnlCad: proceeds !== null && unknownQuantity.isZero()
        ? proceeds.minus(knownBasis).toString()
        : null,
      consumedLots
    });
  }

  const openLots = lots.filter((lot) => lot.remaining.greaterThan(0));
  const totalQuantity = Decimal.sum(0, ...openLots.map((lot) => lot.remaining));
  const knownQuantity = Decimal.sum(0, ...openLots.filter((lot) => lot.basisCad !== null).map((lot) => lot.remaining));
  return {
    method,
    dispositions,
    lots: openLots.map((lot) => ({
      id: lot.id,
      assetId: lot.assetId,
      remainingQuantity: lot.remaining.toString(),
      basisCad: lot.basisCad === null
        ? null
        : lot.basisCad.times(lot.remaining.dividedBy(lot.quantity)).toString(),
      basisKnown: lot.basisCad !== null
    })),
    basisCoveragePercent: calculateCoverage({ knownQuantity, totalQuantity })
  };
};

export const calculateCostBasis = ({
  events,
  method
}: {
  events: BasisEvent[];
  method: CostBasisMethod;
}) => {
  const ordered = events.slice().sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.id.localeCompare(right.id));
  return method === 'acb'
    ? calculateAcb({ events: ordered })
    : calculateLotMethod({ events: ordered, method });
};

export const carryTransferBasis = ({
  sourceQuantity,
  sourceBasisCad,
  transferredQuantity,
  networkFeeQuantity = '0'
}: {
  sourceQuantity: string;
  sourceBasisCad: string | null;
  transferredQuantity: string;
  networkFeeQuantity?: string;
}) => {
  const quantity = new Decimal(sourceQuantity);
  const transferred = new Decimal(transferredQuantity);
  const fee = new Decimal(networkFeeQuantity);
  if (transferred.plus(fee).greaterThan(quantity)) {
    throw new Error('Transfer and fee exceed the source lot quantity.');
  }
  if (sourceBasisCad === null) {
    return {
      carriedBasisCad: null,
      feeBasisCad: null,
      remainingBasisCad: null
    };
  }
  const unitBasis = new Decimal(sourceBasisCad).dividedBy(quantity);
  return {
    carriedBasisCad: unitBasis.times(transferred).toString(),
    feeBasisCad: unitBasis.times(fee).toString(),
    remainingBasisCad: unitBasis.times(quantity.minus(transferred).minus(fee)).toString()
  };
};
