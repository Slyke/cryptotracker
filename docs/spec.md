# CryptoTracker Specification

- Status: Draft approved for implementation planning
- Version: 0.2
- Date: 2026-07-28

## 1. Summary

CryptoTracker is a self-hosted, single-tenant portfolio viewer for cryptocurrency market data, public blockchain addresses, and one Kraken account.

The product is strictly read-only with respect to exchanges and blockchains. It may write application-owned configuration, cached market data, synchronization state, imported read-only account history, and user preferences to its own database. It must never place trades, transfer funds, withdraw assets, modify exchange settings, sign blockchain transactions, or broadcast transactions.

The application has three primary product areas:

1. Markets
   - Watch user-selected crypto assets, with BTC watched by default.
   - Retrieve historical market prices from CoinGecko, Coinbase, and Kraken.
   - Let the user select an individual provider or a combined price source.
   - Display multiple watched assets as interactive price lines.
   - Display a single focused asset as OHLC candlesticks with optional wicks.
   - Show a crosshair tooltip containing all visible asset values in up to five selected quote currencies.
2. Addresses
   - Track user-added Bitcoin, Ethereum, and Solana addresses.
   - Track only the native assets and tokens the user selects.
   - Reconstruct history from the first transaction when the configured provider makes that history available.
   - Show each enabled address separately and show a combined line.
   - Allow addresses and assets to be enabled or disabled without deleting them.
3. Kraken
   - Read one Kraken account using read-only credentials.
   - Cover spot balances and activity, Earn/staking, and margin data when the account uses those features.
   - Do not support Kraken Futures in the initial scope.
   - Reconstruct historical portfolio activity where possible and maintain 30-minute snapshots.
   - Present informational realised and unrealised gain/loss estimates with configurable cost-basis methods.

Every time-series graph must share a common interaction contract:

- custom and preset date ranges
- selectable granularity
- linear and logarithmic scale where mathematically valid
- automatic, absolute, or relative minimum and maximum bounds
- pan, zoom, hover, crosshair, and series toggles
- CSV and JSON data export
- PNG and SVG graph snapshot export
- a functional keyboard inspector with visible operating instructions
- a named saved-graph action for placing the configuration on the Dashboard
- separated title, legend, metadata, control, and plotting regions that never overlap

The default user context is:

- locale: `en-CA`
- timezone: `America/Vancouver`
- primary quote currency: `CAD`
- default watched asset: BTC
- default theme: dark
- default market price source: Combined
- default Kraken cost-basis method: weighted-average cost basis

This is a portfolio viewer, not tax preparation or accounting software. Gain/loss calculations must be described as estimates.

## 2. Product Intent

CryptoTracker should provide the useful viewing and comparison parts of products such as Ledger Live and Kraken without becoming a wallet, exchange, or trading terminal.

The application should:

- make long-running portfolio history inspectable
- be honest about missing, partial, derived, or stale data
- minimize upstream API traffic through persistent caching and incremental synchronization
- work with free API access and conservative rate limiting
- remain useful when one upstream provider is degraded or lacks a particular data point
- make the source and quality of every derived value discoverable
- support a typical personal account rather than transaction-heavy institutional accounts
- keep deployment and operation simple for one application replica

The first authenticated screen must be a useful application dashboard, not a marketing landing page.

## 3. Explicitly Out Of Scope

The following are out of scope unless a later specification adds them:

- placing, editing, or cancelling trades
- deposits, withdrawals, transfers, or wallet signing
- broadcasting blockchain transactions
- exchange account-setting changes
- Kraken Futures
- more than one Kraken account
- multiple application tenants
- application roles or permissions
- manual transaction, lot, or cost-basis imports
- CSV import from exchanges
- tax filing, tax advice, or tax-report generation
- guaranteed complete history when a free upstream provider cannot supply it
- high-frequency or real-time trading data
- minute-by-minute live portfolio monitoring
- Bitcoin xpub, descriptor, or wallet discovery
- arbitrary blockchain support without a dedicated adapter
- Redis
- horizontal application scaling
- automated backup scheduling or restore workflows
- application-driven SQLite-to-Postgres data migration
- importing authentication secrets, sessions, operational jobs, or audit history from an application backup

## 4. Architecture

### 4.1 High-Level Runtime Shape

The repository is a Node.js and SvelteKit monolith with separate runtime directories and two processes.

The production container runs:

1. API and ingress process
   - Node.js + TypeScript
   - owns authentication, authorization, CSRF, configuration, database access, background jobs, provider integrations, exports, health endpoints, and the HTTP API
   - is externally reachable on independently configurable HTTP and HTTPS listeners
   - proxies non-API application traffic to the internal SvelteKit process
2. WUI process
   - SvelteKit using `@sveltejs/adapter-node`
   - owns application pages, layouts, components, graph rendering, and browser interactivity
   - listens only on an internal loopback or container-local port
   - is never exposed directly by Docker, Compose, Kubernetes, or a reverse proxy
3. MCP sidecar process
   - runs from the standalone `mcp/` subproject
   - authenticates MCP clients with named Bearer API keys
   - calls the API with a separate dedicated upstream API key
   - supports independently configurable HTTP and HTTPS MCP listeners
   - may be disabled without changing API/WUI availability

Default ports:

- API/ingress: `8192`
- API HTTPS ingress: `8194`
- MCP HTTPS ingress: `8193`
- MCP HTTP ingress: `8195` (disabled by default)
- internal SvelteKit WUI: `3000`

Ports `8192` and `8194` belong to the application container. Ports `8193` and `8195` belong to the MCP sidecar. The sidecar defaults to HTTPS but may enable HTTP for trusted local or sidecar deployments. Its upstream base URL may select either API transport.

The API ingress must proxy:

- ordinary HTTP requests
- streamed responses
- WebSocket upgrades if the WUI later needs them
- query strings
- cookies needed by the application
- correlation IDs

The proxy must:

- use a startup-configured internal WUI origin
- never accept an upstream target from request input
- filter hop-by-hop headers
- preserve response status and safe response headers
- avoid response buffering by default
- remove stale `content-encoding` when the Node runtime has already decoded a body
- return a controlled `502` application error if the WUI process is unavailable

### 4.2 Process Supervision

The image must include a small root launcher that starts the API and WUI processes.

The launcher must:

- forward `SIGTERM` and `SIGINT` to both child processes
- wait for graceful shutdown
- exit non-zero if either required child exits unexpectedly
- terminate the remaining child if one child fails
- avoid zombie processes
- work correctly under a minimal init such as `tini`

The container is considered ready only when:

- the API process is accepting requests
- the database is initialized
- required configuration is valid
- the internal WUI health endpoint succeeds

### 4.3 Repository Layout

The initial repository layout should be:

```text
./
  api/
    src/
    test/
    package.json
    tsconfig.json
  wui/
    src/
    static/
    tests/
    package.json
    svelte.config.js
    vite.config.ts
    tsconfig.json
  runtime/
    launcher.mjs
  config/
    examples/
  dockerfiles/
    cryptotracker.Dockerfile
    cryptotracker.dev.Dockerfile
  docs/
    spec.md
  scripts/
    write-build-info.mjs
  package.json
  package-lock.json
  docker-compose.yml
  docker-compose.dev.yml
```

The root package is an npm workspace containing `./api` and `./wui`.

### 4.4 Recommended Implementation Baseline

- Node.js 24, pinned to a specific image patch version during implementation
- TypeScript for API and WUI code
- SvelteKit 2 with Svelte 5 and the Node adapter
- Express for the API/ingress and proxy runtime
- Zod for startup configuration and API input validation
- Drizzle ORM or a similarly typed database layer with explicit SQLite and Postgres migrations
- `better-sqlite3` for SQLite
- `pg` for Postgres
- Argon2id for the local password hash
- Apache ECharts for interactive line and candlestick charts
- JSON5 for human-authored configuration and secrets files

Package versions must be pinned by the lockfile. Implementation must not depend on unpinned CDN scripts.

## 5. Source Of Truth Rules

- The application database is authoritative for:
  - watched assets
  - selected quote currencies
  - tracked addresses
  - enabled/disabled state
  - user preferences
  - synchronization cursors and jobs
  - cached market history
  - imported Kraken history and snapshots
  - derived portfolio series
- The config JSON5 file is authoritative for:
  - deployment wiring
  - auth mode enablement
  - trusted proxies
  - header names and access allowlists
  - provider endpoints
  - non-secret provider policy
  - instance defaults
  - logging policy
- The secrets JSON5 file or explicit secret environment variables are authoritative for:
  - session secrets
  - local login password
  - Kraken credentials
  - optional free-tier provider API keys
  - optional signed identity verification secrets
- Upstream market providers are authoritative for the raw observations attributed to them.
- Blockchain providers are authoritative for the transactions and chain state they return.
- Kraken is authoritative for Kraken balances, ledger entries, trades, positions, and Earn allocations.
- Derived and combined values must never overwrite or masquerade as a raw upstream value.

## 6. Configuration

### 6.1 Runtime Files

The application loads exactly two optional JSON5 files at startup:

- config file
- secrets file

Recommended environment variables:

```env
CRYPTOTRACKER_CONFIG_PATH=/app/config/cryptotracker.config.json5
CRYPTOTRACKER_SECRETS_PATH=/app/config/cryptotracker.secrets.json5
CRYPTOTRACKER_DB_KIND=sqlite
CRYPTOTRACKER_SQLITE_PATH=/app/data/cryptotracker.sqlite
```

The config and secrets files are read-only bootstrap inputs. Changes require a process restart.

The application must fail startup with a structured error when:

- a configured file cannot be read
- JSON5 parsing fails
- schema validation fails
- an enabled integration lacks required configuration
- Postgres mode lacks complete Postgres configuration
- local auth lacks a local password
- header auth lacks trusted proxies or an allow rule
- signed identity verification is enabled without its verification secret, issuer, or audience

