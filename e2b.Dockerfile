# ---------------------------------------------------------------------------
# Template sandbox E2B kustom untuk AgentCloud.
#
# FUNGSI: menyiapkan Node.js + npm di dalam image, sehingga sandbox siap pakai
# dalam hitungan detik (tanpa instalasi Node saat runtime).
#
# CARA PAKAI (opsional - aplikasi tetap jalan tanpa ini, karena
# lib/sandbox/manager.ts otomatis memasang Node bila belum ada):
#
#   1. npx e2b template init              # membuat e2b.toml (isi template_id/name)
#   2. npx e2b template build             # build image ini (butuh E2B_API_KEY)
#   3. set E2B_TEMPLATE=<nama-template>   # di environment hosting
#
# Catatan: tag base image `e2bdev/base` bisa berbeda antar versi E2B.
# Lihat https://e2b.dev/docs/sandbox-template bila perlu menyesuaikan.
# ---------------------------------------------------------------------------
FROM e2bdev/base:latest

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git unzip xz-utils \
      python3 python3-pip python3-venv \
      sudo procps \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 LTS (versi sama dengan yang dipasang otomatis oleh manager.ts)
RUN curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
    && mkdir -p /usr/local/lib/nodejs \
    && tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs \
    && for b in node npm npx; do ln -sf /usr/local/lib/nodejs/node-v20.18.1-linux-x64/bin/$b /usr/local/bin/$b; done \
    && rm -f /tmp/node.tar.xz \
    && node -v && npm -v

USER user
WORKDIR /home/user
