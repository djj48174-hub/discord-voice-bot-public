'use strict';
// اختبار منطق تشغيل/إيقاف الرد الصوتي — يستخرج الأجزاء النقية من bot.js ويشغّلها
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(SRC, 'utf8');

function grab(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error('marker: ' + (i < 0 ? a : b));
  return src.slice(i, j);
}

const code =
  'const VOICE_SONG_COMMANDS = false;\n' +
  grab('function normAr(s) {', '// عبارات إيقاف الرد الصوتي') +
  '\n' +
  grab('const VOICE_OFF_PHRASES = [', 'function setVoiceChat');
const mod = {};
new Function('mod', code + '\nmod.voiceToggleIntent = voiceToggleIntent;')(mod);

const cases = [
  // إيقاف
  ['وقف الرد الصوتي', 'off'],
  ['اقفل الرد الصوتي', 'off'],
  ['اسكت', 'off'],
  ['اسكت يا بوت', 'off'],
  ['بس اسكت', 'off'],
  ['سكوت', 'off'],
  ['انطم', 'off'],
  ['خلك ساكت', 'off'],
  ['لا تتكلم', 'off'],
  ['اقفل السوالف', 'off'],
  ['طفي الرد', 'off'],
  ['سكر الكلام', 'off'],
  ['وقف الصوت', 'off'],
  ['خلاص اسكت شوي', 'off'],
  // تشغيل
  ['شغل الرد الصوتي', 'on'],
  ['رد علي', 'on'],
  ['شغل السوالف', 'on'],
  ['كلمني', 'on'],
  // لازم تكون محايدة (ما تشغّل ولا تطفّي)
  ['تكلم', null],
  ['شغل الصوت', null],
  ['اتكلم', null],
  ['السلام عليكم', null],
  ['كيف حالك', null],
  ['وش رايك بالفكرة', null],
  ['ابغى اسمع اغنية', null],
  ['ليش وقفت الكلام', null],
  ['تراني راجع البيت', null],
  ['اسكتت السيارة', null],
  // حالات حقيقية من اللوقات
  ['طيب ليش ما تكلمني؟ ما تكلمني قل لي يا ود وينك؟', null],
  ['تكلمني', null],
  ['وش رايك يا بوت تكلمني شوي', null],
  ['لا لا تسلق تسلق', null],
  ['عطه 100 وتصبر.', null],
  ['اسمع', null],
];

let fail = 0;
let pass = 0;
for (const [text, expect] of cases) {
  const got = mod.voiceToggleIntent(text, true);
  const ok = got === expect;
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ "${text}" -> ${got}  (المتوقع ${expect})`);
}
console.log(
  fail
    ? `❌ فشل ${fail} من ${cases.length}`
    : `✅ كل حالات الرد الصوتي نجحت (${pass})`,
);
process.exit(fail ? 1 : 0);
