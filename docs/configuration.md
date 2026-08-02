# Configuration

CryptoTracker loads optional JSON5 config and secrets files, applies explicit environment overrides,
validates recognized fields, and then starts. Invalid recognized values fail startup; unrecognized
object keys are ignored by the current schema and should not be used for forward compatibility.

## Generic environment references

Any JSON5 string value in either file can reference an environment variable by using the reference as its complete value:

```json5
{
  kraken: {
    apiKey: "${KRAKEN_API_KEY}",
    apiSecret: "${KRAKEN_API_SECRET}",
  },
}
```

References are resolved recursively in objects and arrays before schema validation. An unset variable resolves to JSON `null`. A variable that is present but empty resolves to an empty string. Other values are inserted unchanged as strings; interpolation does not coerce numbers or booleans. Only complete-value references are expanded, so `prefix-${NAME}` remains literal text. The explicit `CRYPTOTRACKER_*` overrides documented below are applied afterward and retain higher precedence. Those direct aliases remain because the original specification requires them; new file-backed mappings should normally use `${ENV_VAR}` references instead of adding another one-to-one override.

When using Docker Compose, an optional `.env` file in the repository root is loaded into the CryptoTracker service. Compose continues normally if the file does not exist. The file is excluded from both Git and the Docker build context.

Use:

- `config/examples/cryptotracker.config.example.json5`
- `config/examples/cryptotracker.header-auth.example.json5`
- `config/examples/cryptotracker.secrets.example.json5`

Credentials belong only in the secrets file or secret environment variables. Credential changes require a restart.

## JSON5 setting reference

The checked-in example contains a runnable configuration. Omitted fields use the schema defaults
below; unrecognized fields have no effect.

### Runtime, WUI, and interface defaults

| Path | Default | Meaning |
|---|---|---|
| `appName` | `CryptoTracker` | Public application name. |
| `publicBaseUrl` | `http://localhost:8192` | Canonical browser origin used for secure-cookie and Origin/CSRF decisions. |
| `api.host` / `api.port` | `0.0.0.0` / `8192` | HTTP API and WUI-ingress listener. |
| `api.trustProxy` | `false` | Enables Express proxy-address handling; it does not expand trusted-header CIDRs. |
| `api.bodyLimit` | `256kb` | JSON request-body limit. Binary restore has a separate limit. |
| `api.https.*` | disabled, port `8194` | API/health-only HTTPS listener and its certificate behavior. |
| `wui.upstreamBaseUrl` | `http://127.0.0.1:3000` | Fixed internal SvelteKit origin used by ingress. |
| `wui.healthPath` | `/wui-health` | Internal readiness path; must begin with `/`. |
| `wui.timeoutMs` | `10000` | WUI health/proxy timeout. |
| `ui.locale` / `ui.timezone` | `en-CA` / `America/Vancouver` | Initial user setting and display-time context. |
| `ui.defaultTheme` / `defaultFont` / `defaultContentWidth` | `dark` / `ui-mono` / `standard` | First-user appearance defaults. Width accepts `min`, `1080`, `standard`, `1440`, `1920`, or `full`. |
| `ui.defaultPrimaryCurrency` | `CAD` | Initial three-letter primary currency. |
| `ui.defaultTooltipCurrencies` | `["CAD"]` | Initial one-to-five display currencies. |
| `ui.defaultMarketSource` | `combined` | `combined`, `coingecko`, `coinbase`, or `kraken`. |
| `ui.defaultProviderDisagreementThresholdPercent` | `5` | Combined-price dispute threshold, from 0 through 1000. |
| `ui.defaultWatchedAssets` | `["bitcoin"]` | Canonical assets enabled during bootstrap. |
| `ui.defaultCostBasisMethod` | `acb` | `acb`, `fifo`, or `lifo`. |

These `ui` values seed database-backed user settings; later config-file changes do not overwrite
preferences that have already been saved.

### Authentication and database

