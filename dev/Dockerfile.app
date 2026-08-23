FROM oven/bun:1.3

WORKDIR /app

# Install dependencies (source is bind-mounted at runtime for hot-reload)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Refresh the anonymous node_modules volume on startup so adding a dependency
# does not leave an already-created local lab container with a stale install.
# Entrypoint uses --hot so editing src/ live-reloads in the container.
CMD ["sh", "-c", "bun install --frozen-lockfile && exec bun --hot dev/app/server.ts"]
