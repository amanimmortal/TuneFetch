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
# npm ci requires ALL platform-specific optional packages to be in the lock file.
# Since the lock file is generated on Windows (missing Linux optionals), ci always
# fails in the Alpine builder. npm install uses the lock file for version pinning
# but resolves missing platform binaries itself — the correct pattern for
# cross-platform Docker builds.
RUN npm install

# Copy the rest of the source and build.
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime

# `su-exec` lets the entrypoint drop from root to the PUID/PGID-mapped
# user before exec'ing node, so any files the app writes (DB, copies)
# get the correct ownership on the Unraid host.
RUN apk add --no-cache su-exec libc6-compat tini \
  && deluser --remove-home node \
  && addgroup -g 1000 -S tunefetch \
  && adduser -u 1000 -S -G tunefetch tunefetch

WORKDIR /app

# Copy build output, production node_modules, and the package manifest.
COPY --from=builder /build/build ./build
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/scripts ./scripts

# Schema lives inside build/ via the ?raw import, so no separate copy needed.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Default PUID/PGID is 1000 (standard Linux user).
# Unraid users: set PUID=99, PGID=100 (nobody:users) to match share permissions,
# and UMASK=000 so mirrored files are readable by all shares.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TUNEFETCH_DATA_DIR=/app/data \
    PUID=1000 \
    PGID=1000 \
    UMASK="" \
    # Docker bridge networks often hand the container an IPv6 address with
    # no working v6 route. Node's happy-eyeballs then fails AAAA in
    # milliseconds with ETIMEDOUT, which surfaces as "MusicBrainz fetch
    # failed" despite IPv4 being fine. --dns-result-order=ipv4first is the
    # lowest-possible-level fix (applied before any JS runs). The undici
    # dispatcher override in src/lib/server/env.ts is the belt to this
    # braces.
    NODE_OPTIONS="--dns-result-order=ipv4first"

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "build/index.js"]
