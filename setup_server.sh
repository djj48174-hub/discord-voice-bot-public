#!/usr/bin/env bash
# ==========================================================
#  تجهيز البوت على سيرفر Oracle Cloud (Ubuntu) وتشغيله 24/7
#  الاستخدام على السيرفر:   bash setup_server.sh
# ==========================================================
set -euo pipefail

APP_DIR="$HOME/discord-voice-bot"
SERVICE_NAME="discord-voice-bot"

echo "==> 1) تحديث الحزم"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg

echo "==> 2) التأكد من Node.js (نثبت 20 إذا غير موجود أو قديم)"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
  if [ "$MAJOR" -ge 18 ]; then NEED_NODE=0; fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node: $(node -v)  |  npm: $(npm -v)"

echo "==> 3) التحقق من ملفات المشروع"
if [ ! -f "$APP_DIR/bot.js" ]; then
  echo "!! ما لقيت $APP_DIR/bot.js — ارفع ملفات المشروع أولاً."
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! ما لقيت $APP_DIR/.env — انسخه من .env.example واملأه ثم أعد التشغيل."
  exit 1
fi

echo "==> 4) تثبيت مكتبات المشروع"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> 5) تركيب خدمة systemd (تشغّل البوت تلقائياً 24/7 وترجّعه لو طاح)"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<EOF
[Unit]
Description=Discord 24/7 Voice Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) bot.js
Restart=always
RestartSec=10
StandardOutput=append:$APP_DIR/bot.log
StandardError=append:$APP_DIR/bot.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 3

echo ""
echo "==================================================="
echo " تم! البوت يشتغل الآن في الخلفية 24/7"
echo "==================================================="
echo " الحالة    : sudo systemctl status $SERVICE_NAME"
echo " السجل     : tail -f $APP_DIR/bot.log"
echo " إيقاف     : sudo systemctl stop $SERVICE_NAME"
echo " تشغيل     : sudo systemctl start $SERVICE_NAME"
echo " إعادة     : sudo systemctl restart $SERVICE_NAME"
echo ""
