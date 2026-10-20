'use strict';
// اختبار منطق أوامر الشات (موسيقى/إيقاف/تخطي...) — يستخرج الأجزاء النقية من bot.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(SRC, 'utf8');

function grab(startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('ما لقيت: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('ما لقيت النهاية: ' + endMarker);
  return src.slice(i, j);
}

const code = [
  grab('const PLAY_INTENT =', 'async function resolveVoiceChannel'),
  grab('function normAr(s) {', '// عبارات إيقاف الرد الصوتي'),
  grab('const V_NOW_RE =', 'const V_STOP_RE ='),
  grab('const V_STOP_RE =', 'const V_SKIP_RE ='),
  grab('const V_SKIP_RE =', 'const V_GENERIC_SONG_RE ='),
  grab('function cleanSongQuery(raw) {', 'function botVoiceChannel'),
].join('\n');

const mod = {};
new Function(
  'mod',
  code +
    '\nmod.normAr=normAr;mod.matchStopCommand=matchStopCommand;mod.cleanSongQuery=cleanSongQuery;' +
    'mod.PLAY_INTENT=PLAY_INTENT;mod.PLAY_INTENT2=PLAY_INTENT2;mod.STOP_INTENT=STOP_INTENT;' +
    'mod.SKIP_INTENT=SKIP_INTENT;mod.V_SKIP_RE=V_SKIP_RE;mod.V_PAUSE_RE=V_PAUSE_RE;' +
    'mod.V_RESUME_RE=V_RESUME_RE;mod.V_LOOP_RE=V_LOOP_RE;mod.V_LOOP_OFF_RE=V_LOOP_OFF_RE;' +
    'mod.V_VOL_UP_RE=V_VOL_UP_RE;mod.V_VOL_DOWN_RE=V_VOL_DOWN_RE;mod.V_NOW_RE=V_NOW_RE;' +
    'mod.GENERIC_SONG_Q=GENERIC_SONG_Q;',
)(mod);

const playing = true; // أسوأ حالة: فيه أغنية شغالة

function classify(text) {
  const m = mod;
  const t = m.normAr(text);
  if (m.STOP_INTENT.test(text) || m.STOP_INTENT.test(t) || m.matchStopCommand(t, playing))
    return 'STOP';
  if (m.SKIP_INTENT.test(text) || m.SKIP_INTENT.test(t) || m.V_SKIP_RE.test(t)) return 'SKIP';
  if (playing && m.V_PAUSE_RE.test(t)) return 'PAUSE';
  if (playing && m.V_RESUME_RE.test(t)) return 'RESUME';
  if (m.V_LOOP_OFF_RE.test(t)) return 'LOOP_OFF';
  if (m.V_LOOP_RE.test(t)) return 'LOOP';
  if (playing && (m.V_VOL_UP_RE.test(t) || m.V_VOL_DOWN_RE.test(t))) return 'VOLUME';
  if (playing && m.V_NOW_RE.test(t)) return 'NOW';
  const play = text.match(m.PLAY_INTENT) || t.match(m.PLAY_INTENT) || text.match(m.PLAY_INTENT2);
  if (play) {
    const q = m.cleanSongQuery((play[1] || '').replace(/^لي\s+/, '').trim());
    if (!q || m.GENERIC_SONG_Q.test(m.normAr(q))) return 'ASK_NAME';
    return 'PLAY(' + q + ')';
  }
  return null;
}

const cases = [
  ['طفها', 'STOP'],
  ['طف الأغنية', 'STOP'],
  ['وقف', 'STOP'],
  ['اوقف الموسيقى', 'STOP'],
  ['طفيها يا بوت', 'STOP'],
  ['سكرها', 'STOP'],
  ['شغل لي محمد عبده', 'PLAY(محمد عبده)'],
  ['شغل محمد عبده', 'PLAY(محمد عبده)'],
  ['شغّل لي اغنية راشد الماجد', 'PLAY(راشد الماجد)'],
  ['ابي اغنية خالد عبدالرحمن', 'PLAY(خالد عبدالرحمن)'],
  ['حط لي طلال مداح', 'PLAY(طلال مداح)'],
  ['سمعني أم كلثوم', 'PLAY(أم كلثوم)'],
  ['اليوم الجو حلو صح', null],
  ['طيب وش رايك بالفكرة', null],
  ['التالي', 'SKIP'],
  ['غير الأغنية', 'SKIP'],
  ['كمل', 'RESUME'],
  ['وقف مؤقت', 'PAUSE'],
  ['نزل الصوت', 'VOLUME'],
  ['ارفع الصوت', 'VOLUME'],
  ['كررها', 'LOOP'],
  ['وقف التكرار', 'LOOP_OFF'],
  ['وش شغال الحين', 'NOW'],
  ['شغل الأغنية', 'ASK_NAME'],
  ['شغل لي', null],
  ['السلام عليكم', null],
  ['كيف حالك', null],
];

let fail = 0;
let pass = 0;
for (const [text, expect] of cases) {
  const got = classify(text);
  const ok = expect === null ? got === null || got === 'ASK_NAME' : got === expect;
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ "${text}" -> ${got}   (المتوقع: ${expect})`);
}
console.log(
  fail ? `❌ فشل ${fail} من ${cases.length}` : `✅ كل حالات أوامر الشات نجحت (${pass})`,
);
process.exit(fail ? 1 : 0);
