/**
 * فحص سريع لمنطق الأوامر الصوتية (بدون تشغيل البوت).
 * التشغيل: node test-voicecmd.js
 */
'use strict';

const { normAr, voiceToggleIntent, forSpeech, runVoiceCommand, looksLikeEcho, translitArabic } = require('./bot');
const { isJunkTranscript } = require('./speech');
const { scoreMatch, normTitle } = require('./music');

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

  section('فلتر الهلوسة (isJunkTranscript)');
  ok(isJunkTranscript('ترجمة نانسي قنقر') === true, '«ترجمة نانسي قنقر» = هلوسة');
  ok(isJunkTranscript('أمثلة تدريبية عامية بين شخص وبوت ديسكورد.') === true, 'نص التلميح = هلوسة');
  ok(isJunkTranscript('المزيد من الفيديوهات') === true, '«المزيد من الفيديوهات» = هلوسة');
  ok(isJunkTranscript('') === true, 'الفاضي = مرفوض');
  ok(isJunkTranscript('شغّل أغنية Love and Cut Walk') === false, 'طلب أغنية = كلام حقيقي');
  ok(isJunkTranscript('هلا وش أخبارك اليوم') === false, 'كلام عادي = حقيقي');

  section('كشف صدى صوت البوت (looksLikeEcho)');
  ok(looksLikeEcho('حاضر أشغلها لك', 'طيب، حاضر أشغلها لك') === true, 'نفس كلام البوت = صدى');
  ok(looksLikeEcho('هلا وش أخبارك', 'طيب، شغالة الآن أغنية') === false, 'كلام مختلف = مو صدى');

  section('اختيار الأغنية الصحيحة (scoreMatch)');
  const song = (title, uploader = '', duration = 240) => ({ title, uploader, duration });
  const s1 = scoreMatch('كاظم الساهر مدرسة الحب', song('Kadim Al Saher Fi Madrasat Al Hob كاظم الساهر - في مدرسة الحب'));
  ok(s1 >= 0.8, `الاسم كامل -> ${s1.toFixed(2)}`);
  const s2 = scoreMatch('محمد عبده', song('الاماكن - محمد عبده'));
  ok(s2 >= 0.6, `فنان فقط -> ${s2.toFixed(2)}`);
  const s3 = scoreMatch('Love on the Catwalk', song('Her Words Kill - Love On The Catwalk'));
  ok(s3 >= 0.8, `إنجليزي -> ${s3.toFixed(2)}`);
  const s4 = scoreMatch('راشد الماجد', song('أغنية رعب بدون علاقة'));
  ok(s4 < 0.45, `نتيجة عشوائية -> ${s4.toFixed(2)}`);
  const s5 = scoreMatch('asdkjhasd qweqwe', song('أغنية حلوة'));
  ok(s5 < 0.45, `كلام فاضي -> ${s5.toFixed(2)}`);
  const s6 = scoreMatch('رابح صقر شاريك', song('رابح صقر - شاريك (حصرياً) 2019'));
  ok(s6 >= 0.8, `اسم + أغنية -> ${s6.toFixed(2)}`);
  const s7 = scoreMatch('محمد عبده', song('محمد عبده - الاماكن (ريمكس slowed)'));
  ok(s7 < s2, `الريمكس أقل من الأصلي (${s7.toFixed(2)} < ${s2.toFixed(2)})`);
  ok(normTitle('شغّل  الأغنية') === 'شغل الاغنيه', 'تنظيف الهمزات والتشكيل', normTitle('شغّل  الأغنية'));

  section('تحويل الأسماء الأجنبية (translitArabic)');
  ok(
    /^[a-z\s]+$/i.test(translitArabic('لاف اون ذي كاتووك')),
    'اسم أجنبي بالعربي -> لاتيني: ' + translitArabic('لاف اون ذي كاتووك'),
  );
  ok(translitArabic('كاظم الساهر').length > 4, 'الأسماء العربية تتحول لاتيني', translitArabic('كاظم الساهر'));

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
    ['شغلي كاظم الساهر', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['شغل اغنية كاظم الساهر', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['ابغى اسمع محمد عبده', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['طيب شغل لي كاظم الساهر', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['ادخل الروم', (r) => r && /ما لقيت الروم الصوتي/.test(r.say)],
    ['لا مو هذي', (r) => r && /ما عندي بدائل/.test(r.say)],
    ['مو هذي', (r) => r && /ما عندي بدائل/.test(r.say)],
    ['غيرها', (r) => r && /ما عندي بدائل/.test(r.say)],
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
