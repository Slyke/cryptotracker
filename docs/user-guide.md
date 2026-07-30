# User guide

CryptoTracker is a single-tenant, read-only portfolio viewer. It reads public market data, public
blockchain addresses, and one query-only Kraken Spot account. It can change only its own settings,
cache, tracked-resource list, jobs, exports, and saved views. It cannot trade, withdraw, transfer,
stake, sign, or broadcast anything.

## Access and navigation

Open the HTTP application URL, `http://localhost:8192` by default. Local authentication presents a
username/password form. Trusted-header authentication can sign a permitted proxy identity in
automatically, and both modes may be enabled together. The header shows the application version and
build hash after authentication.

The primary pages are Dashboard, Markets, Addresses, Kraken, Calculations, and Settings. Sign out
invalidates a local session. There is no user-management, password-change, credential-editing, or
provider-secret screen.

## Dashboard

The Dashboard is the authenticated home page. Its summary cards show:

- known portfolio value, calculated as the sum of priced tracked-address and Kraken value;
- tracked-address value and provider-history completeness;
- Kraken known value and the percentage of non-zero balances that are priced;
- active, queued, and retrying synchronization-job count.

Unpriced balances are excluded from known-value subtotals rather than treated as zero. Focusing a
currency value opens a selectable popup containing the primary and configured display currencies.
Partial address history and unpriced holdings produce visible warnings.

Dashboard automatic refresh is off by default. It can be enabled at 30 seconds, 1, 2, 5, 10, or 30
minutes, or 1 hour. The enabled state and interval are saved in database-backed preferences. This
refresh reloads cached application data; it does not replace the independent provider polling
schedule configured in Settings.

Charts and tables saved from Markets, Addresses, or Kraken appear in named Dashboard rows. Each row:

- has a user-editable name;
- displays one to four items per row;
- accepts any mixture of saved charts and tables;
- can be added or removed; removing a row moves its items to the first remaining row;
- lets each item be moved to another row.

“Remove” on a saved item hides it without deleting its configuration. Settings can show it again or
delete it permanently. “Remove fluff” switches saved items to a compact presentation, and “Show
options” reveals row and placement controls. The Dashboard also summarizes enabled market assets,
the Kraken surfaces in use, and raw provider/cache health.

Dashboard, Markets, Addresses, Kraken, and Settings blocks have Up, Down, and expand/collapse
controls. Their order and collapsed state persist in the application database.

## Markets

Markets reads cached prices from CoinGecko, Coinbase Exchange, and Kraken. The source selector can
show one provider or Combined. Combined uses the median of available same-bucket observations, or a
clearly identified single-provider fallback. Coinbase USD observations may use a same-bucket
CoinGecko quote conversion for other display currencies; provenance remains visible.

The page contains:

- a combined tracked-address plus Kraken portfolio-history chart based on locally retained
  snapshots;
- a watched-price chart for up to ten selected enabled assets;
- price-return analytics for the currently loaded market series;
- a searchable top-100 CoinGecko catalog used to enable or disable assets.

BTC is the only enabled asset by default. Enabling an asset selects it on the chart and queues
supported initial history. Disabling it removes it from market charts and automatic market
synchronization and cancels its pending market jobs, but preserves shared cached history. Catalog
refresh queues a background job. “Queue backfill” requests the chosen range from the selected
provider, or each supported provider in Combined mode; unsupported provider/asset pairs are reported
as skipped.

Line mode can display multiple assets. Candlestick mode displays one selected asset and supports
optional wicks. Volume is available only where a single provider supplies meaningful volume;
Combined volume is intentionally unavailable because exchange volumes cannot be safely summed.

The catalog table can be filtered by symbol, name, rank, or canonical ID. Its searchable column
configurator saves the selected columns and their order. The configured table and either market
chart can be saved to the Dashboard under a unique name.

## Addresses

Addresses tracks public mainnet addresses only. The available network choices are derived from
enabled market assets and reviewed network mappings:

| Network | History provider | Credential behavior |
|---|---|---|
| Bitcoin | Blockstream Esplora | Keyless |
| Dogecoin | BlockCypher | Keyless at lower limits; token optional |
| Ethereum and selected ERC-20 tokens | Etherscan, with public RPC balance sampling | Etherscan key needed for transaction history |
| Polkadot | Subscan | Subscan key required |
| Solana and selected SPL tokens | Helius | Helius key required |

