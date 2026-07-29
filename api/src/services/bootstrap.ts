import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { createId } from '../utils/ids.js';

const builtInAssets = [
  {
    canonicalId: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    network: 'bitcoin',
    contractOrMint: null,
    mappings: {
      coingecko: { providerAssetId: 'bitcoin', providerSymbol: 'btc', pairId: 'bitcoin' },
      coinbase: { providerAssetId: 'BTC', providerSymbol: 'BTC', pairId: 'BTC-USD' },
      kraken: { providerAssetId: 'XXBT', providerSymbol: 'XBT', pairId: 'XXBTZCAD' }
    }
  },
  {
    canonicalId: 'ethereum',
    symbol: 'ETH',
    name: 'Ethereum',
    network: 'ethereum',
    contractOrMint: null,
    mappings: {
      coingecko: { providerAssetId: 'ethereum', providerSymbol: 'eth', pairId: 'ethereum' },
      coinbase: { providerAssetId: 'ETH', providerSymbol: 'ETH', pairId: 'ETH-USD' },
      kraken: { providerAssetId: 'XETH', providerSymbol: 'ETH', pairId: 'XETHZCAD' }
    }
  },
  {
    canonicalId: 'dogecoin',
    symbol: 'DOGE',
    name: 'Dogecoin',
    network: 'dogecoin',
    contractOrMint: null,
    mappings: {
      coingecko: { providerAssetId: 'dogecoin', providerSymbol: 'doge', pairId: 'dogecoin' },
      coinbase: { providerAssetId: 'DOGE', providerSymbol: 'DOGE', pairId: 'DOGE-USD' },
      kraken: { providerAssetId: 'XDG', providerSymbol: 'XDG', pairId: 'XDGCAD' }
    }
  },
  {
    canonicalId: 'polkadot',
    symbol: 'DOT',
    name: 'Polkadot',
    network: 'polkadot',
    contractOrMint: null,
    mappings: {
      coingecko: { providerAssetId: 'polkadot', providerSymbol: 'dot', pairId: 'polkadot' },
      coinbase: { providerAssetId: 'DOT', providerSymbol: 'DOT', pairId: 'DOT-USD' }
    }
  },
  {
    canonicalId: 'shiba-inu',
    symbol: 'SHIB',
    name: 'Shiba Inu',
    network: 'ethereum',
    contractOrMint: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    mappings: {
      coingecko: { providerAssetId: 'shiba-inu', providerSymbol: 'shib', pairId: 'shiba-inu' },
      coinbase: { providerAssetId: 'SHIB', providerSymbol: 'SHIB', pairId: 'SHIB-USD' }
    }
  },
  {
    canonicalId: 'solana',
    symbol: 'SOL',
    name: 'Solana',
    network: 'solana',
    contractOrMint: null,
    mappings: {
      coingecko: { providerAssetId: 'solana', providerSymbol: 'sol', pairId: 'solana' },
      coinbase: { providerAssetId: 'SOL', providerSymbol: 'SOL', pairId: 'SOL-USD' },
      kraken: { providerAssetId: 'SOL', providerSymbol: 'SOL', pairId: 'SOLCAD' }
    }
  }
] as const;

export const getBuiltInCatalog = () => builtInAssets.map((asset) => ({
  canonicalId: asset.canonicalId,
  symbol: asset.symbol,
  name: asset.name,
  network: asset.network,
  contractOrMint: asset.contractOrMint,
  ambiguousSymbol: false
}));

