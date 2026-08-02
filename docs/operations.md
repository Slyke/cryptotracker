# Operations

## Health

- `/health` and `/healthz` report process health, version, and build hash.
- `/readyz` verifies the database, migrations/configuration state, and internal WUI.

The Compose health check uses `/readyz`. Kubernetes uses `/readyz` for readiness and `/healthz` for liveness.

At process startup, the API logs its version/build, runtime, sanitized HTTP targets, database mode and non-secret connection target, optional Redis state, authentication modes, enabled providers, provider credential presence, scheduler settings, logging sinks, and Kubernetes metadata. It then logs database-open, migration, ingress, and scheduler milestones. If startup fails, the final JSON record includes the active startup phase and sanitized application/driver error context. Credential values and URL credentials/query strings are never included.

The production example runs two containers. The application serves the browser and API over HTTP on port 8192 and API HTTPS on port 8194. The MCP sidecar serves HTTPS on port 8193 by default and optionally plaintext HTTP on port 8195. Both containers mount the `cryptotracker-certs` volume. Replace its self-signed material with a trusted certificate for non-local clients.

## REST API and MCP

Named keys in the API `secrets.apiKeys` authenticate REST requests through `X-API-Key`. MCP clients use separate named Bearer keys configured in the sidecar. The sidecar then uses its dedicated upstream API key when calling CryptoTracker. Reusing a client key as the upstream key is rejected at startup.

The exhaustive REST route, input, authentication, response-content, and backup/restore reference is
in [HTTP API reference](api.md). The optional API HTTPS listener serves only `/api/*` and health
routes; browser login and WUI pages remain on the normal HTTP ingress unless an external reverse
proxy supplies browser-facing TLS. `readwrite` REST API keys are non-browser credentials and do not
send Origin/CSRF headers; `read` keys cannot mutate.

The MCP server exposes:

- one focused `cryptotracker_*` tool per allowlisted `/api` operation, with fixed method/path and path-parameter validation;
- `api_catalog` — lists every operation, focused tool name, and safety class;
- `api_read` — compatibility access to any allowlisted GET API with credential redaction;
- `api_write` — compatibility access for planning or applying allowlisted local mutations.

The exhaustive focused-tool list is maintained in `mcp/README.md`. Read identities discover only read tools. Mutation tools are registered only for read/write identities when the sidecar’s `readOnly` setting is false.

Focused tools accept named route parameters directly (for example `id`), optional query values in `query`, and mutation payloads in `body`. Every focused mutation includes `apply`, defaulting to false; destructive tools additionally include `confirm`.

`api_write` defaults to `apply: false`. DELETE calls require `confirm: true`. An MCP read key cannot call mutations or download a complete application export. MCP export downloads require a readwrite key plus `confirmSensitiveDownload: true`. The 20 MiB MCP response ceiling prevents accidentally placing an unbounded archive into model context; larger exports remain available through authenticated REST.

Dry-run and applied MCP writes are recorded in the sidecar’s bounded redacted history. Applied API mutations are also recorded by the API’s database audit log. Named client keys have independent read, write, and destructive fixed-window limits. Set the sidecar’s `readOnly: true` to omit `api_write` and focused mutations from tool discovery entirely.

Binary backup inspection/restore is REST/WUI-only and is intentionally absent from MCP tool
discovery. Complete-export download remains available to a readwrite MCP client only with
`confirmSensitiveDownload: true` and within the 20 MiB response ceiling.

Kraken refresh means “import through the immutable query-only Kraken client.” Neither MCP nor REST implements order placement, cancellation, deposits, withdrawals, staking changes, or any other exchange mutation. Current account state that Kraken does not expose historically is stored in `kraken_account_observations`. Each changed response creates a version; an unchanged response only advances the version's `last_seen_at_ms`, avoiding repeated copies of large recent-transfer lists.

Example REST call:

```bash
curl --insecure \
  -H "X-API-Key: $CRYPTOTRACKER_API_KEY" \
  https://localhost:8194/api/providers/status
```

Example MCP client entry:

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

## Persistence and backups

