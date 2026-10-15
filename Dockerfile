# Dockerfile للبوت — يعمل على Render/Railway/Fly.io/Koyeb
FROM node:20-alpine

# تثبيت التبعيات الصوتية (libopus, python, build tools)
RUN apk add --no-cache \
    opus \
    python3 \
    make \
    g++ \
    ffmpeg

WORKDIR /app

# نسخ ملفات التبعيات أولاً للاستفادة من كاش Docker
COPY package*.json ./

# تثبيت مكتبات الإنتاج فقط
RUN npm ci --omit=dev --no-audit --no-fund

# نسخ الكود
COPY bot.js .env.example ./

# نستخدم .env من متغيرات البيئة في المنصة (ما ننسخ .env المحلي للصورة)
# لو تبي تنسخه للصورة محلياً، ألغِ التعليق عن السطر تحت:
# COPY .env .

# منفذ وهمي (بعض المنصات تطلب PORT) — البوت ما يفتح HTTP بس عشان الصحة
ENV PORT=3000
EXPOSE 3000

# تشغيل البوت
CMD ["node", "bot.js"]