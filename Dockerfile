# Dockerfile — يعمل على Railway / Render / Fly.io / Koyeb
FROM node:22-slim

# ffmpeg من النظام (نسخة مستقرة فيها libopus) + شهادات HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# نستعمل ffmpeg النظام بدل نسخة ffmpeg-static
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false

# ننسخ ملفات التبعيات أولاً للاستفادة من كاش Docker
COPY package*.json ./
COPY scripts ./scripts

# تثبيت المكتبات (يشمل تنزيل yt-dlp إلى /app/bin)
RUN npm install --omit=dev --no-audit --no-fund

# نسخ الكود
COPY bot.js music.js chat.js .env.example ./

# فحص إجباري: لو الأدوات ناقصة يفشل البناء بدل ما يفشل التشغيل
RUN node -e "const {execFileSync}=require('child_process'); \
  console.log('ffmpeg:', execFileSync(process.env.FFMPEG_PATH,['-version']).toString().split('\n')[0]); \
  console.log('opus:', execFileSync(process.env.FFMPEG_PATH,['-hide_banner','-encoders']).toString().split('\n').filter(l=>l.includes('libopus')).join(' | ')); \
  console.log('yt-dlp:', execFileSync('./bin/yt-dlp',['--version']).toString().trim());"

# منفذ الصحة (Railway يضبط PORT تلقائياً)
ENV PORT=3000
EXPOSE 3000

CMD ["node", "bot.js"]