### 6.2 Configuration Precedence

Precedence from lowest to highest:

1. built-in defaults
2. config JSON5
3. documented non-secret environment overrides
4. database-backed user preferences
5. URL state for the current graph or page

Secrets precedence:

1. secrets JSON5
2. explicit secret environment variable

There must not be a generic rule that maps every environment variable into arbitrary nested configuration. Environment overrides must be explicit, documented, validated, and tested.

### 6.3 Example Config Shape

```json5
{
  appName: 'CryptoTracker',
  publicBaseUrl: 'https://crypto.example.ca',
  api: {
    host: '0.0.0.0',
    port: 8192,
    trustProxy: true,
    https: {
      enabled: true,
      port: 8194,
    },
  },
  wui: {
    upstreamBaseUrl: 'http://127.0.0.1:3000',
  },
  ui: {
    locale: 'en-CA',
    timezone: 'America/Vancouver',
    defaultTheme: 'dark',
    defaultFont: 'ui-mono',
    defaultPrimaryCurrency: 'CAD',
    defaultTooltipCurrencies: ['CAD'],
    defaultMarketSource: 'combined',
    defaultProviderDisagreementThresholdPercent: 5,
    defaultWatchedAssets: ['bitcoin'],
    defaultCostBasisMethod: 'acb',
  },
  auth: {
    local: {
      enabled: true,
      username: 'admin',
      sessionTtlMinutes: 1440,
    },
    header: {
      enabled: false,
      trustedCidrs: ['127.0.0.1/32'],
      usernameHeader: 'Remote-User',
      groupsHeader: 'Remote-Groups',
      groupsSeparator: ',',
      allowedUsers: [],
      allowedGroups: [],
      signedIdentity: {
        enabled: false,
        headerName: 'X-Oauth-Identity',
        issuer: 'https://oauth.example.ca',
        audience: 'cryptotracker',
        clockSkewSeconds: 30,
        maxTokenTtlSeconds: 31536000,
      },
    },
  },
  database: {
    postgres: null,
  },
  providers: {
    market: {
      coinGecko: {
        enabled: true,
        baseUrl: 'https://api.coingecko.com/api/v3',
      },
      coinbase: {
        enabled: true,
        baseUrl: 'https://api.coinbase.com',
      },
      kraken: {
        enabled: true,
        baseUrl: 'https://api.kraken.com',
      },
    },
    chains: {
      bitcoin: {
        enabled: true,
        provider: 'esplora',
        baseUrl: 'https://blockstream.info/api',
      },
      ethereum: {
        enabled: true,
        provider: 'etherscan',
        chainId: 1,
      },
      solana: {
        enabled: true,
        provider: 'helius',
        cluster: 'mainnet-beta',
      },
    },
  },
  sync: {
    pollMinutes: 30,
    maxConcurrentJobs: 2,
  },
  logging: {
    // Styleguide-compatible sink and gate configuration.
  },
}
```

### 6.4 Example Secrets Shape

```json5
{
  sessionSecret: 'replace-with-a-long-random-secret',
  localPassword: 'replace-with-a-strong-password',
  signedIdentitySecret: null,
  providers: {
    coinGeckoApiKey: null,
    etherscanApiKey: null,
    heliusApiKey: null,
  },
  kraken: {
    apiKey: null,
    apiSecret: null,
  },
  postgresPassword: null,
}
```

Equivalent explicit environment overrides should be available for each secret.

Secrets must never:

- be returned through an API
- be included in a client bundle
- be written to logs
- be written to the database
- be included in health responses
- appear in exported graph metadata

### 6.5 Documented Environment Overrides

At minimum, the implementation should support these explicit environment overrides:

```env
# Runtime and database
CRYPTOTRACKER_CONFIG_PATH=
CRYPTOTRACKER_SECRETS_PATH=
CRYPTOTRACKER_DB_KIND=sqlite
CRYPTOTRACKER_SQLITE_PATH=
CRYPTOTRACKER_POSTGRES_PASSWORD=

# Public runtime
CRYPTOTRACKER_PUBLIC_BASE_URL=
CRYPTOTRACKER_API_HOST=
CRYPTOTRACKER_API_PORT=
CRYPTOTRACKER_WUI_UPSTREAM_BASE_URL=

# Local authentication
CRYPTOTRACKER_AUTH_LOCAL_ENABLED=
CRYPTOTRACKER_AUTH_LOCAL_USERNAME=
CRYPTOTRACKER_AUTH_LOCAL_PASSWORD=
CRYPTOTRACKER_SESSION_SECRET=

# Trusted-header authentication
CRYPTOTRACKER_AUTH_HEADER_ENABLED=
CRYPTOTRACKER_AUTH_HEADER_TRUSTED_CIDRS=
CRYPTOTRACKER_AUTH_HEADER_USERNAME_HEADER=
CRYPTOTRACKER_AUTH_HEADER_GROUPS_HEADER=
CRYPTOTRACKER_AUTH_HEADER_GROUPS_SEPARATOR=
CRYPTOTRACKER_AUTH_HEADER_ALLOWED_USERS=
CRYPTOTRACKER_AUTH_HEADER_ALLOWED_GROUPS=

# Optional oauth-wrapper signed identity verification
CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ENABLED=
CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_HEADER=
CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_SECRET=
CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ISSUER=
CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_AUDIENCE=

# Market and chain providers
CRYPTOTRACKER_COINGECKO_API_KEY=
CRYPTOTRACKER_ETHERSCAN_API_KEY=
CRYPTOTRACKER_HELIUS_API_KEY=

# Kraken
CRYPTOTRACKER_KRAKEN_API_KEY=
CRYPTOTRACKER_KRAKEN_API_SECRET=

# Instance defaults
CRYPTOTRACKER_DEFAULT_LOCALE=en-CA
CRYPTOTRACKER_DEFAULT_TIMEZONE=America/Vancouver
CRYPTOTRACKER_DEFAULT_PRIMARY_CURRENCY=CAD
CRYPTOTRACKER_DEFAULT_MARKET_SOURCE=combined
```

Array environment variables use comma-separated exact values with surrounding whitespace removed. JSON5 arrays should be used when a value itself needs punctuation that would make the environment representation ambiguous.

Boolean environment variables accept documented case-insensitive forms such as `true`, `false`, `1`, and `0`; invalid values fail startup rather than silently choosing a default.

Secret-valued environment variables override only the corresponding secrets-file field. They must not be copied into the normalized non-secret configuration object used by the WUI.

## 7. Database Support

### 7.1 Required Modes

- SQLite
- Postgres

SQLite is the default and recommended mode for a normal single-replica installation.

SQLite requirements:

- WAL journal mode
- foreign keys enabled
- a configured busy timeout
- synchronous mode appropriate for durable application state
- database and WAL files stored on a persistent volume

Postgres requirements:

- connection details in config JSON5
- password in secrets JSON5 or an explicit environment variable
- connection pool with bounded size
- optional TLS

Redis must not be required or included in the initial architecture.

### 7.2 Migration Rules

- Migrations are versioned and checked into the repository.
- Migrations run before readiness.
- A migration failure prevents readiness.
- SQLite and Postgres must have equivalent logical schemas.
- Destructive migrations require a documented backup and migration path.
- Application startup must be idempotent.

### 7.3 Numeric And Time Storage

- Crypto quantities and prices must not be stored as JavaScript floating-point numbers.
- Provider decimal values should be retained as decimal strings or exact database numerics behind one decimal abstraction.
- Arithmetic must use a decimal library.
- Time-series bucket keys use UTC epoch milliseconds.
- API timestamps use ISO 8601 UTC strings unless a compact numeric series format is explicitly documented.
- The UI converts timestamps to `America/Vancouver` by default.

### 7.4 Core Logical Tables

The initial schema should include equivalents of:

- `schema_migrations`
- `app_user`
- `sessions`
- `user_settings`
- `watched_assets`
- `selected_quote_currencies`
- `asset_provider_mappings`
- `asset_lifecycle_events`
- `market_points`
- `market_sync_cursors`
- `tracked_addresses`
- `address_asset_selections`
- `address_sync_state`
- `chain_transactions`
- `address_balance_events`
- `address_balance_points`
- `kraken_trades`
- `kraken_ledgers`
- `kraken_snapshots`
- `kraken_snapshot_balances`
- `kraken_margin_positions`
- `kraken_earn_allocations`
- `kraken_earn_strategy_rates`
- `kraken_account_observations`
- `kraken_sync_cursors`
- `internal_transfer_matches`
- `cost_basis_lots`
- `calculation_runs`
- `application_exports`
- `jobs`
- `audit_log`

`market_points` must distinguish:

- provider
- canonical asset
- quote currency
- bucket start
- granularity
- open
- high
- low
- close or point price
- volume when meaningful
- native versus derived data
- sample count
- finalized versus current bucket
- retrieval time
- provider provenance

Raw provider data and derived data must have separate uniqueness keys or an explicit `data_kind`.

## 8. Background Work And Rate Limiting

### 8.1 Job Model

The application runs one in-process scheduler backed by the database.

Jobs must:

- be persisted before execution
- have a stable idempotency key
- survive application restart
- resume or retry after an interrupted process
- record progress, current cursor, attempt count, next retry time, and last structured error
- coalesce duplicate refresh requests
- prevent concurrent synchronization of the same resource
- expose status to the UI

Settings must expose live synchronization progress, including provider, asset or endpoint, state, requested start and end, progress current/total and percentage where available, oldest stored point reached, newest stored point, cursor activity, last successful check, and structured failure details. A partial-data flag is not evidence that work is currently active; the UI must distinguish cached gaps from queued, running, retrying, stalled, and failed jobs.

