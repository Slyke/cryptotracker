import { Decimal } from 'decimal.js';

export interface TransferCandidate {
  id: string;
  source: 'kraken' | 'chain';
  assetId: string;
  direction: 'in' | 'out';
  quantity: string;
  occurredAtMs: number;
  transactionId?: string | null;
  network?: string | null;
  feeQuantity?: string | null;
}

export interface TransferMatch {
  leftId: string;
  rightId: string;
  confidence: 'exact' | 'likely' | 'unmatched';
  evidence: Record<string, unknown>;
}

const oppositeDirection = ({ left, right }: { left: TransferCandidate; right: TransferCandidate }) => (
  left.direction !== right.direction
);

export const reconcileTransfer = ({
  kraken,
  chain,
  windowMs = 6 * 60 * 60 * 1_000,
  amountTolerancePercent = '0.5'
}: {
  kraken: TransferCandidate;
  chain: TransferCandidate;
  windowMs?: number;
  amountTolerancePercent?: string;
}): TransferMatch => {
  if (
    kraken.source !== 'kraken'
    || chain.source !== 'chain'
    || kraken.assetId !== chain.assetId
    || !oppositeDirection({ left: kraken, right: chain })
  ) {
    return {
      leftId: kraken.id,
      rightId: chain.id,
      confidence: 'unmatched',
      evidence: { reason: 'source_asset_or_direction_mismatch' }
    };
  }

  const krakenQuantity = new Decimal(kraken.quantity).abs();
  const chainQuantity = new Decimal(chain.quantity).abs();
  const fee = new Decimal(kraken.feeQuantity ?? chain.feeQuantity ?? '0').abs();
  const exactAfterFee = krakenQuantity.minus(fee).equals(chainQuantity)
    || chainQuantity.minus(fee).equals(krakenQuantity);
  const larger = Decimal.max(krakenQuantity, chainQuantity);
  const differencePercent = larger.isZero()
    ? new Decimal(0)
    : krakenQuantity.minus(chainQuantity).abs().dividedBy(larger).times(100);
  const identifierMatch = Boolean(
    kraken.transactionId
      && chain.transactionId
      && kraken.transactionId.toLowerCase() === chain.transactionId.toLowerCase()
      && (!kraken.network || !chain.network || kraken.network === chain.network)
  );
  const amountMatches = krakenQuantity.equals(chainQuantity)
    || exactAfterFee
    || differencePercent.lessThanOrEqualTo(amountTolerancePercent);
  if (identifierMatch && amountMatches) {
    return {
      leftId: kraken.id,
      rightId: chain.id,
      confidence: 'exact',
      evidence: {
        transactionId: kraken.transactionId,
        network: kraken.network ?? chain.network ?? null,
        assetId: kraken.assetId,
        amountDifferencePercent: differencePercent.toString()
      }
    };
  }
  if (identifierMatch) {
    return {
      leftId: kraken.id,
      rightId: chain.id,
      confidence: 'unmatched',
      evidence: {
        reason: 'identifier_amount_mismatch',
        transactionId: kraken.transactionId,
        amountDifferencePercent: differencePercent.toString()
      }
    };
  }

  const withinWindow = Math.abs(kraken.occurredAtMs - chain.occurredAtMs) <= windowMs;
  if (exactAfterFee && withinWindow) {
    return {
      leftId: kraken.id,
      rightId: chain.id,
      confidence: 'exact',
      evidence: {
        amountAfterFee: true,
        feeQuantity: fee.toString(),
        timeDeltaMs: Math.abs(kraken.occurredAtMs - chain.occurredAtMs)
      }
    };
  }

  if (withinWindow && differencePercent.lessThanOrEqualTo(amountTolerancePercent)) {
    return {
      leftId: kraken.id,
      rightId: chain.id,
      confidence: 'likely',
      evidence: {
        amountDifferencePercent: differencePercent.toString(),
        timeDeltaMs: Math.abs(kraken.occurredAtMs - chain.occurredAtMs)
      }
    };
  }

  return {
    leftId: kraken.id,
    rightId: chain.id,
    confidence: 'unmatched',
    evidence: {
      amountDifferencePercent: differencePercent.toString(),
      timeDeltaMs: Math.abs(kraken.occurredAtMs - chain.occurredAtMs)
    }
  };
};

export const classifyOwnedTransfer = ({
  match
}: {
  match: TransferMatch;
}) => ({
  isInternalTransfer: match.confidence === 'exact',
  affectsRealisedPnl: match.confidence !== 'exact',
  carriesBasis: match.confidence === 'exact',
  requiresInspection: match.confidence === 'likely'
});
