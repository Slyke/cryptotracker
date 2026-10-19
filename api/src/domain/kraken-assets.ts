import { Decimal } from 'decimal.js';

const krakenCanonicalIds: Record<string, string> = {
  BTC: 'bitcoin',
  XBT: 'bitcoin',
  XXBT: 'bitcoin',
  ETH: 'ethereum',
  XETH: 'ethereum',
  SOL: 'solana',
  DOT: 'polkadot',
  DOGE: 'dogecoin',
  XDG: 'dogecoin',
  XXDG: 'dogecoin',
  XRP: 'ripple',
  XXRP: 'ripple',
  SHIB: 'shiba-inu',
  BIO: 'bio-protocol',
  CLV: 'clover-finance',
  STRD: 'stride',
  CAD: 'cad',
  ZCAD: 'cad',
  AUD: 'aud',
  ZAUD: 'aud',
  USD: 'usd',
  ZUSD: 'usd',
  EUR: 'eur',
  ZEUR: 'eur',
  GBP: 'gbp',
  ZGBP: 'gbp',
  JPY: 'jpy',
  ZJPY: 'jpy',
  CHF: 'chf',
  ZCHF: 'chf'
};

export const krakenAssetSymbol = ({ raw }: { raw: string }) => (
  raw.toUpperCase()
    .replace(/\.(S|M|F|B)$/i, '')
    .replace(/\d+$/, '')
);

export const canonicalKrakenAsset = ({ raw }: { raw: string }) => {
  const symbol = krakenAssetSymbol({ raw });
  return krakenCanonicalIds[symbol] ?? symbol.toLowerCase();
};

export const krakenAssetCategory = ({ raw }: { raw: string }) => (
  /\.(S|B|M|F)$/i.test(raw)
    ? 'earn'
    : 'spot'
);

// Earn can also appear as suffixed Balance/BalanceEx entries. Only add the
// allocation amount not already represented by those entries, across strategies.
export const includeKrakenEarnBalances = ({
  balances,
  allocations
}: {
  balances: Record<string, string>;
  allocations: Array<{ assetRaw: string; quantity: string }>;
}) => {
  const result = { ...balances };
  const represented = new Map<string, Decimal>();
  const allocated = new Map<string, { assetRaw: string; quantity: Decimal }>();
  for (const [assetRaw, quantity] of Object.entries(balances)) {
    if (krakenAssetCategory({ raw: assetRaw }) !== 'earn') continue;
    const id = canonicalKrakenAsset({ raw: assetRaw });
    represented.set(id, (represented.get(id) ?? new Decimal(0)).plus(quantity));
  }
  for (const allocation of allocations) {
    const id = canonicalKrakenAsset({ raw: allocation.assetRaw });
    const previous = allocated.get(id);
    allocated.set(id, {
      assetRaw: previous?.assetRaw ?? `${krakenAssetSymbol({ raw: allocation.assetRaw })}.B`,
      quantity: (previous?.quantity ?? new Decimal(0)).plus(allocation.quantity)
    });
  }
  for (const [id, allocation] of allocated) {
    const missing = allocation.quantity.minus(represented.get(id) ?? 0);
    if (missing.greaterThan(0)) {
      result[allocation.assetRaw] = new Decimal(result[allocation.assetRaw] ?? 0)
        .plus(missing).toString();
    }
  }
  return result;
};
