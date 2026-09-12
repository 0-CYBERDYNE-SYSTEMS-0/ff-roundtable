# FarmFriend Roundtable PRO — Production Dockerfile
# Multi-stage build: compile → runtime

# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps (native modules may need python/make)
RUN apk add --no-cache python3 make g++

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build client + bundle server
RUN npm run build

# ─── Stage 2: Production Runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Create non-root user
RUN addgroup -g 1001 -S farmapp && \
    adduser -S farmuser -u 1001 -G farmapp

WORKDIR /app

# Install production deps only (no devDependencies, no build tools)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

# Copy runtime essentials
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server ./server
COPY --from=builder /app/client/index.html ./client/index.html
COPY --from=builder /app/drizzle.config.ts ./
# No migrations dir is tracked — schema changes ship via `npm run db:push`
# (drizzle-kit), so there is nothing to COPY here.

# Ensure uploads dir exists and is writable
RUN mkdir -p /app/uploads && chown -R farmuser:farmapp /app

ENV NODE_ENV=production
ENV PORT=5001

# Expose server port (single port serves API + static client)
EXPOSE 5001

USER farmuser

CMD ["node", "dist/index.js"]