| Path | Default | Meaning |
|---|---|---|
| `auth.apiKey.enabled` / `headerName` | `false` / `X-API-Key` | Enables named REST API keys. The header must be a dedicated valid HTTP token. |
| `auth.local.enabled` / `username` / `sessionTtlMinutes` | `true` / `admin` / `1440` | Single local account and session lifetime. |
| `auth.header.enabled` | `false` | Enables trusted direct-peer identity headers. |
| `auth.header.trustedCidrs` | loopback CIDRs | Exact direct peers allowed to assert identity. |
| `auth.header.usernameHeader` / `groupsHeader` / `groupsSeparator` | `Remote-User` / `Remote-Groups` / `,` | Plain trusted identity parsing. |
| `auth.header.allowedUsers` / `allowedGroups` | empty | Case-insensitive OR allowlist. At least one entry is required when header auth is enabled. |
| `auth.header.signedIdentity.*` | disabled | HS256 header, issuer, audience, 0–300 second clock skew, and 60–31,536,000 second maximum token lifetime. |
| `database.sqlite.busyTimeoutMs` / `synchronous` | `5000` / `FULL` | SQLite lock wait and durability (`OFF`, `NORMAL`, `FULL`, or `EXTRA`). |
| `database.postgres` | `null` | Host, port, database, user, pool maximum, TLS enablement, and certificate verification. Required in Postgres mode. |
| `cache.redis.enabled` | `false` | Enables the optional shared saved-dashboard graph materialization cache. PostgreSQL remains the source of truth. |
| `cache.redis.url` / `keyPrefix` | `redis://redis:6379` / `cryptotracker` | Redis endpoint and namespace shared by every API replica. |
| `cache.redis.resultTtlSeconds` | `2592000` | Hard expiry for materialized responses, registered plans, and dashboard activity. |
| `cache.redis.connectTimeoutMs` | `2000` | Redis connection timeout before a request falls through to PostgreSQL. |

API-key entries in the secrets file have unique names, a minimum 16-character key, and a `read` or
`readwrite` role. An entry may use `keyFile`; it is resolved and normalized before the runtime
secrets schema is validated.

### Providers, scheduling, exports, and logging

| Path | Default | Meaning |
|---|---|---|
| `providers.market.{coinGecko,coinbase,kraken}` | enabled official URLs | Market adapter enablement, fixed base URL, and independent rate policy. |
| `providers.chains.bitcoin` | Esplora, 6 confirmations | Bitcoin mainnet history. |
| `providers.chains.dogecoin` | BlockCypher, 6 confirmations | Dogecoin mainnet history. |
| `providers.chains.ethereum` | Etherscan + public RPC, chain 1, 12 confirmations | Native/ERC-20 history plus current balance sampling. |
| `providers.chains.polkadot` | Subscan | Polkadot mainnet history; secret key required for availability. |
| `providers.chains.solana` | Helius `mainnet-beta` | Native/SPL mainnet history; secret key required. |
| `sync.pollMinutes` | `30` | Retained compatibility setting. The current scheduler checks once per minute; database-backed per-integration polling preferences decide when work is due. |
| `sync.maxConcurrentJobs` | `2` | In-process worker concurrency, 1–16. |
| `sync.staleAfterMinutes` | `90` | Cached-data stale threshold. |
| `sync.overlapBuckets` | `3` | Recent buckets repeated to repair revisions. |
| `exports.directory` / `artifactTtlHours` | `/app/data/exports` / `24` | Complete-backup artifact location and expiry. |
| `exports.restoreBodyLimit` | `128mb` | Compressed ZIP request limit. |
| `exports.restoreMaxUncompressedBytes` | `536870912` | Independent expanded archive-content ceiling. |
| `logging.logTextFormat` | documented schema default | Template for text sinks. |
| `logging.sinks` | console text enabled | Console, file, HTTP, and UDP/TCP/TLS syslog destinations with enablement, format, and level filters. |
| `logging.gates` | `{}` | Named event gates that can override level and per-sink routing. |
| `logging.kubernetes.enabled` | `false` | Adds Kubernetes-oriented log metadata. |

Every market and chain provider accepts a `rate` object. In addition to the values listed later in
this document, it includes `requestTimeoutMs` (1–300 seconds). CoinGecko uses a more conservative
default spacing/burst/refill policy than the generic provider default.

### Secrets fields

