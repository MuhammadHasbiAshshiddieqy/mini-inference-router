# syntax=docker/dockerfile:1
# Console image (docs/08 §1): Vite build, served by nginx with an SPA fallback.
# VITE_* are baked in at build time. If VITE_DEMO_TENANTS is empty, vite.config.ts derives it from the
# PUBLIC demo seed keys (acme, globex, tiny) passed as build args. The admin and reviewer keys are never bundled.

FROM node:22-alpine AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
COPY packages/shared/package.json packages/shared/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile --filter @mir/console...
COPY packages/shared packages/shared
COPY apps/console apps/console
ARG VITE_GATEWAY_URL=http://localhost:8787
ARG VITE_DEMO_TENANTS=""
ARG SEED_KEY_ACME=""
ARG SEED_KEY_GLOBEX=""
ARG SEED_KEY_TINY=""
ENV VITE_GATEWAY_URL=$VITE_GATEWAY_URL VITE_DEMO_TENANTS=$VITE_DEMO_TENANTS \
    SEED_KEY_ACME=$SEED_KEY_ACME SEED_KEY_GLOBEX=$SEED_KEY_GLOBEX SEED_KEY_TINY=$SEED_KEY_TINY
RUN pnpm --filter @mir/console build

FROM nginx:alpine
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/console/dist /usr/share/nginx/html
EXPOSE 80
