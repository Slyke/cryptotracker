FROM node:24.14.0-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY wui/package.json ./wui/package.json
RUN npm install

EXPOSE 8192
CMD ["npm", "run", "dev"]
