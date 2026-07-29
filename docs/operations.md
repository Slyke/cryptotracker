# Operations

## Health

- `/health` and `/healthz` report process health, version, and build hash.
- `/readyz` verifies the database, migrations/configuration state, and internal WUI.

The Compose health check uses `/readyz`. Kubernetes uses `/readyz` for readiness and `/healthz` for liveness.

## Persistence and backups

Canonical data is intentionally retained indefinitely. Operators must monitor database growth and storage capacity. Settings shows row counts, estimated category sizes, and retained time ranges.

For SQLite, persist `/app/data`, including the database, WAL, and SHM files. Use a SQLite-aware online backup or stop the application before copying all database files. Do not copy only the main `.sqlite` file while the application is running.

For PostgreSQL, use normal PostgreSQL physical or logical backup tooling and test restores. Protect both database backups and deployment secrets.

The complete application export is a streaming data-portability archive. It is not a transaction-consistent database backup and has no import/restore function. Export artifacts expire after the configured TTL; canonical rows do not.

## Production container

The production image:

- runs as UID/GID 10001;
- uses `tini`;
- exposes only port 8192;
- supports a read-only root filesystem;
- writes canonical data only below `/app/data`;
- writes temporary export spool files below `TMPDIR`;
- contains production dependencies only.

The Kubernetes example sets `fsGroup: 10001` so fresh persistent volumes and temporary volumes remain writable to the non-root process.

## PostgreSQL

Set `CRYPTOTRACKER_DB_KIND=postgres`, configure `database.postgres`, and supply `CRYPTOTRACKER_POSTGRES_PASSWORD`. Migrations run on startup. A migration failure prevents readiness.

Only one CryptoTracker replica should run against a single-tenant database in the initial architecture because scheduling is in-process.

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
