# CryptoTracker

CryptoTracker is a self-hosted, single-tenant, read-only cryptocurrency portfolio viewer. It combines cached public market data, public Bitcoin, Dogecoin, Ethereum, Polkadot, and Solana address history, and one query-only Kraken Spot account in a SvelteKit WUI behind one API ingress. It also includes saved Dashboard views, local compound-growth scenarios, return/drawdown analytics, synchronization and storage diagnostics, and selective portable backup/restore.

The application never requests wallet secrets, signs transactions, broadcasts blockchain transactions, places orders, transfers funds, or calls a Kraken mutation endpoint.

## Quick start with Docker

Requirements: Docker Engine with Compose v2.

```bash
mkdir -p config
cp config/examples/cryptotracker.config.example.json5 config/cryptotracker.config.json5
cp config/examples/cryptotracker.secrets.example.json5 config/cryptotracker.secrets.json5
```

Edit both copied files. At minimum, replace `sessionSecret` with at least 32 random characters and `localPassword` with a strong password. Keep the secrets file out of source control.

Compose also starts the standalone MCP sidecar. Copy `.env.example` to `.env` and replace the dedicated upstream key plus the client-facing MCP keys, or set `CRYPTOTRACKER_MCP_ENABLED=false` when MCP is not wanted.

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

Open `http://localhost:8192` and sign in as `admin` with the configured password. Canonical data is retained in the `cryptotracker-data` volume. The API and MCP sidecar share the TLS certificate retained in `cryptotracker-certs`.

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
npm --prefix mcp ci
mkdir -p config data
cp config/examples/cryptotracker.config.example.json5 config/cryptotracker.config.json5
cp config/examples/cryptotracker.secrets.example.json5 config/cryptotracker.secrets.json5
npm run dev
```

For local development, change `exports.directory` in the copied config to `./data/exports`. `npm run dev` starts only the WUI and API; run `npm --prefix mcp run dev` separately when developing the sidecar. The API listens on HTTP port 8192, optional HTTPS port 8194, and proxies the internal Vite/SvelteKit server on port 3000.

## API and MCP

The API and MCP are separate processes and Compose services. The API can listen on HTTP (`8192`) and HTTPS (`8194`) independently. The MCP sidecar defaults to HTTPS at `https://localhost:8193/mcp`; trusted local deployments may enable its plaintext HTTP listener on port `8195`.

There are two deliberately distinct credentials:

- MCP clients authenticate to the sidecar with named Bearer API keys carrying `read` or `readwrite` roles.
- The sidecar calls the CryptoTracker API with a separate dedicated upstream key through `X-API-Key`.

The sidecar’s upstream URL may use the API’s HTTP or HTTPS listener. Both containers mount the shared certificate; TLS verification remains enabled when HTTPS is selected. MCP covers every allowlisted `/api` operation through focused tools plus `api_catalog`, `api_read`, and dry-run-first `api_write`. Kraken remains query-only. See the standalone [MCP README](mcp/README.md) for all tools and configuration.

## Verification

```bash
npm run check
npm test
npm run build
docker build -f dockerfiles/cryptotracker.Dockerfile -t cryptotracker:local .
```

See the [user guide](docs/user-guide.md), [HTTP API reference](docs/api.md), [implemented specification](docs/spec.md), [configuration](docs/configuration.md), [architecture](docs/architecture.md), [operations](docs/operations.md), [testing](docs/testing.md), and [documented deviations](docs/spec-deviations.md).

## Image publishing

CryptoTracker is a monorepo with two production images: the main application and the MCP sidecar. The following script builds both from the same tagged commit and publishes `latest`, the release version, and the release version plus commit SHA to Docker Hub and a custom registry:

```bash
USERNAME=YOURUSERNAME
DOMAIN=yourdomain.xyz
VERSION=v0.1.3

git tag -a "$VERSION" -m "$VERSION"
# git tag -f -a "$VERSION" -m "$VERSION"
# git push --force origin "$VERSION"

SHA=$(git rev-parse --short=12 HEAD)

docker build \
  --build-arg BUILD_HASH="$SHA" \
  -t cryptotracker:build \
  -f ./dockerfiles/cryptotracker.Dockerfile \
  .

docker build \
  --build-arg BUILD_HASH="$SHA" \
  -t cryptotracker-mcp:build \
  ./mcp

for IMAGE in cryptotracker cryptotracker-mcp; do
  for TAG in latest "$VERSION" "$VERSION-$SHA"; do
    docker tag "$IMAGE:build" "$USERNAME/$IMAGE:$TAG"
    docker tag "$IMAGE:build" "$DOMAIN/$USERNAME/$IMAGE:$TAG"
    docker push "$USERNAME/$IMAGE:$TAG" # Docker Hub
    docker push "$DOMAIN/$USERNAME/$IMAGE:$TAG" # Custom registry
  done
done
```

## Quick copy/paste commands

Development with `docker-compose.dev.yml` (live reload):

```bash
docker compose -f docker-compose.dev.yml up --build --force-recreate
```

Production with `docker-compose.yml` (detached):

```bash
docker compose -f docker-compose.yml up --build --detach
```
