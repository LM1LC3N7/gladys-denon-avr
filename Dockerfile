# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:26-alpine

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache).
# --ignore-scripts: the dependency tree has none (no native addons, checked
# at review time), so this is free hardening against a compromised package's
# postinstall running arbitrary code during the image build.
# Strict `npm ci` only, no `npm install` fallback: the lockfile is committed,
# and a fallback would silently ship unpinned versions the day it drifts
# from package.json instead of failing the build (the CI docker job).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime.
ENV NODE_ENV=production
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