Historical backfill progress must answer “how far back has it gone?” directly. For each provider/asset/currency/granularity or Kraken endpoint, the UI shows the requested start separately from the oldest point currently stored.

Job priorities:

1. current user-requested data needed for a visible page
2. manual refresh
3. incremental scheduled synchronization
4. initial or historical backfill
5. repair and low-priority metadata refresh

Historical jobs must make steady progress without starving current-data requests.

### 8.2 Provider Rate Control

Each provider adapter has an independent limiter.

The limiter must support:

- configurable minimum request spacing
- bounded concurrency
- token-bucket or equivalent burst control
- `Retry-After`
- exponential backoff with jitter
- cooldown after repeated `429` or upstream failures
- request coalescing
- batch endpoints when the provider supports them
- a circuit-breaker/degraded state
- conservative unauthenticated/keyless defaults

Provider rate-limit settings must be configurable because free-tier limits can change.

Every upstream response, including failures, may consume provider quota. Retries must therefore be deliberate and bounded.

### 8.3 Persistent Caching

The database is the primary cache.

Rules:

- Finalized historical buckets are not fetched repeatedly during normal viewing.
- Current or not-yet-finalized buckets may be refreshed.
- Incremental requests overlap a small recent window to repair late or revised data.
- Inserts use deterministic unique keys and upserts.
- A range request first returns cached data and queues only missing intervals.
- A user can explicitly request repair of a range.
- Provider metadata and asset catalogs have longer configurable refresh intervals.
- Shared market data remains cached when a watched asset is removed, but automatic refresh stops.

Automatic polling is configured independently in Settings for CoinGecko market data, Coinbase market data, Kraken public market data, the asset catalog, tracked addresses, and the private Kraken account. The hard minimum is five minutes. Conservative defaults are five minutes for the private Kraken account and Earn state, 15 minutes for Coinbase and Kraken public markets, 30 minutes for CoinGecko and addresses, and one day for the asset catalog. A single market poll may retrieve all upstream 5-minute candles created since the prior poll; current-only account and Earn surfaces are polled every five minutes because missed observations cannot be recovered from upstream history.

For every enabled market asset, initial synchronization targets progressively deeper cached history: 90 days at one-hour granularity, two years at daily granularity, and five years at weekly granularity. Each adapter caps those targets to the upstream plan and endpoint limits; Combined history uses deeper providers without repeatedly requesting a range another provider cannot supply. Historical work is admitted in bounded batches on later scheduler cycles so current data and free-provider quotas are not overwhelmed. A provider response containing one observation in a requested bucket is retained as an honest one-sample derived OHLC bucket rather than discarded.

The selected chart rendering mode does not change synchronization. Line and Candlestick are views over the same cached points; Queue backfill requests missing provider history for the selected asset, currency, range, and granularity.

### 8.4 Retention

The default historical-data retention setting is `Forever`.

The user may set a maximum age, in whole days, for high-volume historical cache and snapshot data. Changing from `Forever` to a finite window requires an explicit destructive confirmation. The selected setting is stored in the database.

Automatic finite-window pruning is limited to:

- market points
- derived address balance points
- Kraken portfolio snapshots

Automatic retention must not prune transactions, address balance events, Kraken trades or ledgers, cost-basis lots, calculation records, lifecycle mappings, or other activity needed to reconstruct balances and calculations. There is no destructive downsampling. Coarser aggregates may be materialized for performance while their retained source window remains available.

Disabling a series or removing an asset from the watchlist does not delete shared cached history. Removing an address follows its explicit resource-deletion behavior.

Temporary HTTP response bodies, expired sessions, and generated export archives may use bounded retention because they are not canonical portfolio history.

Settings must show the current retention selection, storage use by major data category, and oldest/newest retained records. It does not show a generic alarming indefinite-retention warning when `Forever` is selected.

## 9. Market Data

### 9.1 Providers

Initial market providers:

- CoinGecko
- Coinbase
- Kraken

All must use read-only public market endpoints. Optional free-tier API keys may improve quota, but no paid plan may be required for the application to start.

The application must communicate free-tier limitations clearly:

- lower reliability
- dynamic or limited quotas
- provider-specific historical depth
- provider-specific granularity
- missing pairs
- slower initial backfill

### 9.2 Asset Catalog

The user explicitly enables assets from the catalog.

- BTC is the only asset enabled on first run. Every other catalog asset is disabled by default.
- No large default catalog is placed on the dashboard.
- A persisted provider-backed catalog contains at least the current top 100 assets by market capitalization when CoinGecko is available.
- The catalog is refreshed as a persistent background job and retains its last successful snapshot through provider outages.
- One search field filters the catalog table by symbol, name, canonical ID, or rank; there is no duplicate enable-asset picker.
- Catalog rows provide the only Enable/Disable controls. There are no ranked bulk-enable controls.
- When BTC is the only enabled asset, applicable pages link directly to the catalog filter.
- Enabling an asset selects it on the chart, changes candlestick mode to line mode when necessary, and immediately queues supported initial history.
- Each catalog row includes rank and catalog source when known.
- Canonical identity must use provider IDs and contract/mint identity, not symbol alone.
- Ambiguous symbols require user confirmation.
- Provider-specific symbols and pair IDs map to one canonical asset.
- Delisted or unavailable assets remain viewable when cached history exists.

A provider/asset pair without a mapping is skipped and reported rather than queued as a job that is guaranteed to fail. In Combined mode, every supported provider contributes and unsupported pairs remain explicit. Automatic market synchronization, backfill, cursor progress, and market-job diagnostics include enabled watchlist assets only. Disabling an asset cancels its queued or retrying market jobs and prevents new market work; cached history is retained.

### 9.3 Source Selection

Every market graph supports:

- CoinGecko
- Coinbase
- Kraken
- Combined

The selected source is part of graph state and export metadata.

Individual provider mode:

- shows only values attributable to that provider
- leaves honest gaps when the provider has no data
- does not silently replace missing values with a different provider

Combined mode:

1. Normalize provider observations into the requested UTC buckets.
2. Prefer native values over derived values when determining the available set.
3. When two or more providers have a value, use the median.
4. When exactly one provider has a value, use it as the fallback.
5. When no provider has a value, leave a gap.
6. Store or return the provider list and native/derived state for every combined point.
7. Never forward-fill a market gap by default.

For every bucket with two or more providers, calculate the relative provider spread as `(maximum - minimum) / median`. A zero median uses an explicit absolute-spread fallback instead of division by zero. The large-disagreement threshold is configurable and defaults to 5%.

When the threshold is exceeded:

- retain the normal median result rather than silently switching providers
- mark the point or candle as disputed
- retain every contributing provider value, the calculated spread, and the threshold
- show an inspectable warning marker in the graph and tooltip
- include the disputed state and contributing values in data exports
- do not automatically reject, repair, or privilege one provider in the initial version

A combined candle is disputed when any available OHLC component exceeds the configured threshold. Provider health and missing-data states remain separate from disagreement state.

For a combined line point, the value is the median of available close or point prices.

For a combined candle:

- open, high, low, and close are independently calculated from available provider candles using the median
- the resulting high must be at least the greater of open and close
- the resulting low must be at most the lesser of open and close
- provider provenance applies to the whole candle and may also be retained per component
- combined volume is omitted unless a later design defines a meaningful non-duplicating aggregation

### 9.4 Native And Derived Candles

Market graphs support:

- simple line
- OHLC candlestick

Line mode:

- supports multiple visible crypto assets
- uses close or point price
- is the default chart mode

Candlestick mode:

- focuses on one active crypto asset
- uses standard open/close bodies
- supports visible or hidden high/low wicks
- may show other selected assets as optional close-only comparison lines
- displays OHLC values in the crosshair details

Native candles are used when the provider returns OHLC.

Derived candles may be built from sufficiently dense cached point observations:

- open: first sample in the bucket
- high: highest sample in the bucket
- low: lowest sample in the bucket
- close: last sample in the bucket
- sample count is retained
- the UI labels the candle as derived

The application must not invent a wick or a high/low range from one point. When there are insufficient samples and no native OHLC, candlestick mode is unavailable for that source, asset, range, or granularity, with an explanatory message.

An optional volume subplot is available when the selected provider supplies meaningful volume for the active pair and buckets. It shares the time axis and crosshair with the main plot. Native and derived volume must be labeled. Combined volume remains unavailable until a non-duplicating aggregation is defined; the UI must explain that limitation instead of summing exchange volume.

### 9.5 Granularity

Supported user-facing granularities:

- Auto
- 5 minutes
- 15 minutes
- 30 minutes
- 1 hour
- 4 hours
- 1 day
- 1 week

Rules:

- Finer cached data may be aggregated into a coarser bucket.
- Coarse data must never be expanded into fabricated fine data.
- The UI disables unavailable granularities or marks them partial.
- Auto chooses a resolution that keeps the rendered point count reasonable.
- Exports use the explicitly selected or Auto-resolved granularity.
- The resolved granularity is always visible and included in export metadata.

Recommended Auto targets:

- up to 48 hours: 5 or 15 minutes when available
- up to 14 days: 30 minutes
- up to 90 days: 1 or 4 hours
- up to 2 years: 1 day
- longer ranges: 1 week

The API may downsample for display while preserving the ability to export the requested cached granularity.

### 9.6 Quote Currencies

- The primary quote currency controls plotted line and candle values.
- The default primary currency is CAD.
- The user may select up to five tooltip quote currencies.
- The primary currency counts toward the maximum of five when it is selected for the tooltip.
- Quote currency preferences persist in the database.

At the active crosshair timestamp, the tooltip must show a grouped matrix:

- one row or group per visible crypto asset
- one value per selected quote currency
- source and derived-state details available through inspection

The crosshair is represented by a vertical bar spanning the plot.

Quote resolution order:

