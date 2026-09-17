FROM node:24-bookworm-slim
ARG BIO_COMMIT
LABEL org.opencontainers.image.revision=$BIO_COMMIT
# Regional Debian mirror; package signatures remain verified by APT.
RUN sed -i 's|http://deb.debian.org|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.19.0
WORKDIR /app
COPY . .
RUN chmod -R a+rX /app \
    && pnpm install --frozen-lockfile \
    && pnpm --filter @bio/contracts build \
    && pnpm --filter @bio/api build \
    && pnpm --filter @bio/debug-console build
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/main.js"]