A network can be visible but disabled in the add form when its history provider is not configured.
CryptoTracker explicitly distinguishes “provider unavailable” from an empty, zero-balance history.
Kraken, Coinbase, and CoinGecko market integrations cannot supply arbitrary public-address history.

Adding an address requires a supported network, public address, and label. The network’s native asset
is always tracked. Ethereum and Solana can additionally track enabled known tokens or one explicitly
entered canonical asset plus contract/mint. The selected provider receives the public address.
Never enter a private key, seed phrase, xpub, or signing material.

Each tracked address can be enabled/disabled, refreshed, or deleted. Changing selected tokens resets
the provider cursor and queues a full read-only replay while retaining imported evidence. Deleting
requires confirmation and removes address-specific data; it does not remove shared market prices.

The page shows:

- provider completeness, oldest reconstructed point, latest successful check, and active-work state
  for each address;
- an address portfolio chart with individual series, a combined total, currencies, asset
  denominations, and address/transfer event markers;
- value-return analytics over the loaded address series;
- holdings grouped by address, including quantity, one or more currency values, price coverage,
  history state, and sync timestamps.

The holdings table has searchable, persisted column selection and can be saved to the Dashboard.
Unavailable balances and unpriced values are labelled with their reason rather than shown as zero.

## Kraken

Kraken is enabled only when both Spot API credentials are supplied. CryptoTracker uses an immutable
query-only endpoint allowlist. A suitable key has exactly:

- Query Funds;
- Query Open Orders & Trades;
- Query Closed Orders & Trades;
- Query Ledger Entries.

The integration does not need Deposit Funds, Withdraw Funds, Earn Funds, order creation/cancellation,
Export Data, WebSocket, or withdrawal-address permissions. When Kraken reports missing query
permissions or any write-capable permission, activation and manual refresh are refused and the page
shows exact allow/revoke guidance. When permission introspection is unavailable, the page says it is
unverified and the immutable endpoint allowlist remains the enforcement boundary.

The summary shows current known value, priced-balance count and percentage, current Earn/staked
value, lifetime provider-reported Earn reward quantities valued at current prices, connection state,
last successful check, and latest local snapshot. Unpriced balances are excluded from the known
subtotal.

Spot balances appear only when used. The configurable table can include balance, ACB-derived average
buy price, current price, 24-hour through four-year changes, unrealised return, wallet value in each
configured currency, pricing reason, snapshot time, and raw Kraken asset. Rows have a persisted
Up/Down order. Market-derived fields require the canonical asset to be enabled in Markets.

Earn/staking includes:

- selected per-asset history reconstructed from imported immutable ledger entries before exact local
  observations, then superseded by exact snapshots;
- locally observed estimated-APY history, which begins at the first local strategy-rate
  observation because Kraken supplies no rate-history endpoint;
- current allocation, reward, payout-distribution, state, APY, and multi-currency value columns;
- searchable, type-filtered activity in pages of 25, with CSV/JSON export and raw evidence;
- a raw-allocation inspection disclosure.

Margin appears only when provider-reported positions exist. Futures is deliberately unsupported.

The portfolio chart provides a persisted total toggle and one toggle per held canonical asset.
Series without priced snapshots, or whose assets are disabled in Markets, remain visible as
unavailable controls. The popup normally excludes disabled/inactive quantities and can explicitly
show them. The page also provides value-return analytics, ACB/FIFO/LIFO realised-gain estimates and
basis coverage, plus raw imported trades and ledger entries. These values are portfolio estimates,
not tax calculations, and unknown basis is never assumed to be zero.

“Manual refresh” queues a background import; it does not perform an exchange-side mutation. Balance
and Earn tables and the portfolio chart can be saved to the Dashboard.

## Calculations

Calculations is a local what-if compound-growth tool. A scenario contains:

- unique name and start date;
- three-letter display currency;
- starting balance;
- annual rate entered as effective APY or nominal APR;
- yearly, monthly, weekly, or daily compounding and end-of-period contribution frequency;
- duration in days, months, or years;
- recurring contribution;
- optional target amount.

The result shows ending balance, total contributed, projected earnings, complete contribution-period
count, and the contribution per period required to reach the target. Its chart compares projected
balance with total contributed. Saved scenarios are stored in user settings, can be loaded, updated
under the same ID, or deleted after confirmation, and are included in application backups.