Canonical data is intentionally retained indefinitely. Operators must monitor database growth and storage capacity. Settings shows row counts, estimated category sizes, and retained time ranges. A finite user-selected retention window removes account observations only after their complete observed-through interval is older than the cutoff.

For SQLite, persist `/app/data`, including the database, WAL, and SHM files. Use a SQLite-aware online backup or stop the application before copying all database files. Do not copy only the main `.sqlite` file while the application is running.

For PostgreSQL, use normal PostgreSQL physical or logical backup tooling and test restores. Protect both database backups and deployment secrets.

Settings can create a streaming ZIP backup and restore selected dependency-safe Preferences,
Markets, Addresses, Kraken, Portfolio, and Calculations JSON data groups present in the archive.
Saved what-if scenarios travel with Preferences; Calculations contains reconciliation and cost-basis
evidence.
Credentials, password hashes, sessions, jobs, audit history, and deployment secrets are always
excluded. Upload inspection validates the manifest, checksums, compressed/expanded size, and group
dependencies without changing data. A confirmed restore atomically replaces every row in the
selected groups, but the ZIP is not a transaction-consistent substitute for SQLite or PostgreSQL
operator backups. Generated download artifacts expire after the configured TTL; canonical rows do
not.

## Production container

The application production image:

- runs as UID/GID 10001;
- uses `tini`;
- exposes HTTP API/WUI port 8192 and HTTPS API port 8194;
- supports a read-only root filesystem;
- writes canonical data only below `/app/data`;
- writes temporary export spool files below `TMPDIR`;
- contains production dependencies only.

The separate MCP image exposes HTTPS port 8193 and optional HTTP port 8195, runs as the same UID/GID 10001, and writes only certificate/history data below `/app/data`.

The Kubernetes example sets `fsGroup: 10001` so fresh persistent volumes and temporary volumes remain writable to the non-root process.

## PostgreSQL

Set `CRYPTOTRACKER_DB_KIND=postgres`, configure `database.postgres`, and supply `CRYPTOTRACKER_POSTGRES_PASSWORD`. Migrations run on startup. A migration failure prevents readiness.

Each PostgreSQL API replica attempts migration before it starts listening. A shared PostgreSQL advisory lock serializes those attempts: one replica applies each pending migration in its own transaction and records it in `schema_migrations`; waiting replicas then re-read the table and skip versions already applied. The lock coordinates migration runners only. It does not prevent an older replica from serving queries while a newer replica changes the schema, so rolling upgrades must use backward-compatible expand/contract migrations or a separately coordinated migration job.

Only one CryptoTracker replica should run against a single-tenant database in the initial architecture because scheduling is in-process. The migration lock makes concurrent startup safe, but it does not make the scheduler multi-replica safe.

## Provider behavior

Free/keyless upstream tiers can change limits or historical depth. Coinbase public market data requires no API key. BTC, ETH, and SOL use the currently supported USD products; CAD and other display currencies use a same-bucket CoinGecko quote ratio and remain visibly marked as derived. Historical requests are split into persistent windows of no more than 300 native candles and report per-window job progress. Provider failures place only that adapter into backoff/cooldown; cached data remains viewable. The UI distinguishes missing, partial, stale, derived, converted, fallback, disputed, and unpriced data.

Address providers receive every configured public address. Never enter private keys, seed phrases, xpubs, or signing material.

Kraken credentials are never editable in the UI. Rotation requires updating the secret source and restarting. CryptoTracker’s immutable Kraken allowlist contains query endpoints only.

## Exports and cleanup

Graph CSV/JSON exports include selected state, exact decimal strings, provenance, events, range, source, currency, and resolved granularity. PNG and SVG are generated from the current chart state and theme.

Complete application archives are removed after `exports.artifactTtlHours`; their job metadata remains. Temporary per-table spool files use mode `0600` and are removed after archive assembly.

## Upgrade

Before upgrading:

1. read release and migration notes;
2. take and verify a database backup;
3. build an image tagged with the commit hash;
4. run the test suite against the intended database mode;
5. deploy one replica and wait for `/readyz`.

Never downgrade across a destructive migration without a documented restore path.