1. Use a direct provider pair when available.
2. Otherwise derive the selected provider price through a CoinGecko conversion ratio for the same bucket.
3. Mark converted values as derived and retain the conversion source.
4. Leave the value unavailable when no trustworthy conversion exists.

The application must not present a converted value as a native exchange pair.

### 9.7 Asset Lifecycle And Valuation Rules

Asset identity is based on network, contract or mint when applicable, and provider identifiers. A symbol alone is never identity.

Rules:

- wrapped assets remain distinct from their underlying assets
- forks remain distinct assets and do not rewrite the original asset history
- migrations, swaps, and redenominations use explicit effective timestamps, source and destination identities, and conversion ratios
- lifecycle events create derived continuity views when useful but never mutate raw provider or transaction history
- stablecoins use observed market prices and are never hardcoded to their named fiat peg
- a stablecoin without a trustworthy price is marked unpriced rather than valued at one unit of fiat
- delisted assets retain all cached history and lifecycle metadata
- raw Kraken asset identifiers and suffixes are retained even when the UI presents normalized labels or category groupings
- fiat balances are native at par only in the same currency; conversion to another currency uses timestamped FX data with provenance

Lifecycle mappings, derived continuity, and valuation assumptions must be inspectable in the UI and included in relevant JSON and complete application exports.

## 10. Shared Graph Contract

### 10.1 Range Controls

Every graph supports:

- 24 hours
- 7 days
- 30 days
- 90 days
- 1 year
- All available
- custom start and end

Range controls operate in the configured display timezone, while API queries and storage use UTC.

The UI must handle daylight-saving transitions without duplicating or losing UTC data.

### 10.2 Scale

Supported Y-axis scales:

- Linear
- Logarithmic

For valuation and price charts, the Y-axis unit selector contains the primary
currency, every configured display currency (up to five), and every activated
crypto asset exposed by the chart. Opening the selector provides a search field
that filters by fiat code or crypto symbol, name, and canonical ID. The selected
unit remains part of the graph's database-backed display state.

Logarithmic scale requires every visible plotted value to be greater than zero.

If zero or a negative value becomes visible:

- log selection is disabled or the graph returns to linear
- the UI explains why
- the data is not silently removed to make log scale work

P&L graphs that cross zero therefore use linear scale.

### 10.3 Minimum And Maximum Bounds

Minimum and maximum are configured independently.

Each bound supports:

- Auto
- Absolute
- Relative

Absolute:

- the user enters an exact value in the primary plotted unit

Relative:

- minimum means visible data minimum minus a configured percentage of the visible data range
- maximum means visible data maximum plus a configured percentage of the visible data range
- when the visible range is zero, padding is based on the absolute value or a safe non-zero fallback

Validation:

- absolute minimum must be less than absolute maximum when both are set
- log bounds must be positive
- invalid input remains editable but is not applied
- Reset returns both bounds to Auto

### 10.4 Interaction

Every graph supports:

- hover
- keyboard-accessible inspection
- vertical crosshair
- pan
- wheel or gesture zoom
- drag-to-select zoom
- reset zoom
- series show/hide
- legend inspection
- missing-data gaps
- loading, partial, stale, and error states

Wheel and horizontal-pan time navigation is inactive until the plotting surface has been clicked or keyboard-focused, and becomes inactive again on blur. The graph tooltip occupies a stable left or right inset position rather than following the pointer. It preserves the Y-axis scale gutter, uses proximity-based side switching to avoid jitter, and may be pinned by clicking a plotted point. Escape or clicking the empty plotting area closes a pinned tooltip.

The keyboard inspector is an actual interactive control: activating it reveals instructions, Left/Right moves one data point, Home/End jumps to the first/last point, and the active point is announced. Its label must not imply functionality that is unavailable.

Chart title, subtitle/source, legend, controls, plot, and through-date metadata occupy distinct layout regions at all supported widths. Each reorderable block except the first begins after a visible horizontal separator with useful top and bottom padding; the separator belongs above the Up/Down/Collapse controls.

Graph state should be serializable into the URL when practical so a view can be bookmarked.

Graphs show provider attribution and data quality on inspection, including native, derived, fallback, converted, partial, stale, and disputed states. Attribution is accessible without hovering.

### 10.5 Accessibility

- Graph controls must be keyboard accessible.
- Color is not the only series identifier.
- Series use labels, dash styles, or symbols where needed.
- A tabular view of the currently plotted data must be available.
- Tooltip data must be reachable without requiring a mouse.
- Focus follows the styleguide warning tone.

Accessible event details are searchable and paginated at 25 rows per page. Per-event evidence remains available from a compact disclosure, so hundreds of events never expand into hundreds of full cards.

### 10.6 Normalized Comparison And Event Markers

Compatible line graphs support a normalized comparison mode. Each enabled series is rebased to 0% at its first valid point within the selected range, and subsequent values show percentage change from that base. A series with no value at the range start begins at its first valid point and visibly identifies that base timestamp.

Normalized mode:

- never replaces or mutates raw values
- remains line-only and is unavailable for OHLC candle bodies
- keeps raw values available in tooltips, tables, and exports
- labels the Y-axis as percentage change
- records its enabled state and base timestamp per series in the URL and export metadata

Graphs display optional event markers when corresponding data exists. Marker categories include:

- trades
- deposits and withdrawals
- reconciled owned transfers
- Earn and staking rewards
- address transactions

Users can toggle all markers or individual categories. Selecting a marker opens an accessible detail view with timestamp, category, asset, quantity, source, reconciliation state, and related series. Dense markers may be clustered visually without losing the underlying events from inspection or export.

### 10.7 Saved Dashboard Graphs

A graph configured on Markets, Addresses, or Kraken can be named and saved to the Dashboard. Saved graph configuration is database-backed and includes its source type, selected assets where applicable, source/currency/timezone, range, granularity, chart mode, scale, normalized state, event state, and volume state.

The Dashboard supports one, two, three, or four graphs per row and unlimited rows subject to normal page performance. Dashboard graphs use a compact presentation without duplicating the full configuration toolbar.

A saved graph may be hidden from the Dashboard, restored, renamed, removed from the Dashboard, or permanently deleted in Settings. “Remove” on the Dashboard hides it so accidental removal is reversible.

## 11. Graph And Data Exports

### 11.1 Export Scope

An export reflects exactly:

- selected page and graph
- date range
- resolved granularity
- enabled assets
- enabled addresses
- primary currency
- selected tooltip currencies
- selected provider or Combined
- chart mode
- normalized comparison state and base timestamps
- event-marker category filters
- volume subplot visibility
- current filters
- timezone

An export does not silently include disabled or off-screen series.

### 11.2 CSV

CSV must contain:

- UTC timestamp
- display-timezone timestamp
- canonical series ID
- series label
- primary plotted value
- raw value and normalized percentage when comparison mode is enabled
- selected tooltip currency values when applicable
- source
- native, derived, fallback, converted, or disputed status
- provider spread and contributing values when disputed
- event records selected by the graph filters
- volume when the subplot is enabled and data exists
- completeness or coverage status when applicable

Wide or long CSV layout may be selected during implementation, but the format must be stable, documented, and tested.

### 11.3 JSON

JSON export contains:

- schema version
- application version
- build hash
- generation timestamp
- locale and timezone
- graph type
- source selection
- range
- granularity
- enabled filters
- series definitions
- provider provenance
- disagreement metadata and contributing provider values
- normalization bases
- selected event records
- volume data when visible
- completeness metadata
- exact decimal values as strings
- points

JSON exports must not contain secrets, auth headers, internal database IDs that are not part of the public API, or raw provider credentials.

### 11.4 PNG And SVG

PNG and SVG snapshot exports must include:

- graph title
- selected range
- resolved granularity
- legend
- axes and units
- visible series
- normalized Y-axis and base note when enabled
- visible event markers
- volume subplot when enabled
- source attribution
- generation time
- partial, incomplete, stale, or disputed warning when present

Snapshots use the current theme.

SVG must remain vector-based. PNG should be rendered at a useful high-DPI resolution. The snapshot must not include unrelated page chrome or hidden tooltips.

Event-category controls and PNG, SVG, CSV, and JSON export controls have separate padded action rows with visible gaps between buttons.

Recommended filename pattern:

```text
cryptotracker-{graph}-{from}-{to}-{granularity}.{ext}
```

### 11.5 Complete Application Export

Settings provides an authenticated complete application export. This is an asynchronous persistent job because retained history may make the result large.

The export is a streaming archive containing:

- a versioned manifest with schema version, application version, build hash, generation time, and checksums
- non-secret user settings, watchlists, selected currencies, and graph defaults
- tracked addresses and address-asset selections
- asset mappings and lifecycle events
- all retained market points and provenance
- chain transactions, balance events, balance points, and sync completeness
- Kraken trades, ledgers, snapshots, balances, Earn/staking and margin records, and sync completeness
- internal-transfer matches, cost-basis lots, and calculation runs
- named calculation scenarios stored in user preferences

The archive excludes:

- configuration secrets and secret-file contents
- API keys, signatures, auth headers, and provider credentials
- password hashes
- sessions, cookies, CSRF tokens, and signed identity material
- deployment-specific trusted proxy secrets
- operational jobs, audit history, and generated export artifacts

The UI shows progress, estimated or known archive size, completion, failure, and expiry of the generated download. Archive artifacts may expire without deleting canonical data. Generation must be streaming or chunked and must not load the entire database or archive into memory.

The ZIP contains dependency-safe JSON files for preferences, markets, addresses, Kraken, portfolio snapshots, and calculations. Settings can inspect an uploaded ZIP and atomically replace any selected files. This application-level restore is intentionally separate from transaction-consistent database backup and disaster recovery, which remain operator-managed.

## 12. Address Tracking

### 12.1 Initial Networks

Initial adapters:

