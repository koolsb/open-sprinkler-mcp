# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

# Run as non-root for security
RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /app/dist ./dist

USER mcp

EXPOSE 3000

# Liveness probe target
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
