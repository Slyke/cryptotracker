# Configuration

CryptoTracker loads optional JSON5 config and secrets files, applies explicit environment overrides, validates the result, and then starts. Unknown or invalid values fail startup.

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

## File selection and database

| Variable | Meaning | Default |
|---|---|---|
| `CRYPTOTRACKER_CONFIG_PATH` | JSON5 config path | no file |
| `CRYPTOTRACKER_SECRETS_PATH` | JSON5 secrets path | no file |
| `CRYPTOTRACKER_DB_KIND` | `sqlite` or `postgres` | `sqlite` |
| `CRYPTOTRACKER_SQLITE_PATH` | SQLite database path | `./data/cryptotracker.sqlite` |
| `CRYPTOTRACKER_POSTGRES_PASSWORD` | PostgreSQL password | secret file value |

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
| `CRYPTOTRACKER_AUTH_LOCAL_ENABLED` | Enable local authentication |
| `CRYPTOTRACKER_AUTH_LOCAL_USERNAME` | Local username |
| `CRYPTOTRACKER_AUTH_LOCAL_PASSWORD` | Local password secret |
| `CRYPTOTRACKER_SESSION_SECRET` | Session signing secret, at least 32 characters |
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

Allowed users and allowed groups use OR semantics. Never trust identity headers from an Internet-facing peer; restrict `trustedCidrs` to the directly connected authentication proxy.

## Provider secret overrides

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
