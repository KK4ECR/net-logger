FROM node:20-slim

# Build tools for native modules (better-sqlite3) plus Chromium's runtime libraries
# (Puppeteer ships its own Chromium binary - these are just the shared libs it links against)
RUN apt-get update && apt-get install -y \
    python3 make g++ \
    chromium \
    fonts-liberation \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpangocairo-1.0-0 libpango-1.0-0 libcairo2 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Use the apt-installed Chromium instead of downloading Puppeteer's own copy -
# smaller image, faster build, and matches a known-working binary for this base image
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --only=production

COPY . .

RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]
