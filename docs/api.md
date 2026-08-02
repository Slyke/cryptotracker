# HTTP API reference

The browser WUI, REST clients, and MCP sidecar use the same API service. The HTTP listener serves the
WUI, API, authentication, and health routes. The optional HTTPS listener serves only `/api/*` and
health routes; it does not serve login or the WUI.

## Conventions

All `/api/*` routes require one of:

- a local session cookie;
- an allowed trusted-header identity;
- a named API key in the configured API-key header (`X-API-Key` by default) or as a Bearer token.

Local and trusted-header mutations require an exact `Origin` matching `publicBaseUrl` and the
`X-CSRF-Token` returned by `GET /api/me`. A `readwrite` API key may mutate without browser
Origin/CSRF headers; a `read` key receives `403`. Public health and authentication-discovery routes
do not require authentication.

JSON success responses use `{ "ok": true, ... }`. JSON errors use:

```json
{
  "ok": false,
  "error": {
    "key": "stable_internal_key",
    "code": "CTR-0000",
    "message": "Human-readable message.",
    "correlationId": "request-id"
  }
}
```

Every response includes `X-Correlation-Id`; a valid incoming ID is preserved. Decimal quantities and
prices are strings. Times are ISO 8601 UTC strings in object payloads or UTC epoch milliseconds in
compact chart points. List ordering is deterministic unless a route explicitly describes newest
first. JSON request bodies are limited by `api.bodyLimit`.

Comma-separated query values must be URL encoded. `from`/`to` are UTC epoch milliseconds and
granularity values are seconds.

## Health and authentication

| Method and path | Authentication | Input and behavior |
|---|---|---|
| `GET /health` | Public | Process health, version, and build hash. |
| `GET /healthz` | Public | Alias of `/health`. |
| `GET /readyz` | Public | `200` only when the database/migrations/config and internal WUI check succeed; otherwise `503`. |
| `GET /auth/methods` | Public | Enabled local, trusted-header, signed-identity, and API-key methods. |
| `POST /auth/local/login` | Public, exact Origin | JSON `{ username, password }`; creates/rotates a local session and returns its CSRF token and expiry. Invalid attempts are audited and repeatedly failing identity/IP pairs are throttled. |
| `POST /auth/logout` | Authenticated mutation | Invalidates the local session where present and clears the session cookie. |
| `GET /api/me` | Authenticated | Identity, groups, auth method, CSRF token, build metadata, and non-secret runtime/provider enablement. |
| `ALL /mcp` | Public | Always `404 MCP_SIDECAR_REQUIRED`; MCP is served by the separate sidecar. |

## Settings, status, and jobs

| Method and path | Input | Result |
|---|---|---|
| `GET /api/settings` | None | Complete database-backed user settings. |
| `PATCH /api/settings` | Strict partial settings object | Saves supplied fields only. Supports locale/timezone, theme/font/content width, currencies, market source, disagreement threshold, cost-basis method, graph/page/accordion/table preferences, saved Dashboard items/rows, saved calculations, dismissed notices, market-history backfill depth, retention, failed-job retention, and per-integration polling. Applying a retention field also prunes the selected eligible records. |
| `GET /api/providers/status` | None | Provider enablement, health, contribution/cooldown, and Kraken permission state. |
| `GET /api/sync/progress` | `failedQuery?`, `failedType?`, `failedPage=1`, `failedPageSize=10` (`10`, `20`, `50`, or `100`) | Generated-at time, active/recent jobs, paginated newest-first terminal failures, market cursors, and Kraken cursors. |
| `GET /api/diagnostics/storage` | None | Database kind/size estimate, category/table row counts, retained ranges, and retention explanation. |
| `GET /api/jobs` | `limit=100`, range `1..500` | Recent jobs. |
| `GET /api/jobs/:id` | Exact job ID | One job or `404`. |

`PATCH /api/settings` accepts these bounded structured collections:

- up to 200 uniquely named saved charts/tables;
- up to 100 uniquely named saved calculations;
- up to 100 Dashboard rows with one to four columns;
- up to 200 dismissed notice IDs;
- up to five tooltip currencies;
- point retention of `null` (Forever) or 1–36,500 days;
- automatic market-history backfill depth of `null` (maximum provider-available) or 1–36,500 days; the default is 1,825 days;
- failed-job retention of `null` or 1–87,600 hours; the default is 720 hours (one month);
- polling intervals of 5–10,080 minutes.

