FROM oven/bun:latest

WORKDIR /app

# Install dependencies (source is bind-mounted at runtime for hot-reload)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Entrypoint uses --hot so editing src/ live-reloads in the container
CMD ["bun", "--hot", "dev/app/server.ts"]
