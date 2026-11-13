# syntax=docker/dockerfile:1
# Сборка фронтенда целиком в контейнере: на хосте не нужны ни Node, ни pnpm.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Хранилище пакетов pnpm — в кэше BuildKit: при изменении lockfile качается только разница.
RUN --mount=type=cache,id=nimbus-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* вшивается в клиентский бандл при сборке; пусто — тот же origin (за caddy).
ARG NEXT_PUBLIC_BACKEND_URL=""
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,id=nimbus-next-cache,target=/app/.next/cache \
    pnpm build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
