FROM node:24.14.0-bookworm-slim AS dependencies

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY wui/package.json ./wui/package.json
RUN npm ci

FROM dependencies AS build

ARG BUILD_HASH=unknown
ENV BUILD_HASH=$BUILD_HASH

COPY . .
RUN node scripts/write-build-info.mjs --output /workspace/build-info.json \
  && npm run check \
  && npm run build

FROM node:24.14.0-bookworm-slim AS production

WORKDIR /app
ENV NODE_ENV=production
ENV BUILD_INFO_PATH=/app/build-info.json
ENV CRYPTOTRACKER_WUI_UPSTREAM_BASE_URL=http://127.0.0.1:3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 cryptotracker \
  && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin cryptotracker \
  && mkdir -p /app/data /app/data/exports /app/config /tmp/cryptotracker \
  && chown -R cryptotracker:cryptotracker /app/data /tmp/cryptotracker

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY wui/package.json ./wui/package.json
RUN npm ci --omit=dev --workspaces --include-workspace-root \
  && npm cache clean --force

COPY --from=build /workspace/api/dist ./api/dist
COPY --from=build /workspace/api/migrations ./api/migrations
COPY --from=build /workspace/wui/build ./wui/build
COPY --from=build /workspace/runtime ./runtime
COPY --from=build /workspace/build-info.json ./build-info.json

USER cryptotracker:cryptotracker
EXPOSE 8192
VOLUME ["/app/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "runtime/launcher.mjs"]