| Path | Required when |
|---|---|
| `sessionSecret` | Local or trusted-header browser access is enabled. Use a high-entropy value of at least 32 characters; the current schema requires a non-empty value but does not enforce that recommendation. |
| `localPassword` | Local authentication is enabled. |
| `signedIdentitySecret` | Signed trusted identity is enabled. |
| `apiKeys[]` | REST/MCP-upstream API-key access is enabled. |
| `providers.coinGeckoApiKey` | Optional higher CoinGecko allowance. |
| `providers.blockCypherApiToken` | Optional higher Dogecoin allowance. |
| `providers.etherscanApiKey` | Ethereum/ERC-20 historical transactions. |
| `providers.heliusApiKey` | Solana/SPL history. |
| `providers.subscanApiKey` | Polkadot history. |
| `kraken.apiKey` and `kraken.apiSecret` | Kraken account integration; both or neither. |
| `postgresPassword` | PostgreSQL mode. |
| `redisPassword` | Optional when Redis caching is enabled; omit it for an unauthenticated in-cluster Redis service. |

### Optional Redis dashboard graph cache

Redis is an optional L2 cache for saved chart requests across every dashboard index. A dashboard
request registers the current chart query settings and refreshes a shared activity timestamp. Cache
misses, expired entries, connection failures, and setting revisions all fall through to PostgreSQL;
Redis is never treated as authoritative data.

While a dashboard is active, successful scheduled or manual synchronization jobs refresh only
registered plans affected by graph-visible database changes. Warming stops after the database-backed
dashboard inactivity preference (60 minutes by default) and resumes on the next dashboard request.
The first request after an inactive window intentionally invalidates the old materializations so it
may be slower while current values are rebuilt.

Direct deployment overrides are `CRYPTOTRACKER_REDIS_ENABLED`, `CRYPTOTRACKER_REDIS_URL`,
`CRYPTOTRACKER_REDIS_KEY_PREFIX`, `CRYPTOTRACKER_REDIS_RESULT_TTL_SECONDS`,
`CRYPTOTRACKER_REDIS_CONNECT_TIMEOUT_MS`, and `CRYPTOTRACKER_REDIS_PASSWORD`.

## File selection and database

| Variable | Meaning | Default |
|---|---|---|
| `CRYPTOTRACKER_CONFIG_PATH` | JSON5 config path | no file |
| `CRYPTOTRACKER_SECRETS_PATH` | JSON5 secrets path | no file |
| `CRYPTOTRACKER_DB_KIND` | `sqlite` or `postgres` | `sqlite` |
| `CRYPTOTRACKER_SQLITE_PATH` | SQLite database path | `./data/cryptotracker.sqlite` |
| `CRYPTOTRACKER_POSTGRES_PASSWORD` | PostgreSQL password | secret file value |
| `CRYPTOTRACKER_MIGRATIONS_PATH` | Packaging/test override containing `sqlite/` and `postgres/` migration directories | built-in repository/image path |

Postgres host, port, database, user, pool maximum, TLS, and certificate verification are configured under `database.postgres`.

## General and WUI overrides

| Variable | Config target |
|---|---|
| `CRYPTOTRACKER_PUBLIC_BASE_URL` | `publicBaseUrl` |
| `CRYPTOTRACKER_API_HOST` | `api.host` |
| `CRYPTOTRACKER_API_PORT` | `api.port` |
| `CRYPTOTRACKER_WUI_UPSTREAM_BASE_URL` | `wui.upstreamBaseUrl` |
| `CRYPTOTRACKER_DEFAULT_LOCALE` | `ui.locale` |
| `CRYPTOTRACKER_DEFAULT_TIMEZONE` | `ui.timezone` |
| `CRYPTOTRACKER_DEFAULT_PRIMARY_CURRENCY` | `ui.defaultPrimaryCurrency` |
| `CRYPTOTRACKER_DEFAULT_MARKET_SOURCE` | `ui.defaultMarketSource` |
| `LOG_K8S_METADATA_ENABLED` | `logging.kubernetes.enabled` |

The production launcher also accepts `CRYPTOTRACKER_WUI_HOST`, `CRYPTOTRACKER_WUI_PORT`, and `BUILD_INFO_PATH`.

## Authentication overrides

