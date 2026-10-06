# syntax=docker/dockerfile:1
# Gateway image (docs/08 §1). TypeScript runs directly on Node's built-in type stripping (Node >= 22.18),
# so there is no compile stage: the image ships the sources it runs, the same files as local dev.
#   target `tools`   : full workspace, for the one-shot migrate/seed/kb:embed service
#   target `runtime` : production dependencies of the gateway only, non-root, healthcheck

FROM node:22-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
COPY packages/shared/package.json packages/shared/
COPY scripts/package.json scripts/

FROM base AS tools
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "db:migrate"]

FROM base AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter @mir/gateway...
COPY packages/shared/src packages/shared/src
COPY apps/gateway/src apps/gateway/src
COPY data/thresholds.json data/thresholds.json
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -qO- http://127.0.0.1:8787/healthz > /dev/null || exit 1
CMD ["node", "apps/gateway/src/local.ts"]
