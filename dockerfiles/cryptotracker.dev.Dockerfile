FROM node:24.14.0-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY wui/package.json ./wui/package.json
RUN npm install \
  && mkdir -p api/node_modules wui/node_modules \
  && node -e "const {createHash}=require('node:crypto');const {readFileSync,writeFileSync}=require('node:fs');const hash=createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');for(const directory of ['node_modules','api/node_modules','wui/node_modules'])writeFileSync(directory+'/.cryptotracker-package-lock.sha256',hash+'\\n')"

EXPOSE 8192 8194
CMD ["npm", "run", "dev"]
