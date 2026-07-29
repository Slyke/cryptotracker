# Testing

The normal suite uses recorded/fake provider fixtures and does not require live upstream APIs.

```bash
npm ci
npm run check
npm test
npm run build
```

The API tests cover exact decimal market arithmetic, graph rules, lifecycle rules, address reconstruction, transfer reconciliation, cost-basis methods, authentication/CSRF/proxy behavior, secret exclusion, rate limiting, provider URL allowlists, SQLite migrations, persistent jobs, streaming exports, chain fixtures, market persistence, and interrupted Kraken pagination.

The WUI tests cover API/CSRF helpers and timezone/DST conversion. Playwright tests are opt-in:

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
```

Run it with the example config/secrets mounted read-only, a writable `/app/data`, and `TMPDIR=/tmp/cryptotracker`. Verify `/health`, `/readyz`, `/auth/methods`, and a proxied WUI route.

Production dependency audit:

```bash
npm audit --omit=dev
```

As of this implementation, production dependencies audit clean. The current SvelteKit toolchain may report a low-severity development-only `cookie` advisory until an upstream compatible release changes its dependency range.
