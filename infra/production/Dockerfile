FROM node:24-bookworm-slim
# Regional Debian mirror; package signatures remain verified by APT.
RUN --mount=type=cache,id=bio-v3-apt,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.19.0
WORKDIR /app
COPY --chmod=644 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=644 apps/api/package.json ./apps/api/
COPY --chmod=644 apps/debug-console/package.json ./apps/debug-console/
COPY --chmod=644 apps/miniprogram/package.json ./apps/miniprogram/
COPY --chmod=644 packages/contracts/package.json ./packages/contracts/
RUN --mount=type=cache,id=bio-v3-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY --chmod=755 . .
RUN pnpm --filter @bio/contracts build \
    && pnpm --filter @bio/api build \
    && pnpm --filter @bio/debug-console build
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
ARG BIO_COMMIT
LABEL org.opencontainers.image.revision=$BIO_COMMIT
CMD ["node", "dist/main.js"]
