/**
 * ينزّل ملف yt-dlp التنفيذي داخل مجلد bin/ حسب نظام التشغيل.
 * يعمل تلقائياً بعد npm install.
 * لو فشل، البوت يبحث عن yt-dlp في PATH.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const IS_WIN = process.platform === 'win32';
const TARGET = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'discord-voice-bot/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

function assetName() {
  if (IS_WIN) return process.arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  // linux
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

async function main() {
  try {
    if (process.env.SKIP_YTDLP_DOWNLOAD) {
      console.log('[yt-dlp] تخطي التنزيل (SKIP_YTDLP_DOWNLOAD).');
      return;
    }
    if (fs.existsSync(TARGET)) {
      console.log('[yt-dlp] موجود مسبقاً:', TARGET);
      return;
    }

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const asset = assetName();
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    console.log('[yt-dlp] جاري التنزيل:', url);

    await download(url, TARGET);
    if (!IS_WIN) fs.chmodSync(TARGET, 0o755);
    console.log('[yt-dlp] تم التنزيل إلى:', TARGET);
  } catch (err) {
    console.warn('[yt-dlp] فشل التنزيل:', err.message);
    console.warn('[yt-dlp] البوت بيحاول يستخدم yt-dlp من PATH أو /usr/local/bin/yt-dlp');
  }
}

main();
