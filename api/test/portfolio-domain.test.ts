import { describe, expect, it } from 'vitest';
import {
  normalizeAddress,
  reconstructBalance,
  validateAddress,
  valueHoldings
} from '../src/domain/addresses.js';
import {
  calculateCostBasis,
  carryTransferBasis,
  type BasisEvent
} from '../src/domain/cost-basis.js';
import {
  classifyOwnedTransfer,
  reconcileTransfer,
  type TransferCandidate
} from '../src/domain/reconciliation.js';

describe('addresses', () => {
  it('validates Bitcoin, Ethereum, and Solana addresses', async () => {
    await expect(validateAddress({
      network: 'bitcoin',
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
    })).resolves.toBe(true);
    await expect(validateAddress({
      network: 'ethereum',
      address: '0x52908400098527886E0F7030069857D2E4169EE7'
    })).resolves.toBe(true);
    await expect(validateAddress({
      network: 'solana',
      address: '11111111111111111111111111111111'
    })).resolves.toBe(true);
    expect(normalizeAddress({
      network: 'ethereum',
      address: '  0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD  '
    })).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
  });

  it('reconstructs deterministic exact-decimal balances', () => {
    expect(reconstructBalance({
      events: [
        { id: 'b', assetId: 'bitcoin', occurredAtMs: 10, orderingKey: '2', quantityDelta: '-0.1' },
        { id: 'a', assetId: 'bitcoin', occurredAtMs: 10, orderingKey: '1', quantityDelta: '0.3' },
        { id: 'c', assetId: 'bitcoin', occurredAtMs: 20, orderingKey: '1', quantityDelta: '0.00000001' }
      ],
      buckets: [10, 20]
    })).toEqual([
      { timestampMs: 10, assetId: 'bitcoin', quantity: '0.2' },
      { timestampMs: 20, assetId: 'bitcoin', quantity: '0.20000001' }
    ]);
    expect(valueHoldings({
      quantities: { bitcoin: '0.2', unknown: '4' },
      prices: { bitcoin: '100000', unknown: null }
    })).toMatchObject({
      total: '20000',
      coveragePercent: '50',
      pricedAssets: 1,
      totalAssets: 2
    });
  });
});

describe('owned-transfer reconciliation', () => {
  const kraken: TransferCandidate = {
    id: 'k',
    source: 'kraken',
    assetId: 'bitcoin',
    direction: 'out',
    quantity: '1',
    occurredAtMs: 1_000,
    transactionId: 'ABC',
    network: 'bitcoin',
    feeQuantity: '0.001'
  };

  it('distinguishes exact, likely, and unmatched transfers', () => {
    const exact = reconcileTransfer({
      kraken,
      chain: {
        id: 'c1',
        source: 'chain',
        assetId: 'bitcoin',
        direction: 'in',
        quantity: '0.999',
        occurredAtMs: 2_000,
        transactionId: 'abc',
        network: 'bitcoin'
      }
    });
    expect(exact.confidence).toBe('exact');
    expect(classifyOwnedTransfer({ match: exact })).toEqual({
      isInternalTransfer: true,
      affectsRealisedPnl: false,
      carriesBasis: true,
      requiresInspection: false
    });
    expect(reconcileTransfer({
      kraken: { ...kraken, transactionId: null, feeQuantity: null },
      chain: {
        id: 'c2',
        source: 'chain',
        assetId: 'bitcoin',
        direction: 'in',
        quantity: '0.997',
        occurredAtMs: 3_000
      }
    }).confidence).toBe('likely');
    expect(reconcileTransfer({
      kraken,
      chain: {
        id: 'c3',
        source: 'chain',
        assetId: 'ethereum',
        direction: 'in',
        quantity: '1',
        occurredAtMs: 2_000
      }
    }).confidence).toBe('unmatched');
    expect(reconcileTransfer({
      kraken,
      chain: {
        id: 'c4',
        source: 'chain',
        assetId: 'bitcoin',
        direction: 'in',
        quantity: '100',
        occurredAtMs: 2_000,
        transactionId: 'abc',
        network: 'bitcoin'
      }
    })).toMatchObject({
      confidence: 'unmatched',
      evidence: {
        reason: 'identifier_amount_mismatch'
      }
    });
  });

  it('carries proportional basis and isolates fee basis', () => {
    expect(carryTransferBasis({
      sourceQuantity: '2',
      sourceBasisCad: '1000',
      transferredQuantity: '1.9',
      networkFeeQuantity: '0.01'
    })).toEqual({
      carriedBasisCad: '950',
      feeBasisCad: '5',
      remainingBasisCad: '45'
    });
    expect(carryTransferBasis({
      sourceQuantity: '2',
      sourceBasisCad: null,
      transferredQuantity: '1'
    }).carriedBasisCad).toBeNull();
  });
});

describe('cost basis', () => {
  const events: BasisEvent[] = [
    { id: 'a', assetId: 'bitcoin', occurredAtMs: 1, type: 'acquisition', quantity: '1', valueCad: '100', feeCad: '1' },
    { id: 'b', assetId: 'bitcoin', occurredAtMs: 2, type: 'acquisition', quantity: '1', valueCad: '200', feeCad: '0' },
    { id: 'c', assetId: 'bitcoin', occurredAtMs: 3, type: 'disposition', quantity: '1', valueCad: '300', feeCad: '3' }
  ];

  it('computes ACB, FIFO, and LIFO independently', () => {
    expect(calculateCostBasis({ events, method: 'acb' }).dispositions[0]?.knownBasisCad).toBe('150.5');
    expect(calculateCostBasis({ events, method: 'fifo' }).dispositions[0]?.knownBasisCad).toBe('101');
    expect(calculateCostBasis({ events, method: 'lifo' }).dispositions[0]?.knownBasisCad).toBe('200');
  });

  it('shows unknown basis and never treats it as zero', () => {
    const result = calculateCostBasis({
      method: 'fifo',
      events: [
        { id: 'unknown', assetId: 'solana', occurredAtMs: 1, type: 'reward', quantity: '2', valueCad: null },
        { id: 'sell', assetId: 'solana', occurredAtMs: 2, type: 'disposition', quantity: '1', valueCad: '50' }
      ]
    });
    expect(result.dispositions[0]).toMatchObject({
      unknownQuantity: '1',
      realisedPnlCad: null
    });
    expect(result.basisCoveragePercent).toBe('0');
  });
});
