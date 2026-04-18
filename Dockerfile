# syntax=docker/dockerfile:1.6

# ---------- builder ----------
# Native deps (better-sqlite3, @node-rs/argon2) need build tools to
# compile prebuilt-or-source on Alpine. We install them here, build,
# then copy only the runtime artefacts into the slim runtime image.
FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /build

# Install deps first (cache-friendly).
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the source and build.
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime

# `su-exec` lets the entrypoint drop from root to the PUID/PGID-mapped
# user before exec'ing node, so any files the app writes (DB, copies)
# get the correct ownership on the Unraid host.
RUN apk add --no-cache su-exec libc6-compat tini \
  && addgroup -g 1000 -S tunefetch \
  && adduser -u 1000 -S -G tunefetch tunefetch

WORKDIR /app

# Copy build output, production node_modules, and the package manifest.
COPY --from=builder /build/build ./build
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Schema lives inside build/ via the ?raw import, so no separate copy needed.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TUNEFETCH_DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "build/index.js"]