| Variable | Meaning |
|---|---|
| `CRYPTOTRACKER_API_KEY_ENABLED` | Enable API-key authentication for REST |
| `CRYPTOTRACKER_API_KEY_HEADER` | REST API-key header name; defaults to `X-API-Key` |
| `CRYPTOTRACKER_API_KEY` | One API-key secret supplied directly by the environment |
| `CRYPTOTRACKER_API_KEY_FILE` | File containing the direct API-key secret; mutually exclusive with `CRYPTOTRACKER_API_KEY` |
| `CRYPTOTRACKER_API_KEY_NAME` | Audit identity for the direct environment API key |
| `CRYPTOTRACKER_API_KEY_ROLE` | `read` or `readwrite`; defaults to the safer `read` role for the direct override |
| `CRYPTOTRACKER_HTTPS_PORT` | API HTTPS listener port; defaults to `8194` |
| `CRYPTOTRACKER_AUTH_LOCAL_ENABLED` | Enable local authentication |
| `CRYPTOTRACKER_AUTH_LOCAL_USERNAME` | Local username |
| `CRYPTOTRACKER_AUTH_LOCAL_PASSWORD` | Local password secret |
| `CRYPTOTRACKER_SESSION_SECRET` | Session signing secret; use at least 32 high-entropy characters |
| `CRYPTOTRACKER_AUTH_HEADER_ENABLED` | Enable trusted-header authentication |
| `CRYPTOTRACKER_AUTH_HEADER_TRUSTED_CIDRS` | Comma-separated direct-peer CIDRs |
| `CRYPTOTRACKER_AUTH_HEADER_USERNAME_HEADER` | Identity header |
| `CRYPTOTRACKER_AUTH_HEADER_GROUPS_HEADER` | Groups header |
| `CRYPTOTRACKER_AUTH_HEADER_GROUPS_SEPARATOR` | Group separator |
| `CRYPTOTRACKER_AUTH_HEADER_ALLOWED_USERS` | Comma-separated allowed users |
| `CRYPTOTRACKER_AUTH_HEADER_ALLOWED_GROUPS` | Comma-separated allowed groups |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ENABLED` | Require signed identity assertion |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_HEADER` | Signed assertion header |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ISSUER` | Expected issuer |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_AUDIENCE` | Expected audience |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_SECRET` | HMAC secret |
| `CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_MAX_TTL_SECONDS` | Maximum accepted `exp - iat`, from 60 seconds through one year |

Allowed users and allowed groups use OR semantics. Never trust identity headers from an Internet-facing peer; restrict `trustedCidrs` to the directly connected authentication proxy.

Multiple named API keys can be declared in the API secrets file under `apiKeys`. Each entry accepts either an inline `key` or a `keyFile`; relative key-file paths resolve from the secrets-file directory. API-key comparisons hash both values before timing-safe comparison. Read keys can call GET APIs. Readwrite keys may also call local application mutations. The MCP sidecar must use a dedicated entry here for its upstream calls; client-facing MCP keys are configured separately and must not reuse the upstream value.

## HTTPS

`api.https` controls the API’s additional TLS listener:

- `enabled`
- `port`
- `certPath`
- `keyPath`
- `generateSelfSigned`

The normal browser/WUI and local API listener remains HTTP on `api.port` (8192 by default), which keeps local testing unchanged. The example enables API HTTPS on port 8194. Both listeners expose the same authenticated `/api/*` routes and can be enabled independently. Mounted certificate files take precedence; when either file is missing and `generateSelfSigned` is true, CryptoTracker creates a shared certificate and private key under `/app/data/certs`. For a trusted hostname, mount an operator-managed certificate whose SAN contains that hostname and set `generateSelfSigned` to false.

Direct overrides are available as `CRYPTOTRACKER_HTTPS_ENABLED`, `CRYPTOTRACKER_HTTPS_PORT`, `CRYPTOTRACKER_HTTPS_CERT_PATH`, `CRYPTOTRACKER_HTTPS_KEY_PATH`, and `CRYPTOTRACKER_HTTPS_GENERATE_SELF_SIGNED`.

Compose uses `CRYPTOTRACKER_SHARED_CERT_PATH` and `CRYPTOTRACKER_SHARED_KEY_PATH` as interpolation
inputs for all three services. The one-shot certificate-generator container receives those resolved
values as `CRYPTOTRACKER_CERT_PATH` and `CRYPTOTRACKER_KEY_PATH`; those two names configure the
generator helper, not the API listener.

## MCP sidecar

MCP is a standalone subproject and Compose sidecar. Its public configuration is loaded from `CRYPTOTRACKER_MCP_CONFIG_PATH`; client and upstream keys are loaded from `CRYPTOTRACKER_MCP_SECRETS_PATH`. The checked-in examples are `mcp/config.example.json5` and `mcp/secrets.example.json5`.

`enabled: false` or `CRYPTOTRACKER_MCP_ENABLED=false` opens no MCP listeners. HTTP and HTTPS are independently controlled through `mcp.http` and `mcp.https`; HTTPS defaults to port 8193 and HTTP is opt-in on port 8195. The sidecar’s `upstream.baseUrl` may select API HTTP (`http://cryptotracker:8192`) or API HTTPS (`https://cryptotracker:8194`). When HTTPS is selected, keep `upstream.verifyTls` enabled and point `upstream.caCertPath` to the shared certificate.

MCP has two separate secret groups:

- `upstreamApiKey` or `upstreamApiKeyFile` authenticates the sidecar to the CryptoTracker API.
- `clientApiKeys` contains named `read` or `readwrite` Bearer keys for MCP clients.

The upstream key must be configured in the API’s `secrets.apiKeys` and must differ from every client key. Compose can supply the same upstream value to both processes through `CRYPTOTRACKER_MCP_UPSTREAM_API_KEY`.

Common sidecar overrides include `CRYPTOTRACKER_MCP_ENABLED`, `CRYPTOTRACKER_MCP_READ_ONLY`, `CRYPTOTRACKER_MCP_HTTP_ENABLED`, `CRYPTOTRACKER_MCP_HTTP_PORT`, `CRYPTOTRACKER_MCP_HTTPS_ENABLED`, `CRYPTOTRACKER_MCP_HTTPS_PORT`, `CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL`, `CRYPTOTRACKER_MCP_UPSTREAM_VERIFY_TLS`, `CRYPTOTRACKER_MCP_UPSTREAM_CA_CERT_PATH`, `CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS`, and `CRYPTOTRACKER_MCP_READWRITE_CLIENT_API_KEYS`. The complete list is in `mcp/.env.example`.

## Provider secret environment variables

The checked-in secrets examples map all of these names with whole-value `${ENV_VAR}` references.
CoinGecko, Etherscan, Helius, Kraken, and PostgreSQL also have direct loader overrides; custom
secrets files must explicitly reference the BlockCypher and Subscan names.

| Variable | Secret |
|---|---|
| `CRYPTOTRACKER_COINGECKO_API_KEY` | Optional CoinGecko demo key |
| `CRYPTOTRACKER_BLOCKCYPHER_API_TOKEN` | Optional BlockCypher token; Dogecoin public reads work without it at lower limits |
| `CRYPTOTRACKER_ETHERSCAN_API_KEY` | Optional Etherscan key |
| `CRYPTOTRACKER_HELIUS_API_KEY` | Optional Helius key |
| `CRYPTOTRACKER_SUBSCAN_API_KEY` | Subscan key required to enable Polkadot address history |
| `CRYPTOTRACKER_KRAKEN_API_KEY` | Kraken Spot API key |
| `CRYPTOTRACKER_KRAKEN_API_SECRET` | Kraken Spot API secret |

Chain-history credentials are per network, not per asset: one Etherscan key covers ETH and selected
ERC-20 assets such as SHIB, and one Helius key covers SOL and selected SPL assets. Subscan covers
DOT. The bundled Kraken, Coinbase Exchange, and CoinGecko integrations provide market prices and
cannot reconstruct arbitrary public-address history. Coinbase CDP Address History is a separate,
authenticated product and is not the same integration as the keyless Coinbase Exchange candle
source used here.

Kraken requires both values or neither. Create a dedicated query-only Spot key with exactly these permissions:

- Query Funds
- Query Open Orders & Trades
- Query Closed Orders & Trades
- Query Ledger Entries

Leave every other permission disabled, including Deposit Funds, Withdraw Funds, Earn Funds, Create & Modify Orders, Cancel & Close Orders, Export Data, and the WebSocket interface. CryptoTracker reads current Earn allocations with Query Funds; it never needs the write-capable Earn Funds permission.

If permission inspection reports any permission outside the query-only allowlist, Kraken activation is refused. Edit the key in Kraken Pro under **Settings → API**, save it, and restart CryptoTracker so the key can be inspected again.

## Rate limits and logging

Each provider has a `rate` object:

- `minimumSpacingMs`
- `concurrency`
- `burst`
- `refillPerSecond`
- `maxRetries`
- `baseBackoffMs`
- `cooldownThreshold`
- `cooldownMs`

Logging supports console, file, HTTP, and UDP/TCP/TLS syslog sinks. Each sink has an enable flag, format, and level filter. Named logging gates can override level and per-sink routing for expensive or sensitive diagnostics. File and HTTP destinations are required when those sinks are enabled.
