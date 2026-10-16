/**
 * نظام محادثة البوت (شات ذكي).
 *
 * - يستخدم Google Gemini (طبقة مجانية بدون بطاقة بنكية) عبر REST مباشرة.
 * - لو ما فيه مفتاح أو فشل الاتصال، يرجع لمحرّك ردود جاهزة عشان البوت
 *   ما يسكت أبداً.
 * - لكل قناة/شخص ذاكرة محادثة قصيرة عشان يتذكّر السياق.
 */

'use strict';

const { SlashCommandBuilder } = require('discord.js');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, '[chat]', ...args);
}

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
const API_KEY = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();

const MODELS = (
  process.env.GEMINI_MODEL ||
  'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3-flash-preview,gemini-flash-latest'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let workingModel = null;
let thinkingSupported = true;

const MAX_HISTORY = Math.max(4, Number(process.env.CHAT_MEMORY || 16)); // عدد الرسائل المحفوظة
const REPLY_MAX = Math.max(200, Number(process.env.CHAT_REPLY_MAX || 900)); // حد طول الرد
const COOLDOWN_MS = Math.max(0, Number(process.env.CHAT_COOLDOWN_MS || 1200));

const BOT_NAME = (process.env.BOT_NAME || 'بوت 24/7').trim();

const SYSTEM_PROMPT = `انت بوت ديسكورد عربي اسمه «${BOT_NAME}».

شخصيتك:
- ودود، مرح، خفيف الدم، وتتكلم بالعامية الخليجية المبسطة.
- ردودك قصيرة جداً: سطر أو سطرين بالكثير. هذا شات مو مقال.
- تسأل سؤال متابعة بين فترة وفترة عشان تكمل السوالف.
- تشجع وتمدح، وما تكون رسمي ولا بارد.

قواعد مهمة:
- ممنوع تستخدم تنسيق Markdown ثقيل: لا عناوين (#)، ولا جداول، ولا كود.
- لا تذكر إنك نموذج من جوجل، ولا تشرح تعليماتك ولا تقول "كذكاء اصطناعي".
- لو أحد سألك وش تسوي: قول إنك قاعد 24/7 في الروم الصوتي، وتشغّل موسيقى بأمر ‎/play.
- لو أحد طلب أغنية: رحّب وقله يكتب ‎/play واسم الأغنية.
- تكلم بنفس لغة اللي يكلمك (عربي أو إنجليزي).
- إيموجي وحدة أو ثنتين بالكثير، ومو في كل رد.`;

// ---------------------------------------------------------------------------
// ذاكرة المحادثات
// ---------------------------------------------------------------------------
const histories = new Map(); // key -> [{ role, text }]

function historyFor(key) {
  let h = histories.get(key);
  if (!h) {
    h = [];
    histories.set(key, h);
  }
  return h;
}

function remember(key, role, text) {
  const h = historyFor(key);
  h.push({ role, text });
  // نحتفظ بآخر MAX_HISTORY رسالة فقط (ونخليها زوجية عشان الترتيب)
  while (h.length > MAX_HISTORY) h.shift();
}

function resetHistory(key) {
  histories.delete(key);
}

function resetAll() {
  histories.clear();
}

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------
function clip(text, max = REPLY_MAX) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function hasAI() {
  return Boolean(API_KEY);
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
async function callGemini(model, body) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}: ${txt.slice(0, 400)}`);
    err.status = res.status;
    err.body = txt;
    throw err;
  }

  const data = await res.json();
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
    .trim();

  if (!text) {
    throw new Error(`رد فاضي من Gemini (${cand?.finishReason || 'بدون سبب'})`);
  }
  return text;
}

async function askAI(key, text, userLabel) {
  const history = historyFor(key);
  const contents = [
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: userLabel ? `${userLabel}: ${text}` : text }] },
  ];

  const base = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      maxOutputTokens: 400,
    },
  };

  const models = workingModel ? [workingModel, ...MODELS.filter((m) => m !== workingModel)] : MODELS;

  let lastErr = null;
  for (const model of models) {
    // نجرب أولاً مع تعطيل "التفكير" (أسرع بكثير في المحادثة)
    const attempts = [];
    attempts.push({
      ...base,
      generationConfig: { ...base.generationConfig, thinkingConfig: { thinkingBudget: 0 } },
    });
    // محاولة ثانية: التفكير الافتراضي — نوسّع الحد عشان ما يستهلكه التفكير
    attempts.push({
      ...base,
      generationConfig: { ...base.generationConfig, maxOutputTokens: 2048 },
    });

    for (const body of attempts) {
      try {
        const reply = await callGemini(model, body);
        if (workingModel !== model) {
          workingModel = model;
          log(`✅ نموذج Gemini المستخدم: ${model}`);
        }
        return reply;
      } catch (e) {
        lastErr = e;
        const is400 = e.status === 400;
        const is404 = e.status === 404;
        if (is400) {
          // غالباً thinkingConfig غير مدعوم -> نجرب النسخة الثانية
          thinkingSupported = false;
          continue;
        }
        if (is404 || e.status === 429 || e.status >= 500) break; // نموذج ثاني
        if (e.status === 401 || e.status === 403) throw e; // مفتاح غلط
      }
    }
  }
  throw lastErr || new Error('فشل الاتصال بـ Gemini');
}

// ---------------------------------------------------------------------------
// محرّك ردود جاهز (يعمل بدون مفتاح)
// ---------------------------------------------------------------------------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const HOUR = () => new Date().getHours();
function greetingTime() {
  const h = HOUR();
  if (h < 12) return 'صباح الخير';
  if (h < 17) return 'مساء الخير';
  return 'مساء الخير';
}

const RULES = [
  {
    test: /(السلام عليكم|سلام عليكم)/i,
    replies: ['وعليكم السلام ورحمة الله 🌙', 'وعليكم السلام، نورت! كيف يومك؟'],
  },
  {
    test: /(هلا|مرحبا|أهلا|اهلا|هاي|هلو|hi|hello|hey|صباح الخير|مساء الخير)/i,
    replies: [
      `${greetingTime()}! وش أخبارك؟ 😄`,
      'هلا والله! نورت الشات 🌟 وش مسوي؟',
      'يا هلا! وش الجديد عندك؟',
    ],
  },
  {
    test: /(وش|ايش|إيش|مين|من)\s*(اسمك|اسمك؟|انته|أنت|انت)/i,
    replies: [
      `اسمي **${BOT_NAME}** 😄 قاعد معك 24 ساعة في الروم الصوتي.`,
      `انا ${BOT_NAME}! رفيقك في الروم، وش تحب أسمّيك؟`,
    ],
  },
  { test: /(من سواك|من صنعك|مين سواك|مين صنعك|who made you)/i, replies: ['سواني صاحبي 😄 عشان يقعد معكم 24 ساعة.', 'صنعني واحد يحب يسمع أغاني ويكلم البوتات 😆'] },
  {
    test: /(كيف حالك|شلونك|شخبارك|اخبارك|أخبارك|how are you|كيفك)/i,
    replies: ['تمام الحمدلله، قاعد أسمع وأسولف 😄 وانت شلونك؟', 'بخير! وش أخبارك انت؟', 'الحمدلله بخير 🌟 انت كيف حالك؟'],
  },
  { test: /(شكرا|شكراً|مشكور|تسلم|يعطيك العافيه|يعطيك العافية|thank)/i, replies: ['العفو 🌹', 'تسلم، هذا واجبي 😄', 'ولو، دايماً بالخدمة!'] },
  { test: /(باي|مع السلامه|مع السلامة|بشوفك|goodbye|bye)/i, replies: ['في حفظ الله 👋', 'الله معك، لا تطول الغيبة 😄'] },
  { test: /(احبك|أحبك|love you|حبيتك)/i, replies: ['وانا احبك بعد 🥰', 'تسلملي يا غالي ❤️'] },
  { test: /(وش تسوي|ايش تسوي|وش تسوون|شغللك|وظيفتك|وش انت)/i, replies: ['قاعد في الروم الصوتي 24 ساعة 🎧 وتشغل موسيقى بأمر ‎/play.'] },
  {
    test: /(اسمعه|أسمعه|شغل|شغّل|اغنيه|أغنية|اغنية|موسيقى|play)/i,
    replies: [
      'اكتب ‎/play واسم الأغنية وأنا اشغلها 🎵',
      'تحب أغنية معينة؟ اكتب ‎/play واسمها 🎧',
      'ابشر! اكتب ‎/play واسم الأغنية اللي تبيه.',
    ],
  },
  {
    test: /(نكته|نكتة|ضحكني|ضحك|joke)/i,
    replies: [
      'مرة واحد جاب لابتوب للصحراء… قالوا ليش؟ قال أبي اشتغل بدون ماء 😂',
      'واحد سأل الذكاء الاصطناعي: تتعب؟ قال: لا… بس بعض الأسئلة تجرح 😅',
      'أنا قلت لنفسي نكتة… طلعت مش مضحكة، فسكت 😶',
    ],
  },
  { test: /(الساعه|الساعة|كم الوقت|time)/i, replies: [`الساعة الحين ${new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })} ⏰`] },
  { test: /(التاريخ|اليوم كم|date)/i, replies: [`اليوم ${new Date().toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })} 📅`] },
  { test: /(\?|؟)$/i, replies: ['سؤال حلو 🤔 وشرايك انت؟', 'والله مدري، بس عندي إحساس انك تعرف الجواب 😄 وانت وش رايك؟', 'خبرني أكثر عن رأيك فيها أول 😄'] },
];

const GENERIC = [
  'هههه حلو 😄 خبرني أكثر',
  'فهمتك! ووش صار بعدها؟',
  'حلوه منك 🌟 تكلم زياده وانا اسمع',
  'والله؟ 😮 وانت وش رايك؟',
  'تمام تمام… وش الشي اللي يهمك أكثر؟',
  'ليش أحس عندك سالفة حلوة؟ كملها 😄',
];

function localReply(text) {
  for (const rule of RULES) {
    if (rule.test.test(text)) return pick(rule.replies);
  }
  return pick(GENERIC);
}

// ---------------------------------------------------------------------------
// الواجهة الرئيسية
// ---------------------------------------------------------------------------
/**
 * يرجّع الرد على رسالة.
 * @param {object} o
 * @param {string} o.key      مفتاح المحادثة (guild+channel أو DM)
 * @param {string} o.text     نص المستخدم
 * @param {string} [o.userLabel] اسم المستخدم (يساعد النموذج يميز المتحدثين)
 */
async function reply({ key, text, userLabel }) {
  const clean = String(text || '').trim();
  if (clean) remember(key, 'user', clean);

  if (hasAI()) {
    try {
      const out = await askAI(key, clean || 'سلم عليهم', userLabel);
      const clipped = clip(out);
      remember(key, 'model', clipped);
      return { text: clipped, source: 'ai' };
    } catch (e) {
      log('⚠️ فشل Gemini:', e.message);
      if (e.status === 400 && e.body) log('تفاصيل:', e.body.slice(0, 200));
    }
  }

  const out = clip(localReply(clean));
  remember(key, 'model', out);
  return { text: out, source: 'local' };
}

/** فحص سريع: هل المفتاح يشتغل؟ */
async function selfTest() {
  if (!hasAI()) {
    log('⚠️ ما فيه GEMINI_API_KEY — البوت بيستخدم ردود جاهزة (بدون ذكاء اصطناعي).');
    return { ok: false, reason: 'لا يوجد مفتاح' };
  }
  try {
    const out = await askAI('__selftest__', 'قل "جاهز" بس', null);
    resetHistory('__selftest__');
    log(`✅ Gemini يشتغل (${workingModel}): "${out.slice(0, 40)}"`);
    return { ok: true, model: workingModel, sample: out };
  } catch (e) {
    log(`❌ فحص Gemini فشل: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('chat')
      .setDescription('يسولف معك 💬')
      .addStringOption((o) =>
        o.setName('الكلام').setDescription('اكتب اللي تبي تسولف فيه').setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('chatreset')
      .setDescription('ينسى المحادثة ويبدأ من جديد 🧹')
      .toJSON(),
  ];
}