- Bitcoin mainnet
- Ethereum mainnet
- Solana mainnet-beta

Default selected native asset by network:

- Bitcoin address: BTC
- Ethereum address: ETH
- Solana address: SOL

Optional selected assets:

- ERC-20 contracts for Ethereum
- SPL token mints for Solana

The app does not retrieve every token ever associated with an address by default. The user selects the assets that matter.

### 12.2 Provider Baseline

Recommended initial providers:

- Bitcoin: Blockstream Esplora-compatible API
- Ethereum: Etherscan V2-compatible account APIs
- Solana: Helius transaction and asset APIs

Provider endpoints and keys are configurable.

The adapter contract must permit later providers or self-hosted endpoints without changing address-domain logic.

### 12.3 Adding An Address

The user supplies:

- network
- address
- label
- enabled state
- selected assets

The API must:

- validate address syntax for the selected network
- normalize only where the network permits normalization
- prevent duplicate active entries for the same network and address
- never request a private key, seed phrase, xpub, or signature
- show a privacy notice that configured external providers receive the public address

Adding an address creates a persistent initial-sync job.

### 12.4 Historical Backfill

The preferred backfill target is the address's first transaction.

The synchronizer:

- paginates backwards or forwards as supported
- records durable cursors
- resumes after restart
- deduplicates transactions and transfers
- processes only the native asset and selected tokens
- updates progress in the UI
- refreshes a recent overlap window for reorgs or late indexing

History status:

- `syncing`: initial or repair job is active
- `complete`: the provider reports that the first available transaction was reached without a known truncation
- `partial`: the provider limit, missing archive, rate policy, unsupported transaction form, or parsing failure prevents a complete history
- `stale`: synchronization has not succeeded within the configured threshold
- `error`: the most recent job failed and is not currently retrying

The UI must show status and the oldest successfully reconstructed timestamp.

“Complete” means complete according to the configured provider and selected assets; it is not a cryptographic guarantee that an external indexer has no omissions.

### 12.5 Network Reconstruction

Bitcoin:

- process confirmed address transactions in chronological order
- calculate address value received and spent from transaction inputs and outputs
- retain unconfirmed activity separately
- refresh recent blocks to handle reorgs
- require configurable confirmations before treating a point as finalized

Ethereum:

- process normal transactions
- process internal value transfers when provided
- process selected ERC-20 transfers
- include outgoing gas fees for the address
- use block number and transaction position for deterministic ordering
- refresh recent blocks before finalization

Solana:

- process finalized transaction history for the address
- process native SOL balance changes
- process selected SPL token-account balance changes
- account for associated token accounts when the provider supports wallet-level history
- retain the provider completeness boundary

Unsupported or ambiguous transactions must be recorded as warnings and affect completeness rather than being silently ignored.

### 12.6 Address Portfolio Series

For every requested bucket:

1. Carry the most recent known asset balance forward as a step value.
2. Resolve an allowed price for the same bucket.
3. Multiply with exact decimal arithmetic.
4. Sum only enabled assets.
5. Record priced and unpriced value coverage.

Default graph mode:

- one value line per enabled address
- one combined line summing enabled addresses

Additional toggles:

- address on/off
- asset on/off
- combined line on/off
- show address totals
- show asset totals across addresses
- show an address/asset breakdown when requested

The holdings table must show:

- address
- label
- network
- asset
- quantity
- one current-value column per configured quote currency
- oldest reconstructed history
- last successful sync
- completeness

The holdings table has a searchable column configurator. The primary-currency value column is enabled by default; additional configured-currency value columns are available but initially disabled. The selected columns and their order are stored in database-backed user settings. When one address tracks multiple assets, its label and public address are presented once as a grouped row heading rather than repeated for every asset row.

When an asset lacks a price:

- its quantity remains visible
- it is excluded from the priced total
- coverage is reduced
- the UI displays an unpriced-asset warning

### 12.7 Removing Data

Disabling:

- preserves history
- stops the series from contributing to graphs
- may stop background synchronization when all uses are disabled

Deleting an address:

- requires confirmation
- removes the tracked address and address-specific derived history
- cancels queued address jobs
- does not remove shared market-price cache
- leaves only a redacted audit record

Removing a watched asset:

- removes it from the watchlist
- stops its automatic market synchronization unless another feature still needs it
- retains shared cached market history

## 13. Kraken Integration

### 13.1 Scope

One Kraken account is supported.

Initial Kraken surfaces:

- spot cash balances
- spot trade history
- ledger history
- deposits and withdrawals as read-only ledger events
- Earn and staking allocations/rewards
- margin balances and open/closed position information exposed by the Spot API

Kraken Futures is excluded.

Sections with no balances, positions, allocations, or history must be hidden from the normal navigation and summary. A diagnostics view may still state that a capability is unused or unavailable.

### 13.2 Credentials

Kraken credentials come only from secrets JSON5 or explicit secret environment variables.

- Credentials are loaded at startup.
- Credential changes require restart.
- Credentials are never editable in the UI.
- The app uses one monotonic nonce coordinator for private requests.
- Concurrent private requests must not generate invalid or decreasing nonces.

Required permissions should be limited to read-only capabilities such as:

- query funds
- query closed trades
- query ledger entries
- query open positions when required
- query Earn allocations when required

On startup and in diagnostics, the application should inspect available key permissions when Kraken exposes them.

If the key contains trading, withdrawal, transfer, or other write permissions:

- the integration is not activated
- the UI reports that an unsafe key was supplied
- the secret value is never shown
- startup of the rest of the application may continue in degraded mode

No code path may call a Kraken mutation endpoint.

### 13.3 Initial Import

On first successful configuration:

- import all available spot trade history
- import all available ledger history
- import current balances
- import Earn/staking allocations
- import current and available historical margin data
- import available closed-order and recent funding history
- record current extended balances, open orders, margin/trade balance, rolling volume/fee tiers, and credit-line state when available
- record per-endpoint cursors and completeness
- tolerate pagination and rate limiting

The initial import is resumable.

### 13.4 Ongoing Synchronization

Default schedule: every 5 minutes.

When permissions are unsafe or required query permissions are missing, the Kraken page shows an accordion with basic remediation steps, an exact allow list, an exact revoke list derived from the inspected key, per-permission purpose, and a link to Kraken's key-management instructions.

Each cycle:

- fetches current extended balances, including held and credit amounts
- fetches incremental trades
- fetches incremental ledgers
- fetches Earn/staking allocation, payout, strategy, and pending-operation state
- fetches margin positions and account-level margin/risk state
- fetches open/closed orders, recent funding statuses, rolling volume/fee tiers, and credit-line state when available
- stores content-addressed account-state versions and extends unchanged versions without duplicating their JSON
- writes one account snapshot
- recalculates affected derived ranges

Manual refresh:

- is available from the UI
- coalesces with an existing job
- is rate limited
- shows progress and the most recent successful completion

### 13.5 Portfolio Views

Kraken summary:

- total current value
- value by asset
- value by product category
- absolute and percentage change over selected periods
- priced-value coverage
- latest successful sync

“Priced” means a non-zero Kraken balance has a reviewed canonical asset identity and a compatible cached quote in the selected currency. The current known value is the sum of priced balances only; it must never be labelled as the complete Kraken account value when coverage is below 100%. Coverage is shown as both an explicit count and a rounded percentage, unpriced balances are named, and the summary links to the Markets catalog when enabling a supported asset would make it eligible for price synchronization.

Kraken raw balance identifiers, including staked suffixes such as `.S`, are normalized to canonical assets while retaining the original identifier. The current Earn Allocations response shape is imported using its native asset, allocated-native amount, total native rewards, strategy identifier, and utilization state. Existing allocation rows are repaired on refresh when an older importer stored blank identity fields.

The Earn asset table shows the currently observed estimated rate range and one current-value column for each configured quote currency. Summary values use the same focusable multi-currency popup as Dashboard values, including current known value, current Earn value, and lifetime Earn rewards. Kraken's read-only Earn Strategies endpoint exposes only the current APR estimate and compounding metadata, not historical rates. Each account refresh therefore stores an observation locally and the APY-history graph explicitly reports that its coverage begins with the first local capture; it does not claim provider backfill. Projected APY is calculated from the observed APR only when the strategy reports automatic compounding and a supported payout frequency.

The Kraken total graph popup lists quantities only for enabled watchlist assets by default. A checkbox beside the keyboard inspector allows disabled or inactive quantities to be included for inspection without changing the plotted total.

The balance table has a searchable, database-backed column configurator. Search updates the visible choices as the user types, checkboxes align with their labels, and selected columns can be moved left or right. Available columns include asset, raw balance, average buy price in each of up to five configured currencies, current price in each currency, wallet value in each currency, 24-hour, 7-day, 28-day, month-over-month, month-to-date, 3-month, 6-month, 1-year, 2-year, and 4-year change, and unrealised return. Additional provider or calculation columns may be added without changing the core contract.

Every displayed numeric value with an absolute magnitude of 10 or greater is rounded to two decimal places. Smaller values may retain up to eight decimal places where asset precision matters; exports and stored values retain exact strings.

Every unpriced Kraken holding exposes a reason, such as missing canonical mapping, a disabled market asset, no synced quote-currency price, or an incompatible cached price. The reason appears in a keyboard-focusable hover/focus popup and does not expand the table row. Pricing coverage is distinct from synchronization state. A disabled Kraken holding links to the Markets catalog filter because it will not be priced by market synchronization until explicitly enabled.

The Kraken balance table is a bounded scrolling region so its horizontal scrollbar remains reachable without scrolling the whole page to the final row. Asset rows move optimistically and immediately when Up/Down is pressed, then persist that order. Empty Earn and Margin sections are omitted entirely, including their block controls.

Kraken history graph:

