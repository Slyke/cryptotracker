FROM node:24.14.0-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run check \
  && npm run test \
  && npm run build

FROM node:24.14.0-bookworm-slim AS production

ARG BUILD_HASH=unknown
ENV NODE_ENV=production
ENV BUILD_HASH=$BUILD_HASH
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 cryptotracker \
  && useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin cryptotracker \
  && mkdir -p /app/data/certs \
  && chown -R cryptotracker:cryptotracker /app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force
COPY --from=build /workspace/dist ./dist
COPY scripts ./scripts

USER cryptotracker:cryptotracker
EXPOSE 8193 8195
VOLUME ["/app/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