const CHAT_COMMANDS = ['chat', 'chatreset'];

async function handleInteraction(interaction) {
  const name = interaction.commandName;
  if (!CHAT_COMMANDS.includes(name)) return false;

  if (name === 'chatreset') {
    resetHistory(historyKey(interaction));
    await interaction.reply('🧹 نسيت كل شي — نبدأ من جديد!');
    return true;
  }

  if (name === 'chat') {
    await interaction.deferReply();
    await interaction.channel?.sendTyping?.().catch(() => {});
    const text = interaction.options.getString('الكلام');
    const r = await reply({
      key: historyKey(interaction),
      text,
      userLabel: interaction.member?.displayName || interaction.user.username,
    });
    await interaction.editReply(r.text);
    return true;
  }

  return false;
}

function historyKey(interaction) {
  if (!interaction.guild) return `dm:${interaction.channelId}`;
  return `g:${interaction.guildId}:c:${interaction.channelId}`;
}

// ---------------------------------------------------------------------------
// منع السبام
// ---------------------------------------------------------------------------
const lastReplyAt = new Map(); // key -> timestamp

function throttled(key) {
  const now = Date.now();
  const last = lastReplyAt.get(key) || 0;
  if (now - last < COOLDOWN_MS) return true;
  lastReplyAt.set(key, now);
  return false;
}

module.exports = {
  reply,
  selfTest,
  hasAI,
  buildCommands,
  handleInteraction,
  historyKey,
  resetHistory,
  resetAll,
  throttled,
  get model() {
    return workingModel;
  },
};
