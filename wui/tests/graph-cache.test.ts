import { describe, expect, it } from 'vitest';
import { dashboardGraphCachePlans } from '../src/lib/graph-cache.js';
import type { SavedGraph } from '../src/lib/preferences.js';

const graphs: SavedGraph[] = [{
  id: 'sol-chart',
  name: 'SOL',
  type: 'market',
  hidden: false,
  config: {
    assetIds: ['solana'],
    range: '30d',
    granularity: '14400',
    source: 'combined',
    chartMode: 'line',
    visibleSeriesIds: ['solana'],
    tooltipUnits: ['CAD', 'USD']
  }
}, {
  id: 'portfolio-chart',
  name: 'Portfolio',
  type: 'portfolio',
  hidden: false,
  config: {
    range: '30d',
    granularity: 'auto'
  }
}, {
  id: 'fixed-address-chart',
  name: 'Addresses',
  type: 'addresses',
  hidden: false,
  config: {
    range: 'custom',
    customRangeMode: 'dates',
    customFromMs: 100,
    customToMs: 200,
    granularity: 'auto'
  }
}, {
  id: 'table',
  name: 'Table',
  type: 'market',
  hidden: false,
  config: { dashboardView: 'table', assetIds: ['bitcoin'] }
}];

describe('dashboard graph cache plans', () => {
  it('materializes only chart requests with stable identities and exact current settings', () => {
    const plans = dashboardGraphCachePlans({
      graphs,
      primaryCurrency: 'CAD',
      tooltipCurrencies: ['CAD', 'USD'],
      now: 4_000_000_000
    });
    expect(plans.map((plan) => plan.scope)).toEqual([
      'market',
      'market',
      'portfolio',
      'addresses'
    ]);
    expect(plans.filter((plan) => plan.scope === 'market').map((plan) => (
      plan.input.quoteCurrency
    ))).toEqual(['CAD', 'USD']);
    expect(plans[0]?.input).toMatchObject({
      assetIds: ['solana'],
      fromMs: 4_000_000_000 - (30 * 24 * 60 * 60_000),
      toMs: 4_000_000_000,
      granularity: 14_400
    });
    expect(plans.at(-1)).toMatchObject({
      scope: 'addresses',
      sliding: false,
      input: { fromMs: 100, toMs: 200 }
    });
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(plans.length);

    const changed = dashboardGraphCachePlans({
      graphs: [{ ...graphs[0]!, config: { ...graphs[0]!.config, granularity: '3600' } }],
      primaryCurrency: 'CAD',
      tooltipCurrencies: ['CAD', 'USD'],
      now: 4_000_000_000
    });
    expect(changed[0]?.id).toBe(plans[0]?.id);
    expect(changed[0]?.revision).not.toBe(plans[0]?.revision);
  });
});
