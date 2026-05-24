FROM node:20-alpine AS builder

# Build dependencies for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Production image ────────────────────────────────────────────────────────

FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm

COPY --from=builder /app/dist ./dist

RUN mkdir -p data

CMD ["node", "dist/index.js"]
