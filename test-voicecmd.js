/**
 * فحص سريع لمنطق الأوامر الصوتية (بدون تشغيل البوت).
 * التشغيل: node test-voicecmd.js
 */
'use strict';

const { normAr, voiceToggleIntent, forSpeech, runVoiceCommand } = require('./bot');

const guild = {
  id: 'test-guild-0',
  channels: { cache: { get: () => null } },
  members: { me: { voice: { channel: null } } },
};

let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label} ${extra}`);
  }
}

function section(t) {
  console.log(`\n=== ${t} ===`);
}

async function main() {
  section('تنظيف النص (normAr)');
  ok(normAr('شغّل لي أغنية!') === 'شغل لي اغنيه', 'شغّل لي أغنية ليصير شغل لي اغنيه', normAr('شغّل لي أغنية!'));
  ok(normAr('أطلع من الروم') === 'اطلع من الروم', 'أطلع -> اطلع', normAr('أطلع من الروم'));

  section('أمر تشغيل/إيقاف الرد الصوتي');
  ok(voiceToggleIntent('وقف الرد الصوتي') === 'off', 'وقف الرد الصوتي = إيقاف');
  ok(voiceToggleIntent('اقفل المحادثة الصوتية') === 'off', 'اقفل المحادثة الصوتية = إيقاف');
  ok(voiceToggleIntent('لا ترد علي') === 'off', 'لا ترد علي = إيقاف');
  ok(voiceToggleIntent('شغّل الرد الصوتي') === 'on', 'شغّل الرد الصوتي = تشغيل');
  ok(voiceToggleIntent('كلمني') === 'on', 'كلمني = تشغيل');
  ok(voiceToggleIntent('وش أخبارك اليوم يا طيب') === null, 'كلام عادي = مو أمر');
  ok(voiceToggleIntent('اسكت') === null, 'اسكت = مو أمر إيقاف الرد (تنفّذ كإيقاف موسيقى)');

  section('تنقية النطق (forSpeech)');
  ok(forSpeech('▶️ شغّالة الآن: **فنان - أغنية** 🎧') === 'شغّالة الآن فنان أغنية', 'نشيل الرموز والإيموجي', forSpeech('▶️ شغّالة الآن: **فنان - أغنية** 🎧'));

  section('أوامر الروم بالصوت (runVoiceCommand)');
  const cases = [
    ['اطلع من الروم', (r) => r && /اطلع من/.test(r.say)],
    ['كم عمرك', (r) => r === null],
    ['وش أخبارك اليوم', (r) => r === null],
    ['التالية', (r) => r && /ما فيه شي شغال/.test(r.say)],
    ['وقف الأغنية', (r) => r && /ما فيه شي شغال/.test(r.say)],
    ['ارفع الصوت', (r) => r && /رفعت الصوت/.test(r.say)],
    ['نزّل الصوت', (r) => r && /نزلت الصوت/.test(r.say)],
    ['كرر الأغنية', (r) => r && /بكرر/.test(r.say)],
    ['وش شغال الحين', (r) => r && /ما فيه شي شغال/.test(r.say)],
    ['شغل لي أغنية', (r) => r && /وش الأغنية/.test(r.say)],
    ['طيب شغل لي كاظم الساهر', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['ادخل الروم', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['كوميك', (r) => r === null],
  ];

  for (const [text, check] of cases) {
    console.log(`  … أفحص "${text}"`);
    let r = null;
    try {
      r = await runVoiceCommand(guild, text);
    } catch (e) {
      console.log(`  ❌ "${text}" رمى خطأ: ${e.message}`);
      fail++;
      continue;
    }
    ok(check(r), `"${text}" -> ${r ? JSON.stringify(r.say) : 'null'}`);
  }

  console.log(`\nالنتيجة: ${pass} ناجح / ${fail} فاشل`);
  process.exit(fail ? 1 : 0);
}

main();
