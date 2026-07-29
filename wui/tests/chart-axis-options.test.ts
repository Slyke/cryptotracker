import { describe, expect, it } from 'vitest';
import {
  buildChartAxisOptions,
  filterChartAxisOptions
} from '../src/lib/chart-axis-options.js';

describe('chart Y-axis options', () => {
  const options = buildChartAxisOptions({
    primaryCurrency: 'cad',
    listedCurrencies: ['USD', 'eur', 'JPY', 'GBP', 'AUD'],
    denominationOptions: [
      { id: 'bitcoin', symbol: 'BTC', label: 'BTC · Bitcoin' },
      { id: 'ethereum', symbol: 'ETH', label: 'ETH · Ethereum' },
      { id: 'shiba-inu', symbol: 'SHIB', label: 'SHIB · Shiba Inu' }
    ]
  });

  it('lists the primary and every configured fiat currency before all crypto assets', () => {
    expect(options.map((option) => option.value)).toEqual([
      'CAD',
      'USD',
      'EUR',
      'JPY',
      'GBP',
      'AUD',
      'bitcoin',
      'ethereum',
      'shiba-inu'
    ]);
    expect(options.filter((option) => option.group === 'Fiat currencies')).toHaveLength(6);
    expect(options.filter((option) => option.group === 'Crypto assets')).toHaveLength(3);
  });

  it('searches by fiat code, crypto symbol, name, and canonical ID', () => {
    expect(filterChartAxisOptions({ options, query: 'eur' }).map((option) => option.value))
      .toEqual(['EUR']);
    expect(filterChartAxisOptions({ options, query: 'shib' }).map((option) => option.value))
      .toEqual(['shiba-inu']);
    expect(filterChartAxisOptions({ options, query: 'ethereum crypto' }).map((option) => option.value))
      .toEqual(['ethereum']);
    expect(filterChartAxisOptions({ options, query: 'missing' })).toEqual([]);
  });
});
