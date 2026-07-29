export const configuredCurrencies = ({
  primaryCurrency,
  listedCurrencies
}: {
  primaryCurrency: string;
  listedCurrencies: string[];
}) => [...new Set([
  primaryCurrency.toUpperCase(),
  ...listedCurrencies
    .map((currency) => currency.toUpperCase())
    .filter((currency) => /^[A-Z]{3}$/.test(currency))
])];
