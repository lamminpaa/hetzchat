FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production

RUN adduser -D -u 10001 hetzchat && mkdir -p /data && chown hetzchat:hetzchat /data

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY package.json /app/package.json

USER hetzchat
# Transcripts written by /save land here, which is the mounted volume.
WORKDIR /data

ENTRYPOINT ["node", "/app/dist/index.js"]