The projection assumes a constant rate and contributions at the end of each complete compounding
period. It does not model taxes, fees, inflation, changing rates, or market volatility, and it never
places an order.

## Performance analytics

Markets, Addresses, and Kraken provide client-side analytics over the series currently loaded on
that page:

- cumulative return from the first non-zero observation;
- annualized return when both endpoints are positive and span at least one day;
- sample annualized volatility using the median observation interval;
- maximum drawdown from the preceding peak;
- total-return difference from an optional selected benchmark;
- valued observation count.

The graph switches between cumulative return and drawdown. Market analytics describe price return.
Address and Kraken analytics use observed portfolio value, so deposits and withdrawals are not
removed; they are not cash-flow-adjusted or time-weighted returns.

## Shared chart controls

Full charts provide:

- 24-hour, 7-day, 30-day, 90-day, 1-year, optional 4-year, all-available, and custom ranges;
- custom start/end values in the configured timezone or a rolling lookback in hours, days, weeks,
  months, or years;
- automatic or explicit 5-minute, 15-minute, 30-minute, 1-hour, 4-hour, daily, or weekly
  granularity, with overly dense combinations disabled;
- line/candlestick mode where applicable;
- linear/logarithmic scale and a searchable Y-axis unit chosen from configured currencies and
  available crypto denominations;
- independent automatic, absolute, or percentage-padded minimum and maximum;
- normalization to 0%, candlestick wicks, volume, and event toggles where applicable;
- wheel/gesture pan and zoom after the plot is clicked or focused, drag zoom, and Reset zoom;
- a stable hover/crosshair popup, click-to-pin details, selectable series, and partial/stale/derived/
  disputed metadata;
- a plotted-data table with status, providers, coverage, and evidence;
- searchable event evidence in pages of 25;
- a keyboard inspector: activate it, use Left/Right, Home/End, and Escape;
- PNG/SVG snapshots and CSV/JSON data export;
- unique-name Dashboard saving on supported source charts.

Compact Dashboard and calculation charts intentionally omit the full configuration toolbar.

## Settings and diagnostics

Preferences include locale, IANA timezone, dark/light theme, font, content width, primary currency,
up to five display currencies, default market source, provider-disagreement threshold, default
Kraken cost-basis method, dismissed-message restoration, independent automatic polling intervals,
historical retention, and failed-job retention.

Provider polling can be set from five minutes to one week for CoinGecko, Coinbase, Kraken public
market data, tracked addresses, the Kraken account/Earn state, and the catalog. Changes take effect
on the next scheduler check. Dashboard refresh is a separate display preference.

Synchronization refreshes every three seconds and shows:

- searchable, type-filtered failed jobs with 10/20/50/100-row pagination;
- active/queued/retrying work, progress, requested range, processed range, and possibly-stalled
  state after ten minutes without an update;
- searchable market coverage filtered by provider or completeness;
- Kraken endpoint import coverage.

Storage diagnostics show database kind, estimated bytes, total rows, category/table counts, retained
ranges, and the active point-retention policy. Provider diagnostics expose enablement, contribution,
cooldown, and Kraken-safety state.

Saved Dashboard items can be renamed, shown/hidden, or permanently deleted. Row placement is managed
on the Dashboard.

## Retention, backup, and restore

Historical retention defaults to Forever. A finite whole-day window requires confirmation and
removes only old market points, derived address balance points, and Kraken/combined portfolio
snapshots. A separate optional policy removes terminal failed-job records. Transactions, address
events, Kraken trades/ledgers, transfer matches, and cost-basis records remain retained.

Settings creates an asynchronous streaming ZIP backup and polls until it is downloadable or failed.
The archive contains dependency-safe Preferences, Markets, Addresses, Kraken, Portfolio, and
Calculations groups that are present in the database. Saved what-if scenarios are part of
Preferences; the Calculations group contains transfer reconciliation and cost-basis evidence. The
archive excludes credentials, password hashes, sessions, CSRF material, jobs, audit logs, and
generated artifacts.

Uploading a ZIP first performs inspection and shows its version, creation time, groups, files, and
row counts. Restore is atomic and replaces every current row in each selected group. It requires at
least one selected group and an explicit replacement acknowledgement. Create a fresh backup before
restoring. This portable archive is not a transaction-consistent replacement for SQLite/PostgreSQL
operator backup and disaster recovery.