## Catalog, watchlist, market, and portfolio

| Method and path | Input | Result |
|---|---|---|
| `GET /api/catalog/assets` | `q?`, `limit=100` (`1..500`) | Searchable cached asset catalog. |
| `POST /api/catalog/refresh` | Empty JSON | `202`; queues a top-100 CoinGecko catalog refresh. |
| `GET /api/watchlist/assets` | None | Watched assets and enabled state. |
| `POST /api/watchlist/assets` | `{ canonicalId }` | `201`; adds or re-enables one catalog asset and admits initial sync work. |
| `POST /api/watchlist/assets/bulk` | `{ limit: 10\|25\|50\|100 }` | `201`; API-only bulk add/enable operation. The WUI deliberately exposes individual enablement only. |
| `PATCH /api/watchlist/assets/:id` | `{ enabled: boolean }` | Updates enablement. Disabling cancels pending market work but retains shared cache. |
| `DELETE /api/watchlist/assets/:id` | Exact watchlist row ID | `204`; removes the watchlist row without deleting shared market history. |
| `GET /api/watchlist/currencies` | None | Primary and tooltip currencies. |
| `PUT /api/watchlist/currencies` | `{ primaryCurrency, tooltipCurrencies[1..5] }` | Saves the normalized three-letter codes. |
| `GET /api/market/series` | Required `assetIds`, `from`, `to`; optional `quoteCurrency=CAD`, `source=combined`, `granularity=auto`, `chartMode=line` | Cached market series, candles/points, resolved granularity, provenance, events, quality flags, and missing intervals. Explicit granularities retain sparse older coarse observations and use finer cached observations where available, which supports zooming without fabricating points. `from` must be less than `to`; extremely large range/resolution combinations are rejected. |
| `GET /api/market/metrics` | `assetIds`, `quoteCurrencies=CAD`; capped at 100 assets and six currencies | Current prices and configured change periods for balance tables. |
| `GET /api/portfolio/series` | Required `from`, `to`; optional `quoteCurrencies` (up to six), `granularitySeconds=auto` | Locally observed combined address/Kraken portfolio value, event markers, every activated asset denomination, resolved overview granularity, and quality flags. USD is always loaded as an internal reserve quote; `denominationFallbacks` marks points derived through it. `from=0` requests all retained history; long fine-detail requests are bucketed before snapshots and price rows are loaded. |
| `POST /api/market/backfill` | `{ provider, canonicalAssetId, quoteCurrency, fromMs, toMs, granularitySeconds }` | `202`; queues missing supported provider history. |
| `POST /api/market/repair` | Same as backfill | `202`; queues an explicit overlapping repair. |

`provider` is `coingecko`, `coinbase`, or `kraken`. A market source is `combined` or one of those
providers. `chartMode` is `line` or `candlestick`.

The market, portfolio, address, Kraken, and Kraken Earn series routes retain successful identical
reads for five seconds in a bounded per-API-process cache and coalesce matching in-flight reads.
Each replica owns its cache independently and reads the database through its normal service on a
miss.

## Addresses

| Method and path | Input | Result |
|---|---|---|
| `GET /api/addresses` | None | Tracked addresses, selected assets, completeness, cursors, and warnings. |
| `GET /api/addresses/networks` | None | Mainnets derived from enabled assets, native/token choices, reviewed provider support/reason, and enabled assets without a mapping. |
| `POST /api/addresses` | `{ network, address, label, enabled?, assets? }` | `201`; validates and adds one public mainnet address, then queues supported synchronization. |
| `PATCH /api/addresses/:id` | At least one of `{ label, enabled }` | Updates the local label or enablement. |
| `DELETE /api/addresses/:id` | Exact address ID | `204`; deletes address-specific selections, state, events, and points. |
| `PUT /api/addresses/:id/assets` | `{ assets: [{ canonicalAssetId, contractOrMint }] }` | Replaces optional token selections, resets the provider cursor, and queues a replay. The native asset remains implicit. |
| `POST /api/addresses/:id/refresh` | Empty JSON | `202`; queues a manual read-only refresh or reports that the provider is unavailable. |
| `GET /api/addresses/holdings` | `quoteCurrency=CAD`, optional `quoteCurrencies` (up to six) | Current observed quantities, values, per-currency values, pricing coverage/reason, and history coverage. |
| `GET /api/addresses/series` | Required `from`, `to`; optional `granularitySeconds=auto`, `quoteCurrency=CAD`, `quoteCurrencies` | Individual and combined address series, events, denomination choices, requested/resolved granularity, and quality/completeness. Generated timelines use per-series and whole-response point budgets. |

