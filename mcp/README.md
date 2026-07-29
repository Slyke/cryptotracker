# CryptoTracker MCP sidecar

This subproject is a standalone Streamable HTTP MCP server for the CryptoTracker API. It runs in a separate process/container, owns no application database, and can be disabled without affecting the WUI or API.

## Trust boundaries

Authentication is intentionally split:

1. MCP clients send a named client API key as `Authorization: Bearer <key>`. Each key has a `read` or `readwrite` role.
2. The MCP sidecar sends a different dedicated API key to CryptoTracker through the configured upstream header, `X-API-Key` by default.

The upstream key and client keys must not be reused. Keys may be supplied inline by secret environment variables or loaded from files. Comparisons of client keys use SHA-256 digests and timing-safe equality.

## Configuration

Copy `config.example.json5` to `config.json5` and `secrets.example.json5` to `secrets.json5`, then replace every placeholder secret:

```bash
cp config.example.json5 config.json5
cp secrets.example.json5 secrets.json5
npm ci
npm run dev
```

Set `CRYPTOTRACKER_MCP_CONFIG_PATH` and `CRYPTOTRACKER_MCP_SECRETS_PATH` when the files live elsewhere. Every setting has an environment override; `.env.example` lists the common deployment variables. Environment values take precedence over files.

`enabled: false` or `CRYPTOTRACKER_MCP_ENABLED=false` disables MCP completely and opens no listener. The sidecar process remains idle so Compose does not enter a restart loop.

HTTPS is enabled by default on port `8193`. Plaintext HTTP is disabled by default and can be enabled independently on port `8195` for a trusted development network:

```env
CRYPTOTRACKER_MCP_HTTP_ENABLED=true
CRYPTOTRACKER_MCP_HTTPS_ENABLED=false
```

Both transports may be enabled simultaneously when they use different ports.

The sidecar can call either API listener:

```env
# Local/Compose development
CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL=http://cryptotracker:8192

# TLS-protected deployment hop
CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL=https://cryptotracker:8194
CRYPTOTRACKER_MCP_UPSTREAM_VERIFY_TLS=true
CRYPTOTRACKER_MCP_UPSTREAM_CA_CERT_PATH=/app/data/certs/server.crt
```

Compose mounts the same `cryptotracker-certs` volume into both containers. The generated certificate includes `localhost`, `cryptotracker`, and `cryptotracker-mcp` subject alternative names. Replace the certificate and key in that volume with operator-managed material for non-local deployments.

## Client configuration

```json
{
  "mcpServers": {
    "cryptotracker": {
      "type": "http",
      "url": "https://localhost:8193/mcp",
      "headers": {
        "Authorization": "Bearer ${CRYPTOTRACKER_MCP_CLIENT_API_KEY}"
      }
    }
  }
}
```

The certificate is self-signed by default, so the MCP client must trust it. Do not disable certificate verification outside isolated development.

## Tools

Compatibility and service tools:

- `api_catalog`
- `api_read`
- `api_write` — readwrite clients only; `apply` defaults to `false`
- `mcp_history_search` — searches bounded redacted mutation history

Read-only focused tools:

- `cryptotracker_me_get`
- `cryptotracker_settings_get`
- `cryptotracker_providers_status_get`
- `cryptotracker_sync_progress_get`
- `cryptotracker_diagnostics_storage_get`
- `cryptotracker_jobs_get`
- `cryptotracker_jobs_by_id_get`
- `cryptotracker_catalog_assets_get`
- `cryptotracker_watchlist_assets_get`
- `cryptotracker_watchlist_currencies_get`
- `cryptotracker_market_series_get`
- `cryptotracker_market_metrics_get`
- `cryptotracker_portfolio_series_get`
- `cryptotracker_addresses_get`
- `cryptotracker_addresses_networks_get`
- `cryptotracker_addresses_holdings_get`
- `cryptotracker_addresses_series_get`
- `cryptotracker_kraken_status_get`
- `cryptotracker_kraken_summary_get`
- `cryptotracker_kraken_holdings_get`
- `cryptotracker_kraken_earn_get`
- `cryptotracker_kraken_earn_series_get`
- `cryptotracker_kraken_activity_get`
- `cryptotracker_kraken_pnl_get`
- `cryptotracker_kraken_series_get`
- `cryptotracker_exports_series_csv_get`
- `cryptotracker_exports_series_json_get`
- `cryptotracker_exports_application_by_id_get`
- `cryptotracker_exports_application_by_id_download_get` — readwrite clients only, with `confirmSensitiveDownload: true`

Mutating focused tools:

- `cryptotracker_settings_patch`
- `cryptotracker_catalog_refresh_post`
- `cryptotracker_watchlist_assets_post`
- `cryptotracker_watchlist_assets_bulk_post`
- `cryptotracker_watchlist_assets_by_id_patch`
- `cryptotracker_watchlist_assets_by_id_delete`
- `cryptotracker_watchlist_currencies_put`
- `cryptotracker_market_backfill_post`
- `cryptotracker_market_repair_post`
- `cryptotracker_addresses_post`
- `cryptotracker_addresses_by_id_patch`
- `cryptotracker_addresses_by_id_delete`
- `cryptotracker_addresses_by_id_assets_put`
- `cryptotracker_addresses_by_id_refresh_post`
- `cryptotracker_kraken_refresh_post`
- `cryptotracker_exports_application_post`

Mutation tools are registered only for `readwrite` client identities when `readOnly` is false. Every mutation defaults to dry-run. Destructive operations additionally require `confirm: true`. No exchange-side mutation endpoint or tool exists.

## Health, history, and limits

- `/healthz` reports sidecar process health and build metadata.
- `/readyz` optionally verifies the upstream API key through `/api/me`.
- `/mcp` accepts stateless Streamable HTTP POST requests.

Mutation history is stored in `history.path`, mode `0600`, and capped by `history.maxEntries`. Arguments are redacted before persistence. Read, write, and destructive fixed-window rate limits are isolated by named client identity.

## Verification

```bash
npm ci
npm run check
npm test
npm run build
docker build -t cryptotracker-mcp:local .
```
