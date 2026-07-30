import { configuredCurrencies } from '$lib/currencies';

export interface ChartDenominationOption {
  id: string;
  symbol: string;
  label: string;
}

export interface ChartAxisOption {
  value: string;
  label: string;
  group: 'Fiat currencies' | 'Crypto assets' | 'Display units';
  searchText: string;
}

export const buildChartAxisOptions = ({
  primaryCurrency,
  listedCurrencies,
  denominationOptions
}: {
  primaryCurrency: string;
  listedCurrencies: string[];
  denominationOptions: ChartDenominationOption[];
}): ChartAxisOption[] => {
  const primary = primaryCurrency.toUpperCase();
  const fiatOptions = configuredCurrencies({
    primaryCurrency: primary,
    listedCurrencies
  }).map((currency) => ({
    value: currency,
    label: currency === primary
      ? `${currency} · Primary currency`
      : `${currency} · Display currency`,
    group: 'Fiat currencies' as const,
    searchText: `${currency} fiat ${currency === primary ? 'primary' : 'display'} currency`
  }));
  const usedValues = new Set(fiatOptions.map((option) => option.value));
  const cryptoOptions = denominationOptions
    .filter((option) => {
      if (!option.id || usedValues.has(option.id)) return false;
      usedValues.add(option.id);
      return true;
    })
    .map((option) => ({
      value: option.id,
      label: option.label,
      group: 'Crypto assets' as const,
      searchText: `${option.symbol} ${option.label} ${option.id} crypto`
    }));
  return [...fiatOptions, ...cryptoOptions];
};

export const filterChartAxisOptions = ({
  options,
  query
}: {
  options: ChartAxisOption[];
  query: string;
}) => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((option) => {
    const searchable = `${option.label} ${option.value} ${option.group} ${option.searchText}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
};
