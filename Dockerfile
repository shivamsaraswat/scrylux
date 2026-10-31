FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
RUN corepack enable
WORKDIR /app

# Install first with only the manifests, so this layer caches across source-only changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/threat-library/package.json ./packages/threat-library/package.json
COPY packages/llm/package.json ./packages/llm/package.json
RUN pnpm install --frozen-lockfile

COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages ./packages
# "..." builds the api's workspace dependencies (@scrylux/db) first, in dependency order. The web app
# is built too; the final stage ships its dist next to the API.
RUN pnpm --filter "@scrylux/api..." --filter @scrylux/web run build
RUN pnpm --filter=@scrylux/api deploy --prod /prod/api

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ENV NODE_ENV=production
# The image keeps the repository's layout: the API resolves the built web app relative to its own
# module (../../web/dist), so it must sit at /app/apps/web/dist next to /app/apps/api.
WORKDIR /app/apps/api

COPY --from=builder /prod/api/node_modules ./node_modules
COPY --from=builder /prod/api/dist ./dist
COPY --from=builder /prod/api/package.json ./package.json
COPY --from=builder /app/apps/web/dist /app/apps/web/dist

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