export const bootstrapApplicationData = async ({
  db,
  runtime
}: {
  db: AppDatabase;
  runtime: LoadedRuntime;
}) => {
  const now = Date.now();
  let user = await db.one<{ id: string }>({
    sql: 'SELECT id FROM app_user ORDER BY created_at_ms ASC LIMIT 1'
  });
  if (!user) {
    const id = createId({ prefix: 'usr' });
    await db.run({
      sql: `
        INSERT INTO app_user(id, username, password_hash, session_version, created_at_ms, updated_at_ms)
        VALUES (?, ?, NULL, 0, ?, ?)
      `,
      parameters: [id, runtime.config.auth.local.username.toLowerCase(), now, now]
    });
    user = { id };
  }

  for (const canonicalId of runtime.config.ui.defaultWatchedAssets) {
    const asset = builtInAssets.find((entry) => entry.canonicalId === canonicalId);
    if (!asset) continue;
    await db.run({
      sql: `
        INSERT INTO watched_assets(
          id, canonical_id, symbol, name, network, contract_or_mint, enabled, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(canonical_id) DO NOTHING
      `,
      parameters: [
        createId({ prefix: 'asset' }),
        asset.canonicalId,
        asset.symbol,
        asset.name,
        asset.network,
        asset.contractOrMint,
        now,
        now
      ]
    });
  }

  for (const asset of builtInAssets) {
    await db.run({
      sql: `
        INSERT INTO asset_catalog(
          canonical_id, symbol, name, network, contract_or_mint,
          market_cap_rank, source, metadata_json, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, NULL, 'built-in', '{}', ?)
        ON CONFLICT(canonical_id) DO UPDATE SET
          symbol = excluded.symbol,
          name = excluded.name,
          network = COALESCE(asset_catalog.network, excluded.network),
          contract_or_mint = COALESCE(asset_catalog.contract_or_mint, excluded.contract_or_mint),
          updated_at_ms = excluded.updated_at_ms
      `,
      parameters: [
        asset.canonicalId,
        asset.symbol,
        asset.name,
        asset.network,
        asset.contractOrMint,
        now
      ]
    });
    for (const [provider, mapping] of Object.entries(asset.mappings)) {
      await db.run({
        sql: `
          INSERT INTO asset_provider_mappings(
            id, canonical_asset_id, provider, provider_asset_id, provider_symbol, pair_id, metadata_json, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
          ON CONFLICT(canonical_asset_id, provider, provider_asset_id, pair_id)
          DO UPDATE SET provider_symbol = excluded.provider_symbol, updated_at_ms = excluded.updated_at_ms
        `,
        parameters: [
          createId({ prefix: 'map' }),
          asset.canonicalId,
          provider,
          mapping.providerAssetId,
          mapping.providerSymbol,
          mapping.pairId,
          now
        ]
      });
    }
    await db.run({
      sql: `
        UPDATE watched_assets
        SET symbol = ?, name = ?,
            network = COALESCE(network, ?),
            contract_or_mint = COALESCE(contract_or_mint, ?),
            updated_at_ms = ?
        WHERE canonical_id = ?
      `,
      parameters: [
        asset.symbol,
        asset.name,
        asset.network,
        asset.contractOrMint,
        now,
        asset.canonicalId
      ]
    });
  }

  for (const [canonicalAssetId, providerAssetId, pairId] of [
    ['dogecoin', 'XXDG', 'XXDGZCAD'],
    ['polkadot', 'DOT', 'DOTCAD'],
    ['shiba-inu', 'SHIB', 'SHIBCAD']
  ] as const) {
    await db.run({
      sql: `
        DELETE FROM asset_provider_mappings
        WHERE canonical_asset_id = ? AND provider = 'kraken'
          AND provider_asset_id = ? AND pair_id = ?
      `,
      parameters: [canonicalAssetId, providerAssetId, pairId]
    });
  }

  const currencies = runtime.config.ui.defaultTooltipCurrencies;
  for (let position = 0; position < currencies.length; position += 1) {
    await db.run({
      sql: `
        INSERT INTO selected_quote_currencies(user_id, currency, position, created_at_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, currency) DO UPDATE SET position = excluded.position
      `,
      parameters: [user.id, currencies[position]!, position, now]
    });
  }

  return { userId: user.id };
};
