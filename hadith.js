/**
 * روم الحديث النبوي 🕌
 * ينشر حديثاً صحيحاً مع المصدر كل ساعة (عشوائي وبدون تكرار متتالٍ).
 */

'use strict';

const HADITH_CHANNEL_ID = (process.env.HADITH_CHANNEL_ID || '1562222160104394843').trim();
const MIN_GAP_MS = 55 * 60 * 1000; // ننشر إذا مر 55 دقيقة على آخر رسالة (كل ساعة تقريباً)
const CHECK_MS = 5 * 60 * 1000; // نفحص كل 5 دقايق (ثبات حتى بعد إعادة التشغيل)

const HADITHS = [
  {
    text: '«إنما الأعمالُ بالنياتِ، وإنما لكلِّ امرئٍ ما نوى»',
    source: 'متفق عليه — رواه البخاري (١) ومسلم (١٩٠٧)',
  },
  {
    text: '«من كان يؤمن بالله واليوم الآخر فليقل خيراً أو ليصمت»',
    source: 'متفق عليه — رواه البخاري (٦٠١٨) ومسلم (٤٧)',
  },
  {
    text: '«لا يؤمن أحدُكم حتى يحبَّ لأخيه ما يحبُّ لنفسه»',
    source: 'متفق عليه — رواه البخاري (١٣) ومسلم (٤٥)',
  },
  {
    text: '«المسلمُ من سَلِمَ المسلمون من لسانه ويده»',
    source: 'متفق عليه — رواه البخاري (١٠) ومسلم (٤٠)',
  },
  {
    text: '«الدِّينُ النصيحة»',
    source: 'رواه مسلم (٥٥)',
  },
  {
    text: '«مَن غَشَّ فليس مني»',
    source: 'رواه مسلم (١٠١)',
  },
  {
    text: '«الطُّهورُ شطرُ الإيمان»',
    source: 'رواه مسلم (٢٢٣)',
  },
  {
    text: '«اتقوا النار ولو بشِقِّ تمرة»',
    source: 'متفق عليه — رواه البخاري (١٤١٣) ومسلم (١٠١٦)',
  },
  {
    text: '«الكلمةُ الطيبةُ صدقة»',
    source: 'متفق عليه — من حديث أبي هريرة في البخاري (٢٩٨٩) ومسلم (١٠٠٩)',
  },
  {
    text: '«تبسُّمُك في وجه أخيك صدقة»',
    source: 'رواه الترمذي (١٩٥٦) وقال: حسن صحيح',
  },
  {
    text: '«خيرُكم من تعلَّم القرآنَ وعلَّمه»',
    source: 'رواه البخاري (٥٠٢٧)',
  },
  {
    text: '«اقرَؤوا القرآنَ فإنه يأتي يوم القيامة شفيعاً لأصحابه»',
    source: 'رواه مسلم (٨٠٤)',
  },
  {
    text: '«من سلك طريقاً يلتمس فيه علماً سهَّل الله له طريقاً إلى الجنة»',
    source: 'رواه مسلم (٢٦٩٩)',
  },
  {
    text: '«ما نقصت صدقةٌ من مال»',
    source: 'رواه مسلم (٢٥٨٨)',
  },
  {
    text: '«أحبُّ الأعمال إلى الله أدومُها وإن قلَّ»',
    source: 'متفق عليه — رواه البخاري (٦٤٦٤) ومسلم (٧٨٣)',
  },
  {
    text: '«من لا يرحم الناس لا يرحمه الله»',
    source: 'متفق عليه — رواه البخاري (٧٣٧٦) ومسلم (٢٣١٩)',
  },
  {
    text: '«الساعي على الأرملة والمسكين كالمجاهد في سبيل الله»',
    source: 'متفق عليه — رواه البخاري (٥٣٥٣) ومسلم (٢٩٨٢)',
  },
  {
    text: '«من صلَّى الصبحَ فهو في ذمَّة الله»',
    source: 'رواه مسلم (٦٥٧)',
  },
  {
    text: '«أفضلُ الصدقة أن تصدَّق وأنت صحيحٌ شحيح»',
    source: 'متفق عليه — رواه البخاري (١٤١٩) ومسلم (١٠٣٢)',
  },
  {
    text: '«إن الله جميلٌ يحب الجمال»',
    source: 'رواه مسلم (٩١)',
  },
  {
    text: '«ما ملأ آدميٌّ وعاءً شراً من بطنه»',
    source: 'رواه الترمذي (٢٣٨٠) وقال: حسن صحيح',
  },
  {
    text: '«من حسن إسلام المرء تركه ما لا يعنيه»',
    source: 'رواه الترمذي (٢٣١٧) وقال: حسن',
  },
  {
    text: '«المؤمنُ للمؤمن كالبنيان يشدُّ بعضه بعضاً»',
    source: 'متفق عليه — رواه البخاري (٤٨١) ومسلم (٢٥٨٥)',
  },
  {
    text: '«من نفَّس عن مؤمن كربةً من كرب الدنيا نفَّس الله عنه كربةً من كرب يوم القيامة»',
    source: 'رواه مسلم (٢٦٩٩)',
  },
];

let lastKey = null;

function next() {
  let item;
  do {
    item = HADITHS[Math.floor(Math.random() * HADITHS.length)];
  } while (HADITHS.length > 1 && item.text === lastKey);
  lastKey = item.text;
  return item;
}

async function post(client, { force = false } = {}) {
  if (!client?.isReady?.()) return;
  const channel = await client.channels.fetch(HADITH_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  if (!force) {
    const last = await channel.messages.fetch({ limit: 1 }).catch(() => null);
    const lastAt = last?.first()?.createdTimestamp || 0;
    if (Date.now() - lastAt < MIN_GAP_MS) return;
  }

  const h = next();
  await channel
    .send({
      embeds: [
        {
          title: '🕌 حديث الساعة',
          description: `${h.text}\n\n**المصدر:** ${h.source}`,
          color: 0x9b59b6,
          footer: { text: 'روم الحديث النبوي • كل ساعة حديث صحيح' },
          timestamp: new Date().toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

function start(client) {
  // أول فحص بعد 45 ثانية، وبعدها كل 5 دقايق — ينشر إذا مر 55 دقيقة على آخر رسالة
  setTimeout(() => post(client).catch(() => {}), 45 * 1000);
  const timer = setInterval(() => post(client).catch(() => {}), CHECK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { start, post, HADITHS };
