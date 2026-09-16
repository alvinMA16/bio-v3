FROM node:24-bookworm-slim
ARG BIO_COMMIT
LABEL org.opencontainers.image.revision=$BIO_COMMIT
RUN npm install -g pnpm@11.19.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @bio/contracts build \
    && pnpm --filter @bio/api build \
    && pnpm --filter @bio/debug-console build
ENV NODE_ENV=production
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/main.js"]
