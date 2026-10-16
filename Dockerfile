# Dockerfile — يعمل على Railway / Render / Fly.io / Koyeb
FROM node:20-slim

# أدوات البناء + الشهادات (ffmpeg يجي من ffmpeg-static)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ننسخ ملفات التبعيات أولاً للاستفادة من كاش Docker
COPY package*.json ./
COPY scripts ./scripts

# تثبيت المكتبات (يشمل تنزيل yt-dlp و ffmpeg-static)
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
RUN npm install --omit=dev --no-audit --no-fund

# نسخ الكود
COPY bot.js music.js .env.example ./

# منفذ الصحة (Railway يضبط PORT تلقائياً)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "bot.js"]
