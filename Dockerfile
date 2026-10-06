FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS worker
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/worker.js ./worker.js
RUN mkdir -p /worker-state && chown node:node /worker-state
USER node
VOLUME ["/worker-state"]
EXPOSE 8877
CMD ["node", "worker.js"]

FROM node:22-bookworm-slim AS bot
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --system sanwan && useradd --system --gid sanwan --home-dir /app --shell /usr/sbin/nologin sanwan
WORKDIR /app
COPY --from=build --chown=sanwan:sanwan /app/package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm ci --omit=dev && apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=sanwan:sanwan /app/dist ./dist
COPY --chown=sanwan:sanwan setup.js uninstall.js docker-cli.js ./
RUN mkdir -p /app/data /app/logs && chown sanwan:sanwan /app/data /app/logs
USER sanwan
VOLUME ["/app/data", "/app/logs"]
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 CMD ["node", "dist/health.js"]
