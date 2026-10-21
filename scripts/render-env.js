'use strict';
// يحدّث متغيرات Render لخدمة البوت (كل القيم مرة واحدة — PUT يستبدل الكل)
// نقرأ .env يدوياً عشان نضمن المفاتيح (dotenv ما يكتب فوق متغير موجود فاضي).
const fs = require('fs');
const path = require('path');

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID || 'srv-db9mj0qjnfac73cs1bcg';
if (!KEY) {
  console.error('RENDER_API_KEY missing');
  process.exit(1);
}

function readEnvFile() {
  const out = {};
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}
const env = readEnvFile();

const envVars = [
  { key: 'DISCORD_TOKEN', value: env.DISCORD_TOKEN },
  { key: 'GUILD_ID', value: '1562207103786029077' },
  { key: 'VOICE_CHANNEL_ID', value: '1562222163140939803' },
  { key: 'CHECK_SECONDS', value: '30' },
  { key: 'LOCK_TO_CHANNEL', value: 'true' },
  { key: 'SELF_PING', value: 'true' },
  { key: 'NODE_ENV', value: 'production' },
  { key: 'FFMPEG_PATH', value: '/usr/bin/ffmpeg' },
  { key: 'DIAG_KEY', value: 'nht-diag-2026' },
  { key: 'GEMINI_API_KEY', value: env.GEMINI_API_KEY },
  { key: 'GEMINI_API_KEY2', value: env.GEMINI_API_KEY2 },
  { key: 'GROQ_API_KEY', value: env.GROQ_API_KEY },
  { key: 'VOICE_CHAT', value: 'false' },
  { key: 'TTS_ORDER', value: 'edge,groq,google' },
  { key: 'HONEYPOT_CHANNEL_ID', value: '1562213563349729432' },
  { key: 'HONEYPOT_LOG_CHANNEL_ID', value: '1562213570819788820' },
  { key: 'WELCOME_CHANNEL_ID', value: '1562213580529475675' },
  { key: 'RULES_CHANNEL_ID', value: '1562213576368726178' },
  { key: 'WAITING_CHANNEL_ID', value: '1562222156178259969' },
  { key: 'SUPPORT_TEXT_CHANNEL_ID', value: '1562222149379301426' },
  { key: 'STAFF_ROLE_ID', value: '1562213525563383880' },
  { key: 'QURAN_CHANNEL_ID', value: '1562213565287501844' },
  { key: 'HADITH_CHANNEL_ID', value: '1562222160104394843' },
  { key: 'QURAN_RADIO_CHANNEL_ID', value: '1562222163140939803' },
  { key: 'AUTO_JOIN_VOICE_IDS', value: '1562222163140939803,1562032331110355004' },
].filter((v) => v.value !== undefined && v.value !== null && String(v.value) !== '');

(async () => {
  const res = await fetch(`https://api.render.com/v1/services/${SERVICE}/env-vars`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(envVars),
  });
  const text = await res.text();
  console.log('status', res.status);
  if (!res.ok) {
    console.error(text);
    process.exit(1);
  }
  const json = JSON.parse(text);
  console.log('updated keys:', json.map((x) => x.envVar?.key || x.key).join(', '));
})();
