# Testing

The normal suite uses recorded/fake provider fixtures and does not require live upstream APIs.

```bash
npm ci
npm --prefix mcp ci
npm run check
npm test
npm run build
```

The API tests cover exact decimal market arithmetic, graph rules, lifecycle rules, address reconstruction, transfer reconciliation, cost-basis methods, authentication/CSRF/proxy behavior, secret exclusion, rate limiting, provider URL allowlists, SQLite migrations, persistent jobs, combined portfolio snapshots, streaming exports, backup inspection/selective restore, retention, chain fixtures, market persistence, and interrupted Kraken/Earn pagination.

The standalone MCP tests cover config/environment precedence, complete disablement, HTTP/HTTPS transport selection, separate upstream/client key loading, timing-safe Bearer authentication, API request construction, read/write tool discovery, dry-run safety, credential redaction, rate-limit isolation, and bounded mutation history.

The WUI unit tests cover API/CSRF helpers, cached document preferences, searchable chart-axis
options, relative ranges, number/date formatting, and timezone/DST conversion. Opt-in Playwright
coverage exercises login/navigation, theme and block persistence, chart controls/keyboard
inspection, Dashboard refresh persistence and row layout, currency popups, market catalog controls,
address holdings, Kraken Earn/APY coverage, and failed-job filtering/retention payload isolation:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:8192 \
PLAYWRIGHT_USERNAME=admin \
PLAYWRIGHT_PASSWORD='test-password' \
npm run test:browser
```

Install the Playwright browser once with `npx playwright install chromium`, or run the test command in the matching official Playwright image.

## PostgreSQL integration

Start a disposable PostgreSQL 17 instance, then run:

```bash
TEST_POSTGRES=1 \
TEST_POSTGRES_HOST=127.0.0.1 \
TEST_POSTGRES_PORT=5432 \
TEST_POSTGRES_DATABASE=cryptotracker \
TEST_POSTGRES_USER=cryptotracker \
TEST_POSTGRES_PASSWORD='change-me' \
npm run test:api
```

The conditional integration test migrates both databases and compares every logical table and column.

## Production verification

```bash
docker build \
  --build-arg BUILD_HASH="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)" \
  -f dockerfiles/cryptotracker.Dockerfile \
  -t cryptotracker:verification .

docker build \
  --build-arg BUILD_HASH="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)" \
  -t cryptotracker-mcp:verification \
  ./mcp
```

Run it with the example config/secrets mounted read-only, a writable `/app/data`, and `TMPDIR=/tmp/cryptotracker`. Verify `/health`, `/readyz`, `/auth/methods`, and a proxied WUI route.

Production dependency audit:

```bash
npm audit --omit=dev
npm --prefix mcp audit --omit=dev
```

Production and development dependency audits are clean. The workspace override keeps SvelteKit's compatible `cookie` dependency on the patched release until its declared range is updated upstream.
