# CryptoTracker

CryptoTracker is a self-hosted, single-tenant, read-only cryptocurrency portfolio viewer. It combines cached public market data, public Bitcoin, Dogecoin, Ethereum, Polkadot, and Solana address history, and one query-only Kraken Spot account in a SvelteKit WUI behind one API ingress.

The application never requests wallet secrets, signs transactions, broadcasts blockchain transactions, places orders, transfers funds, or calls a Kraken mutation endpoint.

## Quick start with Docker

Requirements: Docker Engine with Compose v2.

```bash
mkdir -p config
cp config/examples/cryptotracker.config.example.json5 config/cryptotracker.config.json5
cp config/examples/cryptotracker.secrets.example.json5 config/cryptotracker.secrets.json5
```

Edit both copied files. At minimum, replace `sessionSecret` with at least 32 random characters and `localPassword` with a strong password. Keep the secrets file out of source control.

ETH and ERC-20 assets such as SHIB share one `providers.etherscanApiKey`; SOL and SPL assets share
one `providers.heliusApiKey`; and DOT history requires `providers.subscanApiKey`. Kraken, Coinbase,
and CoinGecko provide market prices, not transaction history for arbitrary public wallet addresses.
An Ethereum address does not implicitly expose every token: select each enabled ERC-20, such as
SHIB, on the tracked address so its contract history is imported. Missing or rejected provider
credentials are reported as unavailable/error state and are never treated as an empty
zero-balance history.

JSON5 values may instead use whole-value environment references such as `"${KRAKEN_API_SECRET}"`. Compose injects a repository-root `.env` when it exists and continues normally when it does not. The `.env` file is excluded from Git and the Docker build context.

```bash
docker compose up --build
```

Open `http://localhost:8192` and sign in as `admin` with the configured password. Canonical data is retained in the `cryptotracker-data` volume.

For PostgreSQL:

```bash
CRYPTOTRACKER_DB_KIND=postgres \
CRYPTOTRACKER_POSTGRES_PASSWORD='replace-me' \
docker compose --profile postgres up --build
```

The Postgres connection settings in the example config target the Compose `postgres` service.

## Local development

CryptoTracker requires Node.js 24 or newer.

```bash
npm ci
mkdir -p config data
cp config/examples/cryptotracker.config.example.json5 config/cryptotracker.config.json5
cp config/examples/cryptotracker.secrets.example.json5 config/cryptotracker.secrets.json5
npm run dev
```

For local development, change `exports.directory` in the copied config to `./data/exports`. The API listens on port 8192 and proxies the internal Vite/SvelteKit server on port 3000.

## Verification

```bash
npm run check
npm test
npm run build
docker build -f dockerfiles/cryptotracker.Dockerfile -t cryptotracker:local .
```

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), [operations](docs/operations.md), [testing](docs/testing.md), and [documented deviations](docs/spec-deviations.md).

## Quick copy/paste commands

Development with `docker-compose.dev.yml` (live reload):

```bash
docker compose -f docker-compose.dev.yml up --build --force-recreate
```

Production with `docker-compose.yml` (detached):

```bash
docker compose -f docker-compose.yml up --build --detach
```
