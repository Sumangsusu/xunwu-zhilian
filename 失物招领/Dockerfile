FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json *.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
RUN install -d -o node -g node -m 0750 /app/data /app/public/uploads
USER node
EXPOSE 3000
CMD ["node", "server.js"]
