import { describe, expect, it } from 'vitest';
import { includeKrakenEarnBalances } from '../src/domain/kraken-assets.js';

describe('Kraken portfolio Earn balances', () => {
  it('keeps the BTC total unchanged when spot BTC moves into a vault', () => {
    const before = includeKrakenEarnBalances({ balances: { XXBT: '0.13411' }, allocations: [] });
    const after = includeKrakenEarnBalances({
      balances: { XXBT: '0' },
      allocations: [{ assetRaw: 'BTC', quantity: '0.13411' }]
    });
    expect(after).toEqual({ XXBT: '0', 'BTC.B': before.XXBT });
  });

  it('aggregates strategies and adds only Earn not represented in suffixed balances', () => {
    expect(includeKrakenEarnBalances({
      balances: { XXBT: '0.1', 'XXBT.B': '0.02', 'XBT.F': '0.01' },
      allocations: [
        { assetRaw: 'BTC', quantity: '0.02' },
        { assetRaw: 'XBT', quantity: '0.03' }
      ]
    })).toEqual({ XXBT: '0.1', 'XXBT.B': '0.02', 'XBT.F': '0.01', 'BTC.B': '0.02' });
  });

  it('does not duplicate existing staking balances or subtract them', () => {
    expect(includeKrakenEarnBalances({
      balances: { 'ETH2.S': '3', 'DOT28.S': '10', 'BTC.B': '0.13411' },
      allocations: [
        { assetRaw: 'ETH', quantity: '2' },
        { assetRaw: 'DOT', quantity: '10' },
        { assetRaw: 'BTC', quantity: '0.13411' }
      ]
    })).toEqual({ 'ETH2.S': '3', 'DOT28.S': '10', 'BTC.B': '0.13411' });
  });

  it('adds a remainder to an existing matching balance without overwriting it', () => {
    expect(includeKrakenEarnBalances({
      balances: { 'BTC.B': '0.1' },
      allocations: [{ assetRaw: 'BTC', quantity: '0.13411' }]
    })).toEqual({ 'BTC.B': '0.13411' });
  });
});
