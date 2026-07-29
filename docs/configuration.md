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

## MCP sidecar

MCP is a standalone subproject and Compose sidecar. Its public configuration is loaded from `CRYPTOTRACKER_MCP_CONFIG_PATH`; client and upstream keys are loaded from `CRYPTOTRACKER_MCP_SECRETS_PATH`. The checked-in examples are `mcp/config.example.json5` and `mcp/secrets.example.json5`.

`enabled: false` or `CRYPTOTRACKER_MCP_ENABLED=false` opens no MCP listeners. HTTP and HTTPS are independently controlled through `mcp.http` and `mcp.https`; HTTPS defaults to port 8193 and HTTP is opt-in on port 8195. The sidecar’s `upstream.baseUrl` may select API HTTP (`http://cryptotracker:8192`) or API HTTPS (`https://cryptotracker:8194`). When HTTPS is selected, keep `upstream.verifyTls` enabled and point `upstream.caCertPath` to the shared certificate.

MCP has two separate secret groups:

- `upstreamApiKey` or `upstreamApiKeyFile` authenticates the sidecar to the CryptoTracker API.
- `clientApiKeys` contains named `read` or `readwrite` Bearer keys for MCP clients.

The upstream key must be configured in the API’s `secrets.apiKeys` and must differ from every client key. Compose can supply the same upstream value to both processes through `CRYPTOTRACKER_MCP_UPSTREAM_API_KEY`.

Common sidecar overrides include `CRYPTOTRACKER_MCP_ENABLED`, `CRYPTOTRACKER_MCP_READ_ONLY`, `CRYPTOTRACKER_MCP_HTTP_ENABLED`, `CRYPTOTRACKER_MCP_HTTP_PORT`, `CRYPTOTRACKER_MCP_HTTPS_ENABLED`, `CRYPTOTRACKER_MCP_HTTPS_PORT`, `CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL`, `CRYPTOTRACKER_MCP_UPSTREAM_VERIFY_TLS`, `CRYPTOTRACKER_MCP_UPSTREAM_CA_CERT_PATH`, `CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS`, and `CRYPTOTRACKER_MCP_READWRITE_CLIENT_API_KEYS`. The complete list is in `mcp/.env.example`.

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
