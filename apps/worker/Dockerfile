# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/jobs/package.json packages/jobs/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages packages
RUN pnpm exec esbuild apps/worker/src/entrypoint.ts --bundle --platform=node --format=esm --target=node24 --outfile=/workspace/worker.mjs --external:pg-native --banner:js="import { createRequire as accountPulseCreateRequire } from 'node:module'; const require = accountPulseCreateRequire(import.meta.url);" \
  && node --check /workspace/worker.mjs \
  && pnpm exec esbuild apps/worker/src/worker-healthcheck.ts --bundle --platform=node --format=esm --target=node24 --outfile=/workspace/worker-healthcheck.mjs

FROM node:24.19.0-alpine3.23 AS runtime
LABEL org.opencontainers.image.description="AccountPulse worker with protected operational-reset commands"
ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/app/migrations
ENV ACCOUNT_PULSE_WORKER_HEARTBEAT_PATH=/tmp/accountpulse-worker-heartbeat.json
WORKDIR /app
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca-bundle.pem
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /workspace/worker.mjs /app/worker.mjs
COPY --from=build --chown=node:node /workspace/worker-healthcheck.mjs /app/worker-healthcheck.mjs
COPY --from=build --chown=node:node /workspace/packages/db/drizzle /app/migrations
COPY --chown=node:node apps/container-entrypoint.mjs /app/container-entrypoint.mjs
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD ["node", "/app/worker-healthcheck.mjs"]
ENTRYPOINT ["node", "/app/container-entrypoint.mjs"]
CMD ["node", "/app/worker.mjs"]
