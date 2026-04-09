# ── Stage 1: deps ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++ && npm install --omit=dev

# ── Stage 2: production image ───────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy installed node_modules and source
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create the data directory where SQLite file will live
RUN mkdir -p /app/data

# Expose the API port
EXPOSE 3001

# Non-root user for security
RUN addgroup -S loonepos && adduser -S loonepos -G loonepos
RUN chown -R loonepos:loonepos /app
USER loonepos

CMD ["node", "server.js"]
