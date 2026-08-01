FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
# issue 122: apps/api's `playwright` dependency's own postinstall would try to
# download its bundled (glibc-only) Chromium here too — Playwright does not
# support Alpine's musl libc for that binary at all, so the download is
# useless in this stage (build only COMPILES, it never launches a browser)
# and would just waste build time / risk a flaky network failure. The
# runtime stage below installs a REAL, working Alpine chromium via apk instead.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
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
# Same reasoning as the build stage above — never let Playwright's postinstall
# try (and fail) to download its own bundled Chromium on Alpine.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# issue 122: real, working Chromium for Alpine (musl libc) — Playwright's own
# downloaded browser build targets glibc distros only and will not run here.
# `playwright-import.ts`'s `resolveChromiumExecutablePath()` finds this
# automatically at its standard apk-installed path. The extra font/NSS/
# freetype packages are the standard set needed for headless Chromium to
# actually render (a bare `chromium` package alone crashes on launch on
# Alpine — documented Puppeteer/Playwright-on-Alpine requirement).
RUN apk add --no-cache chromium nss freetype freetype-dev harfbuzz ca-certificates ttf-freefont
# Produkčné závislosti sa inštalujú znova, nekopírujú sa z build fázy: pnpm robí
# node_modules zo symlinkov do svojho store, a tie by po skopírovaní ukazovali do
# prázdna. Natívny modul argon2 sa tak zároveň zostaví pre runtime obraz.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --filter @forestshop/api --prod --frozen-lockfile
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=node:node /app/apps/web/dist ./public
ARG APP_VERSION
ARG APP_COMMIT
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT
EXPOSE 3000
# Raw-snapshot dir (CATALOG_RAW_DIR, docker-compose.prod.yml's `catalog-raw`
# named volume) must exist and be owned by `node` BEFORE the volume is first
# attached — a real production incident (F1 final-wave-a, item 8): the first
# import downloaded 57 MB fine, then failed writing it because Docker
# initializes a brand-new named volume's content/ownership by COPYING
# whatever already exists at that path in the image at the moment the
# container starts. Without this, the mount point is created root-owned, and
# `USER node` below can never write into it. Creating it here (still root,
# before dropping privileges) means any FRESH volume on any new host inherits
# `node:node` ownership from the image, not root.
RUN mkdir -p /data/catalog-raw /data/orders-raw && chown -R node:node /data/catalog-raw /data/orders-raw
# `node` is the non-root user (uid 1000) baked into the base image. node_modules
# above stays root-owned (installed before this point), which is fine — pnpm
# leaves it world-readable, and the app only ever needs to READ it, never write.
USER node
CMD ["node", "apps/api/dist/index.js"]
