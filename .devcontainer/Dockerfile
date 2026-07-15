# Node 20 toolchain (matches the version gurt is developed against) + git.
FROM mcr.microsoft.com/devcontainers/typescript-node:20

# Runtime libraries Electron needs to launch (headless via Xvfb). Playwright's
# _electron.launch used by the smoke scripts, and `electron-vite dev`, both
# start a real Electron process that requires these even with no visible window.
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
  && apt-get install -y --no-install-recommends \
    xvfb \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libgtk-3-0 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
