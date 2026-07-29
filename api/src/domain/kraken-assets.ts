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
