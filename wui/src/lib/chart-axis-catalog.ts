import { apiRequest } from '$lib/api';
import { configuredCurrencies } from '$lib/currencies';
import type { ChartDenominationOption } from '$lib/chart-axis-options';

export interface ActiveChartAxisCatalog {
  currencies: string[];
  denominationOptions: ChartDenominationOption[];
}

export interface ChartAxisAsset {
  canonicalId: string;
  symbol: string;
  name: string;
  enabled: boolean;
}

export const chartDenominationOptionsFromAssets = (
  assets: ChartAxisAsset[]
): ChartDenominationOption[] => assets
  .filter((asset) => asset.enabled)
  .map((asset) => ({
    id: asset.canonicalId,
    symbol: asset.symbol.toUpperCase(),
    label: `${asset.symbol.toUpperCase()} · ${asset.name}`
  }));

let catalogRequest: Promise<ActiveChartAxisCatalog> | null = null;

export const activeChartAxisCatalog = () => {
  catalogRequest ??= Promise.all([
    apiRequest<{
      settings: {
        primaryCurrency: string;
        tooltipCurrencies: string[];
      };
    }>({ url: '/api/settings' }),
    apiRequest<{
      assets: ChartAxisAsset[];
    }>({ url: '/api/watchlist/assets' })
  ]).then(([settingsPayload, watchlistPayload]) => ({
    currencies: configuredCurrencies({
      primaryCurrency: settingsPayload.settings.primaryCurrency,
      listedCurrencies: settingsPayload.settings.tooltipCurrencies
    }),
    denominationOptions: chartDenominationOptionsFromAssets(watchlistPayload.assets)
  })).catch((error) => {
    catalogRequest = null;
    throw error;
  });
  return catalogRequest;
};
