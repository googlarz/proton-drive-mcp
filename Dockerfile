# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# NOTE: this image does NOT include the official `proton-drive` CLI, which the
# server shells out to. Provide it separately: bind-mount the binary and set
# PROTON_DRIVE_BIN, or extend this image with a layer that installs it.
USER node
CMD ["node", "dist/index.js"]
