# sqlite-vec needs glibc, so Debian not Alpine.
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/app/data/app.db \
    WEB_ROOT=/app/web/dist

RUN mkdir -p /app/data && chown node:node /app/data

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev --workspace=server

COPY --from=build /app/web/dist ./web/dist
COPY server/src ./server/src

USER node
EXPOSE 3000
CMD ["node", "server/src/server.ts"]