- total portfolio value
- optional asset lines
- optional category lines for spot, Earn/staking, and margin when implemented
- realised P&L estimate
- unrealised P&L estimate
- cumulative fees when available
- rewards when available

The total and every held canonical Kraken asset are separate toggleable series. Only the total is selected by default, visibility is database-backed, and saved Dashboard graph configurations retain the selected series. Kraken account-value history starts with imported/reconstructed activity where possible and otherwise with the first stored snapshot; market-price history is backfilled independently and does not invent earlier account holdings.

All lines use the shared graph controls.

### 13.6 Cost Basis

Supported informational methods:

- `acb`: weighted-average adjusted cost base; default
- `fifo`
- `lifo`

The method is a database-backed user preference.

Calculation currency: the configured primary currency, which may be CAD, AUD, or another supported three-letter currency. Labels show the actual currency code rather than country-specific terminology.

Rules:

- Exchange trades create acquisitions and dispositions.
- Trading fees are included when sufficient data exists.
- Crypto-to-crypto trades are valued in the configured primary currency using the selected historical valuation source.
- Kraken-reported realised values may be shown separately from app-derived values.
- Earn/staking rewards may receive an estimated acquisition value using market value at receipt, clearly marked as estimated.
- Margin values should prefer provider-reported realised/unrealised fields when available.
- Recalculation is deterministic for the same source data, price source, and method.

The UI may show a concise informational estimate notice explaining that historical data and provider completeness affect results. The notice is dismissible and its dismissal is database-backed. Repetitive tax-disclaimer copy is not required beside every calculation.

### 13.7 Unknown Cost Basis

An unknown-basis quantity can arise when an asset enters Kraken without a corresponding Kraken acquisition record, such as an external deposit.

Unknown-basis rules:

- include quantity in holdings
- include market value in portfolio totals
- mark the affected quantity
- exclude the unknown portion from definitive realised or unrealised P&L
- show cost-basis coverage as a percentage
- show an incomplete-basis warning
- never silently assume a zero cost basis

Because manual imports are out of scope, the user cannot repair unknown basis in the initial version.

### 13.8 Owned Transfer Reconciliation

Kraken deposits and withdrawals are reconciled against transactions involving tracked addresses so movement between the user-owned surfaces is not treated as a gain, loss, reward, or duplicated portfolio value.

Matching uses the strongest available evidence in this order:

1. exact network and transaction ID, asset identity, and direction
2. exact asset quantity after explicit network-fee treatment plus a bounded timestamp window
3. a likely match using asset, amount tolerance, direction, and time when identifiers are unavailable

Every candidate records its evidence and deterministic confidence as exact, likely, or unmatched. Only exact matches are automatically classified as internal transfers. Likely matches are marked for inspection but do not alter gain/loss classification in the initial version.

For an exact match:

- preserve both raw source records
- link them through one canonical transfer match
- avoid double-counting the quantity in combined history during timing gaps
- carry known lot basis across the transfer when the source lot is identifiable
- exclude the movement itself from realised P&L and reward totals
- retain network and exchange fees as separate, inspectable effects

An unmatched Kraken deposit retains unknown cost basis. An unmatched Kraken withdrawal leaves Kraken holdings and only appears in tracked-address holdings if the chain adapter observes it. Reconciliation never writes to Kraken or a blockchain.

## 14. Authentication

### 14.1 Access Model

CryptoTracker is single-tenant and has no RBAC.

Access is binary:

- authenticated and allowed: full application access
- unauthenticated: login or authentication challenge
- authenticated but not allowed: `403`

All authenticated identities have the same application capability.

The application still records the authenticated username in logs and audit entries.

### 14.2 Local Authentication

Local authentication is optional.

Configuration:

- one configured username in config JSON5 or an explicit environment variable
- password in secrets JSON5 or an explicit secret environment variable

Startup behavior:

1. Normalize the configured username to lowercase.
2. Create the local user record if it does not exist.
3. Verify whether the configured password matches the stored Argon2id hash.
4. If it differs, replace the hash and invalidate existing local sessions.
5. Never store the plaintext password.

There is no user-management or password-change UI.

Local session requirements:

- opaque random session ID
- database-backed session
- Secure cookie in production
- HttpOnly
- SameSite=Lax or stricter when deployment permits
- configurable lifetime
- rotation on login
- invalidation on password change
- CSRF protection on every mutation

### 14.3 Trusted Header Authentication

Header authentication is optional and is the integration used by `oauth-wrapper`.

Defaults:

- username header: `Remote-User`
- groups header: `Remote-Groups`
- group separator: comma

Required configuration:

- one or more trusted proxy CIDRs
- allowed user array, allowed group array, or both

Matching:

- normalize usernames to lowercase
- compare users case-insensitively by exact value
- compare groups case-insensitively by exact value
- access is granted when any configured user matches or any configured group matches
- when both user and group arrays are configured, they remain OR conditions
- an empty allow policy denies access unless a future explicit `allowAllAuthenticated` option is added

Trust rules:

- accept identity headers only when the direct peer is in a trusted CIDR
- reject spoofed reserved auth headers from untrusted peers
- do not trust `X-Forwarded-For` to decide whether the direct peer is trusted
- forwarded client IP handling is separate from identity-header trust

### 14.4 Optional Signed Identity

The trusted-header mode may additionally verify the signed identity JWT emitted by `oauth-wrapper`.

When enabled:

- JWT verification is mandatory for header authentication
- use the configured header name
- validate HS256 signature
- validate issuer
- validate audience
- validate `exp`, `nbf`, and `iat` with bounded clock skew
- obtain username and groups from verified claims
- still require the request to originate from a trusted proxy
- ignore conflicting plain identity headers

The signing secret is loaded only from the secrets file or a secret environment variable.

### 14.5 Coexisting Local And Header Auth

Local and header authentication may both be enabled.

Request behavior:

1. If a valid trusted header identity is present and allowed, use it.
2. If no trusted identity is present and a valid local session exists, use the local session.
3. If neither exists and local auth is enabled, direct the user to local login.
4. If only header auth is enabled, return an authentication failure suitable for the outer proxy.

When `oauth-wrapper` protects the whole application, local login may only be reachable through explicitly configured deployment bypasses or a trusted direct route. The application must not weaken `oauth-wrapper` to make local fallback reachable.

### 14.6 CSRF And Same-Origin Security

Every application mutation requires:

- an authenticated identity
- same-origin validation
- a CSRF token

This includes:

- settings changes
- adding/removing assets
- adding/removing addresses
- address asset selection
- manual refresh
- repair jobs
- starting a complete application export

Read-only graph and export endpoints must not mutate upstream systems.

## 15. WUI

### 15.1 Primary Navigation

Initial pages:

- Dashboard
- Markets
- Addresses
- Kraken
- Settings

Dashboard:

- total known portfolio value
- address value
- Kraken value
- watched market summary
- provider and sync health
- warnings for partial history, stale data, disputed prices, unpriced assets, and incomplete cost basis

Markets, Addresses, and Kraken expose “Save table to dashboard” beside each configured table, while chart options expose “Save to dashboard”. The saved table retains its selected columns and source context.

The Dashboard stores an ordered set of named rows. Every row independently selects one, two, three, or four columns and may contain any mix of saved charts and tables. Items can move between rows, rows can be added or removed, and hiding an item does not delete its configuration.

Every primary page is composed of reorderable content blocks with compact Up/Down controls and a `+`/`−` expand-collapse control beside them. Block order and collapsed state are stored independently in database-backed settings for Dashboard, Markets, Addresses, Kraken, and Settings. Every non-first block has a separator above its controls; the first block does not.

A generic `read only: true` label is not displayed. Surfaces show the last successful connection check or snapshot timestamp when that information is useful.

Markets:

- watched assets
- source selection
- line/candlestick selection
- optional candlestick wicks
- optional volume subplot when supported
- normalized comparison mode for line charts
- toggleable market and portfolio event markers
- provider attribution, contribution values, and data-quality inspection
- disputed-price markers and details
- asset lifecycle details
- shared graph controls
- asset add/remove
- graph exports

Addresses:

- tracked address list
- address add/remove/edit
- asset selection
- synchronization status
- holdings table
- individual and combined graph
- normalized comparison where compatible
- address transaction and reconciled-transfer markers
- graph exports

Kraken:

- connection and permission status
- portfolio summary
- visible spot/Earn/staking/margin sections only when used
- holdings and activity
- P&L estimates and coverage
- historical graph
- trade, deposit, withdrawal, reward, and reconciled-transfer markers
- transfer reconciliation status and evidence inspection
- manual refresh
- graph exports

Settings:

- locale
- timezone
- theme
- font
- primary currency
- tooltip currencies
- default provider
- provider disagreement threshold
- graph defaults
- cost-basis method
- historical point/snapshot retention, defaulting to Forever
- independent automatic-polling intervals for each integration, with a five-minute minimum
- live synchronization progress and cursor coverage, with recent failed jobs first
- requested start, oldest reached, newest stored, and last activity by source
- named saved-graph management and one-to-four dashboard columns
- storage diagnostics by category, including estimated bytes, row counts, and oldest/newest records
- complete application export creation, progress, and download
- no secrets or credentials

Related fields are grouped into separate rows or fieldsets: locale/timezone, appearance, currencies/market source, calculations, and retention.

Markets, Addresses, and Kraken data tables have searchable column configurators. Search results update immediately, chosen columns can be reordered left/right, and selections and order are database-backed. Kraken balance rows also have database-backed Up/Down ordering.

All user-facing timestamps use `YYYY-MM-DD, HH:mm` in the selected timezone and 24-hour time.

### 15.2 Design Contract

The WUI must follow `../styleguide`:

