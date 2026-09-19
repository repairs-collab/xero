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
RUN pnpm exec esbuild apps/worker/src/entrypoint.ts --bundle --platform=node --format=esm --target=node24 --outfile=/workspace/worker.mjs --external:pg-native

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV MIGRATIONS_DIR=/app/migrations
WORKDIR /app
RUN groupadd --system --gid 10001 billchaser && useradd --system --uid 10001 --gid billchaser billchaser
COPY --from=build --chown=billchaser:billchaser /workspace/worker.mjs /app/worker.mjs
COPY --from=build --chown=billchaser:billchaser /workspace/packages/db/drizzle /app/migrations
COPY --chown=billchaser:billchaser apps/container-entrypoint.mjs /app/container-entrypoint.mjs
USER billchaser
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "process.kill(1,0)"]
ENTRYPOINT ["node", "/app/container-entrypoint.mjs"]
CMD ["node", "/app/worker.mjs"]
