FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
ARG APP_VERSION
ARG APP_COMMIT
RUN pnpm --filter @forestshop/web build && pnpm --filter @forestshop/api build

FROM node:24-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
# Produkčné závislosti sa inštalujú znova, nekopírujú sa z build fázy: pnpm robí
# node_modules zo symlinkov do svojho store, a tie by po skopírovaní ukazovali do
# prázdna. Natívny modul argon2 sa tak zároveň zostaví pre runtime obraz.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @forestshop/api --prod --frozen-lockfile
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build /app/apps/web/dist ./public
ARG APP_VERSION
ARG APP_COMMIT
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