- full-page monospace typography
- dark and light themes
- root-driven `data-theme`
- root-driven `data-font`
- root-driven content width
- flat surfaces
- no gradients
- semantic `start`, `mid`, `warning`, and `danger` tones
- warning-colored focus
- start-colored hover
- mid-colored selected/enabled states
- danger for error/destructive actions
- raised keycap treatment for real controls
- passive treatment for labels and badges

Root-level locale, theme, font, and content-width preferences are applied from a local last-known cache before first paint, then reconciled with authenticated database settings. A full page refresh must not visibly snap to defaults or wait for a later client-side navigation to restore the selected width.

The UI must use the real tool as the first screen and avoid marketing-style hero sections.

User-facing strings belong in a flat `en-CA` language source and use the styleguide interpolation helper where dynamic text is needed.

### 15.3 Responsive Behavior

The application targets desktop first but must remain usable on tablets and phones.

- Graph controls may collapse into disclosure panels.
- Crosshair values may become a scrollable compact table.
- Tables may use responsive columns plus an inspection dialog.
- Primary actions remain keyboard and touch accessible.
- No graph or table may force unreadable fixed-width overflow.

Provider attribution, data-quality labels, lifecycle details, event details, and reconciliation evidence must be available through accessible dialogs or panels rather than hover alone.

## 16. HTTP Surface

The exact payload schemas are implementation work, but the initial route families are:

### 16.1 Health

- `GET /health`
- `GET /healthz`
- `GET /readyz`

### 16.2 Authentication

- `GET /auth/methods`
- `POST /auth/local/login`
- `POST /auth/logout`
- `GET /api/me`

### 16.3 Settings And Status

- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/providers/status`
- `GET /api/sync/progress`
- `GET /api/diagnostics/storage`
- `GET /api/jobs`
- `GET /api/jobs/:id`

### 16.4 Assets And Market Data

- `GET /api/catalog/assets`
- `POST /api/catalog/refresh`
- `GET /api/watchlist/assets`
- `POST /api/watchlist/assets`
- `POST /api/watchlist/assets/bulk`
- `PATCH /api/watchlist/assets/:id`
- `DELETE /api/watchlist/assets/:id`
- `GET /api/watchlist/currencies`
- `PUT /api/watchlist/currencies`
- `GET /api/market/series`
- `GET /api/market/metrics`
- `POST /api/market/backfill`
- `POST /api/market/repair`

### 16.5 Addresses

- `GET /api/addresses`
- `POST /api/addresses`
- `PATCH /api/addresses/:id`
- `DELETE /api/addresses/:id`
- `PUT /api/addresses/:id/assets`
- `POST /api/addresses/:id/refresh`
- `GET /api/addresses/holdings`
- `GET /api/addresses/series`

### 16.6 Kraken

- `GET /api/kraken/status`
- `POST /api/kraken/refresh`
- `GET /api/kraken/summary`
- `GET /api/kraken/holdings`
- `GET /api/kraken/activity`
- `GET /api/kraken/pnl`
- `GET /api/kraken/series`

### 16.7 Exports

- `GET /api/exports/series.csv`
- `GET /api/exports/series.json`
- `POST /api/exports/application`
- `GET /api/exports/application/:id`
- `GET /api/exports/application/:id/download`

The application-export POST creates an authenticated, CSRF-protected job. Status and download routes enforce the same single-tenant authentication. Download responses are streamed and use attachment headers.

PNG and SVG graph snapshots are normally produced in the WUI from the rendered graph state.

### 16.8 API Rules

- All API responses have documented schemas.
- Errors use stable error keys and codes.
- Every response carries a correlation ID.
- List endpoints have deterministic ordering.
- Potentially large endpoints support pagination or bounded range queries.
- Range endpoints reject unreasonable unbounded fine-granularity requests.
- Decimal values are serialized as strings.
- Mutation endpoints are idempotent where practical.
- `DELETE` endpoints require exact resource IDs and never accept filesystem paths.

## 17. Health And Diagnostics

Health responses include:

```json
{
  "ok": true,
  "version": "0.1.0",
  "buildHash": "abc1234def56"
}
```

`/health` and `/healthz` are liveness endpoints.

`/readyz` checks:

- database
- migrations
- required startup configuration
- WUI process

External providers do not make the process unready after successful startup. Their state is reported as healthy, degraded, rate-limited, or unavailable in application diagnostics.

Diagnostics include:

- application build
- database mode
- WUI reachability
- provider enablement without secrets
- provider last success
- provider cooldown
- queue depth
- oldest pending job
- Kraken configured/connected/read-only status
- address sync completeness counts
- market cache newest/oldest coverage
- canonical storage use by category, with row counts and estimated bytes
- database-wide estimated size
- oldest and newest retained records by major category
- pending and completed application-export status
- provider attribution and latest contribution timestamps
- current provider-disagreement threshold and recent disputed-point counts

No diagnostic response contains secrets or full external account payloads.

## 18. Logging And Audit

The application must use the styleguide structured logging and error conventions.

Requirements:

- unique error key per structured error path
- unique logger key per gated event path
- correlation ID propagation
- console, file, HTTP, and syslog-compatible sinks as provided by the shared logger pattern
- configurable gates for high-volume provider and synchronization events
- startup diagnostics with version and build hash
- optional Kubernetes metadata
- redaction of secrets, cookies, auth headers, API signatures, and full provider URLs containing keys

Audit events include:

- successful and failed local login
- accepted and denied header identity
- settings changes
- watched asset add/remove
- address add/edit/delete
- address asset-selection changes
- manual refresh and repair requests
- complete application export start, completion, failure, and download
- Kraken integration activation failure due to unsafe permissions

Audit entries include:

- timestamp
- username
- auth method
- source IP
- action
- target type
- redacted target identifier
- result
- correlation ID

## 19. Security Requirements

- Strictly read-only upstream adapters.
- No exchange mutation endpoints in provider interfaces.
- No blockchain broadcast endpoint in provider interfaces.
- Refuse Kraken keys with write permissions.
- Secrets remain server-side and out of the database.
- Secure cookies in production.
- CSRF protection.
- same-origin validation.
- explicit trusted-proxy configuration.
- trusted header CIDR enforcement.
- optional signed identity verification.
- request body size limits.
- input validation on every mutation and provider-facing identifier.
- URL allowlists from startup configuration.
- no upstream URL from request input.
- no SSRF through provider configuration APIs.
- no shell execution for provider operations.
- CSP, `X-Content-Type-Options`, `Referrer-Policy`, and appropriate framing policy.
- dependency audit and lockfile.
- non-root production container user.
- read-only container root filesystem where deployment permits.

## 20. Reliability And Performance

### 20.1 Reliability

- Temporary provider outages do not prevent viewing cached data.
- Cached data is accompanied by age and stale status.
- Jobs resume after restart.
- Provider pagination is idempotent.
- Recent chain history is refreshed for reorg handling.
- Manual refresh does not start duplicate work.
- Database writes use transactions for cursor-and-data updates.
- A failed derived calculation does not discard raw imported data.

### 20.2 Intended Scale

The initial product is optimized for a normal personal account:

- up to the ranked top 100 watched assets, not thousands
- tens of addresses, not mass surveillance lists
- typical personal transaction counts
- one Kraken account
- one active application replica
- Forever retention by default, or a user-selected finite point/snapshot window
- shorter ranges at five- to thirty-minute resolution when providers support it
- database growth over years of polling without assuming automatic pruning

The UI should remain responsive with at least 10,000 plotted source points before display downsampling.

Cached dashboard and graph requests should normally respond within one second on typical self-hosted hardware, excluding initial backfill and export generation.

### 20.3 Partial Results

When some data is available and some is still syncing:

- return available data
- include a partial flag that means missing coverage, not necessarily active work
- include missing interval or coverage metadata
- expose the responsible job ID when a job exists
- do not convert the whole response into a generic failure

The UI names the affected assets, addresses, currencies, or intervals. It links to Settings synchronization diagnostics instead of indefinitely claiming that unspecified data “is synchronizing.”

## 21. Deployment

### 21.1 Production Image

One multi-stage Docker build contains:

- API runtime
- compiled SvelteKit WUI runtime
- root launcher
- production dependencies
- generated build metadata

The final image:

- uses a non-root user
- includes `tini` or equivalent init behavior
- exposes only the API/ingress port
- does not include `.git`
- does not require Git at runtime
- contains generated `build-info.json`
- supports read-only root filesystem with writable data and temp mounts

### 21.2 Compose

`./docker-compose.yml` provides:

- CryptoTracker application
- persistent SQLite data volume by default
- read-only mounted config and secrets
- optional Postgres profile or documented alternate compose file
- optional `oauth-wrapper` example profile or companion example
- one published application port

The internal WUI port is not published.

`./docker-compose.dev.yml` provides:

- bind-mounted source
- API hot reload
- SvelteKit/Vite hot reload
- root ingress still used as the normal browser entry point
- named `node_modules` volumes
- development-only diagnostics

### 21.3 Kubernetes

The primary Kubernetes shape is one pod containing:

- CryptoTracker application container
- optional `oauth-wrapper` sidecar

The CryptoTracker container still runs its API and WUI child processes.

Only the API ingress container port is exposed by the Service.

Config and secrets may be mounted from ConfigMaps and Secrets.

The application runs as a single replica.

### 21.4 Build Metadata

The build generates:

- `version`
- `buildHash`

Both are:

- logged at startup
- returned by health endpoints
- shown in the signed-in application shell

Image publishing should produce:

- `latest`
- version
- version plus 12-character Git hash

### 21.5 Backup Responsibility

Application-level ZIP backup and selective restore are available for portable portfolio data. Automated schedules, secret restoration, and transaction-consistent database or cross-database disaster recovery remain operator-managed. Operators may back up SQLite volumes or PostgreSQL using their normal platform tooling; documentation must state that the portable ZIP is not a substitute for those backups.

## 22. Testing Requirements

### 22.1 Unit Tests

Required coverage includes:

- config and secrets validation
- precedence rules
- decimal arithmetic
- asset mapping
- quote conversion
- combined median and single-provider fallback
- provider-spread calculation and disputed-point marking
- missing-point behavior
- candle derivation and insufficient-sample rejection
- candle wick toggle state
- volume availability rules
- range and granularity aggregation
- normalized comparison bases and percentages
- event-marker filtering
- absolute/relative graph bounds
- log-scale validation
- rate limiter and backoff
- job idempotency
- address validation
- address balance reconstruction
- exact, likely, and unmatched owned-transfer reconciliation
- transfer cost-basis continuity and fee treatment
- P&L cost-basis methods
- unknown-basis coverage
- asset migrations, redenominations, wrapped identities, and stablecoin pricing
- header allowlist OR semantics
- trusted CIDR checks
- signed identity validation
- local password synchronization

### 22.2 Integration Tests

- SQLite migrations and queries
- Postgres migrations and queries
- SQLite/Postgres logical parity
- API auth and CSRF
- API proxy behavior
- WUI failure handling
- provider clients using recorded fixtures
- Kraken nonce coordination
- initial and incremental synchronization
- restart/resume of jobs
- graph-series API partial responses
- CSV and JSON exports
- complete application export streaming, manifest, and secret exclusion
- Forever retention and finite-window point/snapshot pruning
- protected transaction, activity, and cost-basis records under finite retention
- top-100 catalog refresh, BTC-only default, searchable explicit enablement, and disabled-asset sync exclusion
- persisted page order, table columns, saved graphs, and notice dismissal
- health and readiness

Live upstream APIs must not be required for the normal test suite.

### 22.3 Browser Tests

Use Playwright or equivalent for:

- local login
- trusted-header development fixture
- dashboard navigation
- add/remove watched asset
- BTC-only default, searchable dropdown enablement, and disabled-asset sync exclusion
- line graph with multiple assets
- candlestick graph with wicks on/off
- volume subplot availability and synchronization
- normalized comparison mode
- event marker category toggles and accessible details
- provider attribution and disputed-price inspection
- crosshair with multiple quote currencies
- range, granularity, scale, and bounds
- add/disable/delete address
- address and asset toggles
- combined address line
- Kraken hidden/visible sections using fixtures
- partial-history warnings
- exact Kraken permission-remediation accordion
- CSV, JSON, PNG, and SVG export
- storage diagnostics and retention selection
- live sync progress with requested start and oldest point reached
- complete application export progress and download
- dark/light theme
- keyboard graph inspection
- second-click and Escape keyboard-inspector dismissal with arrow/Home/End page-scroll suppression
- chart title, legend, controls, and plot do not overlap
- non-first block separators appear above the reorder controls with adequate vertical padding
- searchable table column configuration
- persisted table-column and Kraken-row reordering
- catalog-table filtering, refresh-filter clearing, and immediate newly enabled chart selection
- searchable, 25-row paginated accessible event details
- save, arrange, hide, restore, rename, and delete dashboard charts and tables
- independent one-to-four-column mixed chart/table dashboard rows
- reorder and collapse page blocks and retain both states after reload

### 22.4 Security Tests

- spoofed auth headers from untrusted peers
- trusted peer with disallowed user
- trusted peer with allowed user
- trusted peer with allowed group
- invalid signed identity
- expired signed identity
- CSRF failure
- origin failure
- provider URL injection
- unsafe Kraken key permissions
- secret redaction
- complete application export secret, password-hash, and session exclusion
- unauthorized application-export status and download

## 23. Acceptance Criteria

The initial implementation is acceptable when:

1. One production image starts the API/ingress and internal SvelteKit processes.
2. Only the API/ingress port is externally exposed.
3. API ingress successfully proxies WUI HTTP traffic.
4. SQLite and Postgres modes both pass the integration suite.
5. No Redis service is required.
6. Config and secrets JSON5 files are validated at startup.
7. Secret environment variables override matching secrets-file values.
8. BTC is watched by default.
9. The user can enable or disable individual assets from the searchable top-100 catalog; there are no ranked bulk-enable controls.
10. CoinGecko, Coinbase, Kraken, and Combined sources are selectable.
11. Combined source uses median-or-single-fallback behavior with provenance.
12. Multiple assets render in line mode.
13. One focused asset renders native or clearly labeled derived OHLC candles.
14. Candlestick wicks can be shown or hidden.
15. The crosshair vertical bar shows every visible asset in up to five quote currencies.
16. Every graph supports range, granularity, scale, and min/max controls.
17. Log scale never silently drops zero or negative values.
18. CSV and JSON exports reproduce the selected graph data and filters.
19. PNG and SVG exports reproduce the visible graph.
20. The user can add Bitcoin, Ethereum, and Solana addresses.
21. The user can select native assets, ERC-20 contracts, and SPL mints as applicable.
22. Address backfill is resumable and reports complete or partial history.
23. Address graphs show individual enabled addresses and a combined line.
24. Address and asset toggles affect both graphs and totals.
25. Kraken connects using a read-only Spot API key.
26. Unsafe Kraken key permissions prevent integration activation.
27. Spot, Earn/staking, and margin sections appear only when used.
28. Kraken Futures is absent.
29. Kraken history imports incrementally and current-only account and Earn state is observed every 5 minutes by default.
30. ACB, FIFO, and LIFO estimates are selectable.
31. Unknown cost basis is visible and never assumed to be zero.
32. Local auth works with the configured single account.
33. Trusted-header auth accepts any allowed user or allowed group.
34. `oauth-wrapper` default identity headers work through trusted proxy configuration.
35. Optional signed identity verification works.
36. Local and trusted-header auth can coexist.
37. No application path places trades, transfers funds, changes exchange settings, or broadcasts blockchain transactions.
38. Health endpoints and startup logs include version and build hash.
39. Cached data remains viewable during an upstream outage.
40. The default locale, timezone, and primary currency are `en-CA`, `America/Vancouver`, and CAD.
41. Historical points and snapshots default to Forever retention, may be limited by the user after confirmation, and never prune protected transaction/activity/cost-basis records or destructively downsample.
42. Large provider disagreements are marked and inspectable while the Combined median remains plotted.
43. Exact owned transfers between Kraken and tracked addresses do not create false gains, losses, rewards, or duplicated holdings.
44. Wrapped assets, forks, migrations, redenominations, delistings, and stablecoins follow explicit lifecycle and valuation rules.
45. Stablecoins are never silently valued at their named peg without observed price data.
46. An application ZIP backup streams restorable data groups with a versioned manifest and excludes credentials, password hashes, sessions, jobs, and audit history.
47. Compatible line graphs support normalized percentage comparison without losing raw values.
48. Available trades, transfers, rewards, and address transactions can be shown as toggleable, accessible event markers.
49. A synchronized volume subplot is available when the selected source has meaningful volume.
50. Settings shows storage use, row counts, oldest/newest retained data, the selected retention window, and live per-source synchronization progress including requested start and oldest point reached.
51. Market views expose provider attribution and disputed, derived, converted, fallback, partial, and stale states without requiring hover.
52. Chart titles, legends, metadata, controls, and plot areas do not overlap.
53. All primary pages have database-backed Up/Down block ordering, adjacent `+`/`−` collapse controls, and a separator above every non-first block.
54. Markets, Addresses, and Kraken have searchable, database-backed table column configuration.
55. Named chart and table configurations can be saved into independently sized one-to-four-column Dashboard rows, mixed freely, moved, hidden, restored, renamed, removed, or deleted.
56. Kraken unpriced holdings identify the pricing reason without expanding row height, and displayed values at magnitude 10 or greater are rounded to two decimal places.
57. Unsafe Kraken permissions show an exact allow/revoke remediation accordion.
58. BTC is the only default enabled market asset; disabled assets do not appear in market synchronization, backfill, cursor coverage, or market-job progress.
59. Keyboard inspection toggles off on a second click or Escape and consumes Arrow/Home/End keys while active.
60. All displayed timestamps use `YYYY-MM-DD, HH:mm` in 24-hour time.
61. Accessible event details are searchable and paginated instead of rendering an unbounded card list.
62. Enabling a market asset immediately selects it and queues supported initial history.
63. Enabled market assets automatically receive provider-supported history toward 90-day hourly, two-year daily, and five-year weekly targets without discarding one-sample provider buckets or repeatedly requesting unsupported depth.
64. Kraken known value explicitly excludes unpriced balances and reports priced non-zero balances as both a count and a rounded percentage.
65. Kraken imports current Earn allocation fields, repairs previously blank allocation identities on refresh, and classifies suffixed staked balances under Earn.
66. Kraken charts expose a persisted total toggle and one persisted toggle per held canonical asset; saved Dashboard charts retain those selections.
67. A full refresh applies the last-known root content width before first paint and reconciles it with database settings.

## 24. Implementation Order

Recommended delivery sequence:

1. Workspace, configuration, logging, build metadata, database abstraction, Docker runtime, two-process launcher, and proxy.
2. Authentication, sessions, CSRF, trusted headers, signed identity, and application shell.
3. Shared graph primitives, normalized comparison, volume, event markers, graph exports, settings, and fixture-backed series API.
4. Top-100 market asset catalog, lifecycle rules, provider adapters, configurable historical cache, synchronization jobs and progress, disagreement marking, and Combined source.
5. Bitcoin address tracking and combined address graph.
6. Ethereum/ERC-20 address tracking.
7. Solana/SPL address tracking.
8. Kraken spot import, balances, snapshots, and portfolio graph.
9. Kraken Earn/staking and margin surfaces.
10. Owned-transfer reconciliation and cost-basis estimates.
11. Dashboard graph/layout personalization, configurable tables, complete application export, storage diagnostics, completeness coverage, and final hardening.

Each phase must preserve the strict read-only integration boundary.
