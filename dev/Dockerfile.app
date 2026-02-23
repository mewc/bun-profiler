FROM node:22-slim

WORKDIR /app

# Note: Bun's node:inspector is not yet implemented on Linux,
# so we use Node.js + tsx in the dev container for profiling support.
RUN npm install -g tsx

# Install project dependencies
COPY package.json ./
RUN npm install --ignore-scripts

# Source is bind-mounted at runtime for live-reload
CMD ["tsx", "watch", "dev/app/server.ts"]
