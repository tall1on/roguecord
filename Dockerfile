# syntax=docker/dockerfile:1
#
# RogueCord server image (server only).
# Builds the Node.js server including the mediasoup native worker and the
# emoji SVG assets that the server serves to clients.
#
# Build:
#   docker build -t roguecord-server .
# Run:
#   docker run --rm -p 1337:1337 -p 10000-10100:10000-10100/udp \
#     -e MEDIASOUP_ANNOUNCED_IP=<your-public-ip> \
#     -v /srv/roguecord/data:/app/server/data roguecord-server
#

ARG NODE_VERSION=22

# ----------------------------------------------------------------------------
# Stage 1: build dependencies (compiles the mediasoup native worker)
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# mediasoup compiles a C++ worker -> needs a toolchain. Its postinstall also
# runs `python3 -m pip install ... invoke` and builds via meson/ninja, so we
# need pip and the meson/ninja build tools. PIP_BREAK_SYSTEM_PACKAGES lets pip
# install into the mediasoup worker dir on PEP-668 (externally-managed) systems.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        make \
        g++ \
        pkg-config \
        meson \
        ninja-build \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_BREAK_SYSTEM_PACKAGES=1

WORKDIR /app

# Copy only the server manifest first to leverage layer caching for npm install.
COPY server/package.json server/package-lock.json* ./server/

# Install server dependencies. ts-node/typescript are in `dependencies`,
# so a production install is sufficient and keeps the image lean.
RUN cd server && npm install

# Copy the server source.
COPY server/ ./server/

# The server serves Twemoji SVG assets from <cwd>/client/public/svg
# (see server/src/index.ts). The process runs with cwd=/app/server, so the
# assets must live at /app/server/client/public/svg to resolve correctly.
COPY client/public/svg/ ./server/client/public/svg/

# ----------------------------------------------------------------------------
# Stage 2: runtime image
# ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Minimal runtime deps; mediasoup worker is already compiled in the builder.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed node_modules, source, and bundled emoji SVGs from the builder.
COPY --from=builder /app/server/ ./server/

# The SQLite database and uploaded files live under server/data. Persist it.
RUN mkdir -p /app/server/data \
    && chown -R node:node /app

# Drop privileges.
USER node

# Defaults (overridable via env / compose). See server/.env.example.
ENV NODE_ENV=production \
    LISTEN_IP=0.0.0.0 \
    PORT=1337 \
    MEDIASOUP_LISTEN_IP=0.0.0.0 \
    MEDIASOUP_ANNOUNCED_IP=127.0.0.1

# HTTP/WS port.
EXPOSE 1337
# WebRTC (mediasoup) UDP/TCP port range used by createWebRtcTransport.
EXPOSE 10000-10100

# tini reaps zombies and forwards signals (mediasoup spawns worker processes).
ENTRYPOINT ["/usr/bin/tini", "--"]

WORKDIR /app/server
CMD ["npm", "start"]