Networks are `bitcoin`, `dogecoin`, `ethereum`, `polkadot`, and `solana`. An asset selection contains
a nullable contract/mint; service validation enforces the network’s native asset and reviewed token
mapping rules.

## Kraken

| Method and path | Input | Result |
|---|---|---|
| `GET /api/kraken/status` | None | Credential configuration, connection, read-only permission inspection, and import cursors. |
| `POST /api/kraken/refresh` | Empty JSON | `202`; queues query-only account import. Unsafe or incomplete key permissions prevent activation. |
| `GET /api/kraken/summary` | Optional `quoteCurrencies` (up to six) | Known priced value, counts/coverage, per-currency values, section visibility, staleness, and latest sync. |
| `GET /api/kraken/holdings` | None | Current observed balances by raw/canonical asset and category with pricing reason. |
| `GET /api/kraken/earn` | None | Raw latest Earn allocation records. |
| `GET /api/kraken/earn/series` | Required `from`, `to`; optional `granularitySeconds=86400` (minimum 60), `quoteCurrencies` | Earn summary/assets/allocations, reconstructed/exact balance series, locally observed APY series, events/activity, payout distribution, denominations, and coverage messages. |
| `GET /api/kraken/activity` | `limit=200`, range `1..500` | Imported trades and ledger entries. |
| `GET /api/kraken/pnl` | `method=acb`; `acb`, `fifo`, or `lifo` | Informational realised result, basis coverage, lots/dispositions, and incomplete-basis state. Invalid values fall back to ACB. |
| `GET /api/kraken/series` | Required `from`, `to`; optional `quoteCurrencies` (up to six), `granularitySeconds=auto` | Total and per-asset locally observed value series, requested/resolved granularity, denominations, and Kraken/transfer events. Snapshot and price rows are bucketed in the database for bounded long-range overviews. |

No Kraken route places/cancels orders, deposits, withdraws, transfers, changes settings, changes Earn
allocations, or calls Futures.

## Graph data, application backup, and restore

| Method and path | Input | Result |
|---|---|---|
| `GET /api/exports/series.csv` | Same query as `/api/market/series` | Attachment containing the selected market data, decimal values, provenance, quality, range, source, and timezone timestamps. |
| `GET /api/exports/series.json` | Same query as `/api/market/series` | Versioned attachment with build/locale/timezone, filters, series, provenance, quality, exact values, and points. |
| `POST /api/exports/application` | Empty JSON | `202`; creates a persistent streaming ZIP-export job. |
| `GET /api/exports/application/:id` | Export ID | Job status, progress/bytes, completion/error, checksum, downloadability, and expiry. |
| `GET /api/exports/application/:id/download` | Completed export ID | Streamed ZIP attachment with length and `X-Checksum-Sha256`; the download is audited. |
| `POST /api/backups/inspect` | Non-empty `application/zip` or `application/octet-stream` body | Validates archive/manifest/checksums and returns restorable domain names, files, table counts, and row counts without changing data. |
| `POST /api/backups/restore?domains=...&confirmation=replace-selected-data` | Same binary ZIP body | Atomically replaces the selected dependency-safe groups and reports restored rows. |

Restore domains are `preferences`, `markets`, `addresses`, `kraken`, `portfolio`, and `calculations`.
Saved what-if scenarios are within `preferences`; `calculations` contains calculation runs,
cost-basis lots, and internal-transfer matches. At least one archive-present domain is required.
Upload size is limited by `exports.restoreBodyLimit`; expanded content is independently limited by
`exports.restoreMaxUncompressedBytes`. Inspect and restore require browser CSRF or a readwrite API
key. Backup restore is deliberately not exposed through MCP because it is a potentially large binary
replacement workflow.

PNG and SVG snapshots are generated in the browser from the rendered chart and therefore have no
REST route.

## MCP coverage

The standalone sidecar allowlists the JSON-oriented `/api` operations listed in
[`mcp/README.md`](../mcp/README.md). It provides focused tools plus `api_catalog`, `api_read`, and
dry-run-first `api_write`. It does not proxy authentication routes, health routes, browser-generated
PNG/SVG, or binary backup inspect/restore. Complete-export downloads require a readwrite MCP key,
explicit sensitive-download confirmation, and the response-size ceiling.
