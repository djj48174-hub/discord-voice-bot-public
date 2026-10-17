/**
 * وحدة الصوت للمحادثة الصوتية:
 *   - STT: تفريغ الصوت المرفوع من ديسكورد إلى نص (Groq Whisper)
 *   - TTS: تحويل رد الذكاء الاصطناعي إلى صوت (أصوات مايكروسوفت العربية المجانية)
 *
 * ملاحظة: ديسكورد يرسل حزم Opus خام -> نغلّفها بـ Ogg (ogg.js) -> ffmpeg -> WAV -> Groq.
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { muxOggOpus } = require('./ogg');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, '[speech]', ...args);
}

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
const GROQ_KEY = (process.env.GROQ_API_KEY || '').trim();
// whisper-large-v3 أدق للعامية الخليجية (turbo أسرع لكنه يغلط أكثر)
const STT_MODEL = (process.env.STT_MODEL || 'whisper-large-v3').trim();
const STT_TIMEOUT_MS = Math.max(5000, Number(process.env.STT_TIMEOUT_MS || 25000));
// تلميح اختياري لـ Whisper.
// ⚠️ تحذير مهم: التلميح الطويل يخلي الموديل "يهلوس" ويردّد نص التلميح على الصمت
// (شفناه في التشغيل: طلع "أمثلة تدريبية عامية بين شخص وبوت ديسكورد") — فخليه فاضي.
// تلميح قصير (سطر واحد) يوجّه Whisper للهجة والمجال — التلميح الطويل يسبب هلوسة
// (شفناه في التشغيل: طلع "أمثلة تدريبية عامية بين شخص وبوت ديسكورد") فخليناه سطر واحد.
const STT_PROMPT = (process.env.STT_PROMPT !== undefined ? String(process.env.STT_PROMPT) : 'محادثة سعودية عامية.').trim();

// جُمل يخترعها Whisper على الصمت/الضجيج — نتجاهلها
const STT_JUNK = [
  'ترجمه نانسي قنقر',
  'ترجمه نانسي',
  'المزيد من الفيديوهات',
  'اشترك في القناه',
  'شكرا على المشاهده',
  'محادثه صوتيه سعوديه',
  'بوت ديسكورد',
  'امثله عاميه',
  'امثله تدريبيه',
  'خيالتان رائعه',
  'الترجمه من',
  'ترجمه من',
  'لا تنسى الاشتراك',
  'اشتركوا في القناه',
  'اشتركوا في القناة',
  'لا تنسوا الاشتراك',
  'شكرا لكم على المشاهده',
  'المزيد من المقاطع',
  'تابعونا',
  'شكرا للمشاهده',
  'شكرا لكم',
];

/** تنظيف نص للمقارنة */
function sttNorm(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const STT_JUNK_NORM = STT_JUNK.map(sttNorm);

/** هل النص هلوسة/كلام فاضي (مو كلام حقيقي)؟ */
function isJunkTranscript(text) {
  const t = sttNorm(text);
  if (!t) return true;
  if (STT_JUNK_NORM.some((j) => j && t.includes(j))) return true;
  // تكرار نفس الجملة مرتين = هلوسة معروفة
  const half = Math.floor(t.length / 2);
  if (t.length > 14 && t.slice(0, half).trim() === t.slice(-half).trim()) return true;
  // لو النص كله مأخوذ من التلميح = هلوسة
  const p = sttNorm(STT_PROMPT);
  if (p) {
    const words = t.split(' ').filter((w) => w.length > 2);
    if (words.length && words.every((w) => p.includes(w))) return true;
  }
  return false;
}

const TTS_RATE = (process.env.TTS_RATE || '+8%').trim();
// سرعة النطق (1 = عادي) — نسرّع شوي عشان الرد يوصل أسرع (بدون ما يتغيّر الصوت)
const TTS_SPEED = Math.max(0.8, Math.min(1.5, Number(process.env.TTS_SPEED || 1.12)));

/** فلتر ffmpeg لتسريع الكلام بدون تغيير النبرة */
function ttsSpeedFilter(speed = TTS_SPEED) {
  if (!speed || Math.abs(speed - 1) < 0.02) return '';
  return `atempo=${speed.toFixed(2)}`;
}

// أصوات عربية *رجالية خليجية* فقط — نحافظ على هوية صوتية واحدة ثابتة للبوت
// (الأسماء مؤكدة من قائمة مايكروسوفت — الانتبه: الكويتي اسمه Fahed مو Naayf)
const MALE_ARABIC_VOICES = [
  'ar-SA-HamedNeural', // سعودي (الأساسي)
  'ar-AE-HamdanNeural', // إماراتي
  'ar-KW-FahedNeural', // كويتي
  'ar-QA-MoazNeural', // قطري
  'ar-BH-AliNeural', // بحريني
  'ar-OM-AbdullahNeural', // عماني
];
// الصوت الأساسي (ثابت) — والباقي للاحتياط فقط عند فشل الصوت الأساسي
const TTS_VOICE = (process.env.TTS_VOICE || MALE_ARABIC_VOICES[0]).trim();

let voiceCursor = 0;
/** الصوت الأساسي الرجالي (يتغيّر فقط عند فشل الصوت الأساسي) */
function nextVoice() {
  return TTS_VOICE;
}
/** قائمة الأصوات الرجالية للتجربة بالترتيب (الأساسي أولاً) */
function voiceFallbacks(primary) {
  const base = primary || TTS_VOICE;
  return [base, ...MALE_ARABIC_VOICES.filter((v) => v !== base)];
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------
let FFMPEG = null;
function ffmpegPath() {
  if (FFMPEG) return FFMPEG;
  if (process.env.FFMPEG_PATH) {
    FFMPEG = process.env.FFMPEG_PATH;
  } else {
    FFMPEG = 'ffmpeg';
    try {
      const s = require('ffmpeg-static');
      if (s && fs.existsSync(s)) FFMPEG = s;
    } catch {
      /* نستخدم ffmpeg من النظام */
    }
  }
  return FFMPEG;
}

// ---------------------------------------------------------------------------
// TTS — تحويل النص إلى صوت (Ogg Opus 48kHz ستيريو — نفس صيغة الموسيقى)
// ---------------------------------------------------------------------------
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * أي صوت (mp3/webm/wav/ogg) -> Ogg Opus 48kHz ستيريو بنفس إعدادات نغمة الاختبار.
 * نعيد الترميز دائماً (مو remux) عشان ديسكورد يسمع بوضوح.
 */
function toDiscordOgg(inputBuf, extraFilter = '') {
  return new Promise((resolve, reject) => {
    const af = ['aresample=48000', 'volume=2.5', extraFilter].filter(Boolean).join(',');
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-af',
        af,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-application',
        'audio',
        '-frame_duration',
        '20',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { windowsHide: true },
    );

    const out = [];
    const err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 200) {
        reject(
          new Error(
            `تحويل الصوت فشل: ${Buffer.concat(err).toString().trim().slice(0, 200) || 'exit ' + code}`,
          ),
        );
        return;
      }
      resolve(buf);
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(inputBuf);
  });
}

/** @deprecated استخدم toDiscordOgg */
function webmToOgg(webm) {
  return toDiscordOgg(webm);
}

/**
 * نغمة اختبار (بدون إنترنت) — لتشخيص مسار التشغيل بشكل مستقل عن محرّكات النطق.
 */
function testTone(seconds = 3, freq = 440) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${freq}:duration=${seconds}`,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    const out = [];
    const err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => {
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 200) {
        return reject(new Error(Buffer.concat(err).toString().trim().slice(0, 150) || 'فشل توليد النغمة'));
      }
      resolve(buf);
    });
  });
}

/**
 * صوت عربي مجاني احتياطي (Google Translate) — لما Edge TTS ينقطع.
 */
async function speakGoogle(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('ما فيه نص');
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=ar&client=tw-ob&q=' +
    encodeURIComponent(clean);

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Google TTS ${res.status}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  if (mp3.length < 500) throw new Error('صوت فاضي من Google TTS');
  // صوت قوقل نسائي -> ننزّل النبرة عشان يصير رجالي (احتياطي أخير فقط)
  const filters = [
    extraFilterMale(process.env.GOOGLE_TTS_MALE === 'false' ? '' : 'google'),
    ttsSpeedFilter(),
  ].filter(Boolean);
  return toDiscordOgg(mp3, filters.join(','));
}

/** فلتر تنزيل النبرة (رجالي) — يُستخدم للاحتياطي النسائي فقط */
function extraFilterMale(provider) {
  if (provider !== 'google') return '';
  return 'aresample=24000,asetrate=24000*0.85,aresample=48000,atempo=1.1765';
}

/**
 * محرّك Edge TTS (أصوات مايكروسوفت العربية) — مجاني لكن يتقيّد (429).
 */
async function speakEdge(text, opts = {}) {
  const voices = voiceFallbacks(opts.voice);
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(3, voices.length); attempt++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voices[attempt], OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = await tts.toStream(text, { rate: opts.rate || TTS_RATE });

      if (attempt === 0) log(`🎙️ الصوت: ${voices[attempt]} (رجالي)`);

      const mp3 = await streamToBuffer(audioStream);
      if (mp3.length < 200) throw new Error('الصوت فاضي من محرّك النطق');
      return await toDiscordOgg(mp3);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      log(`⚠️ محاولة Edge (${voices[attempt]}) ${attempt + 1} فشلت: ${msg.slice(0, 90)}`);
      // 429 = تقييد — ننتقل للاحتياطي بسرعة
      if (/\b429\b|rate.?limit|throttl/i.test(msg)) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('فشل Edge TTS');
}

// مزوّدو النطق اللي فشلوا مؤقتاً — نتخطاهم بدل ما نضيّع وقت ونغيّر الصوت كل مرة
const ttsCooldown = new Map(); // provider -> { until, why }

function ttsCooling(p) {
  const c = ttsCooldown.get(p);
  if (!c) return false;
  if (Date.now() >= c.until) {
    ttsCooldown.delete(p);
    return false;
  }
  return true;
}

function setTtsCooldown(p, ms, why) {
  if (ttsCooling(p)) return;
  ttsCooldown.set(p, { until: Date.now() + ms, why });
  log(`⏸️ ${p}: أوقفته مؤقتاً ${Math.round(ms / 1000)} ثانية (${why})`);
}

/**
 * يرجّع صوتاً (Ogg Opus 48kHz ستيريو) جاهزاً للتشغيل في ديسكورد مباشرة.
 * الترتيب عبر TTS_ORDER — الافتراضي: Edge (صوت سعودي رجالي ثابت) -> Groq -> Google
 * سبب ترتيب Edge أولاً: Groq Orpheus يتقيّد كثير (429) فيتغيّر الصوت فجأة.
 */
async function speak(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('ما فيه نص للنطق');

  const order = String(process.env.TTS_ORDER || 'edge,groq,google')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let lastErr = null;

  // نتخطى المزوّد اللي فشل مؤخراً (يصير الصوت أثبت + أسرع بلا محاولات ضايعة)
  let providers = order.filter((p) => !ttsCooling(p));
  if (!providers.length) {
    log('⚠️ كل محركات النطق في فترة توقف — أحاول الأول على أي حال');
    providers = [order[0]];
  }

  for (const provider of providers) {
    try {
      if (provider === 'groq') {
        if (!GROQ_KEY) throw new Error('ما فيه مفتاح Groq للنطق');
        const ogg = await speakGroq(clean, opts);
        log(`🔊 صوت جاهز (Groq ${GROQ_TTS_VOICE}): ${ogg.length} بايت`);
        return ogg;
      }
      if (provider === 'edge') {
        const ogg = await speakEdge(clean, opts);
        log(`🔊 صوت جاهز (Edge ${opts.voice || TTS_VOICE}): ${ogg.length} بايت`);
        return ogg;
      }
      if (provider === 'google') {
        const ogg = await speakGoogle(clean);
        log(`🔊 صوت جاهز (Google): ${ogg.length} بايت`);
        return ogg;
      }
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      log(`⚠️ فشل النطق عبر ${provider}: ${msg.slice(0, 110)}`);
      if (/requires terms acceptance|model_terms_required/i.test(msg)) {
        log(
          '👉 مطلوب موافقة شروط Groq مرة واحدة فقط (من حسابك): ' +
            'https://console.groq.com/playground?model=canopylabs%2Forpheus-arabic-saudi',
        );
        setTtsCooldown(provider, 60 * 60 * 1000, 'يحتاج موافقة شروط');
      } else if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
        setTtsCooldown(provider, 15 * 60 * 1000, 'تجاوز الحد (429)');
      } else {
        setTtsCooldown(provider, 2 * 60 * 1000, 'خطأ مؤقت');
      }
    }
  }

  throw lastErr || new Error('فشل توليد الصوت');
}

/** أصوات Groq Orpheus العربية *الرجالية* فقط (+ abdullah, fahad, sultan) */
const GROQ_MALE_VOICES = ['abdullah', 'fahad', 'sultan'];
const GROQ_TTS_VOICE = (process.env.GROQ_TTS_VOICE || GROQ_MALE_VOICES[0]).trim();
const GROQ_TTS_MODEL = (
  process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-arabic-saudi'
).trim();

async function speakGroq(text, opts = {}) {
  const voice = opts.groqVoice || GROQ_TTS_VOICE;
  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: GROQ_TTS_MODEL,
      input: String(text).slice(0, 600),
      voice,
      response_format: 'wav',
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Groq TTS ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const wav = Buffer.from(await res.arrayBuffer());
  if (wav.length < 500) throw new Error('صوت فاضي من Groq TTS');
  return toDiscordOgg(wav, ttsSpeedFilter());
}

// ---------------------------------------------------------------------------
// STT — تفريغ الصوت إلى نص
// ---------------------------------------------------------------------------
/** Ogg Opus -> WAV (16kHz مونو — الأفضل لـ Whisper) + قياس مستوى الصوت */
function oggToWav(ogg) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        // info مهمة عشان volumedetect يطبع المستوى
        '-loglevel',
        'info',
        '-f',
        'ogg',
        '-i',
        'pipe:0',
        // ننظّف الصوت (تنقية ضجيج + رفع الصوت الواطي) ونقيس مستواه الأصلي أولاً
        '-af',
        'volumedetect,highpass=f=80,afftdn=nf=-25,dynaudnorm=f=200:g=15:p=0.95,volume=3dB,alimiter=limit=0.95',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        'wav',
        'pipe:1',
      ],
      { windowsHide: true },
    );

    const out = [];
    const err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', (e) => reject(e));
    ff.on('close', (code) => {
      const errTxt = Buffer.concat(err).toString();
      if (code !== 0) {
        reject(new Error(`ffmpeg: ${errTxt.trim().slice(-250) || 'exit ' + code}`));
        return;
      }
      const wav = Buffer.concat(out);
      if (wav.length < 100) return reject(new Error('الصوت فاضي بعد التحويل'));
      const mx = /max_volume:\s*(-?[\d.]+) dB/.exec(errTxt);
      const mn = /mean_volume:\s*(-?[\d.]+) dB/.exec(errTxt);
      resolve({
        wav,
        level: { max: mx ? Number(mx[1]) : null, mean: mn ? Number(mn[1]) : null },
      });
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(ogg);
  });
}

// ---------------------------------------------------------------------------
// تشخيص: نحفظ آخر المقاطع المسموعة (نقدر نسمع صوت المتحدث الحقيقي)
// ---------------------------------------------------------------------------
const CAPTURE_KEEP = Math.max(0, Number(process.env.CAPTURE_KEEP || 3));
const captures = [];

function rememberCapture(rec) {
  if (!CAPTURE_KEEP) return null;
  captures.push(rec);
  while (captures.length > CAPTURE_KEEP) captures.shift();
  return rec;
}

/** آخر المقاطع (وأحياناً الصوت نفسه base64) للتشخيص */
function captureDebug(withAudio = false) {
  return captures.map((c) => ({
    at: c.at,
    seconds: c.seconds,
    level: c.level,
    rate: c.rate,
    packets: c.packets,
    text: c.text ?? null,
    raw: c.raw ?? null,
    quiet: c.quiet ?? false,
    junk: c.junk ?? false,
    conf: c.conf || null,
    audioWavB64: withAudio && c.wav ? c.wav.toString('base64') : undefined,
  }));
}

// ---------------------------------------------------------------------------
// تفريغ Gemini — أدق بكثير للهجة الخليجية من Whisper (مجرّب على تسجيلات حقيقية)
//   Whisper سمع: "طلّا جوع بروح أكله"  |  Gemini سمع: "والله جوعان بروح آكل" ✅
// ---------------------------------------------------------------------------
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GEMINI_STT_MODELS = (
  process.env.GEMINI_STT_MODELS ||
  // ترتيب مجرّب على تسجيلات المستخدم الحقيقية:
  //   gemini-3.5-flash  = أدق واحد (سمع "والله جوعان بروح آكل" صح) ≈ 1.5-2.5s مع إلغاء التفكير
  //   gemini-flash-latest = قريب منه لكن أبطأ
  //   الموديلات lite أسرع لكنها هلّوست على صوته (تجي احتياط أخير)
  'gemini-3.5-flash,gemini-flash-latest,gemini-3.5-flash-lite,gemini-flash-lite-latest'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const geminiSttCool = new Map(); // model -> until

const STT_PROMPT_GEMINI = `أنت مفرّغ صوتي دقيق لمحادثة صوتية بالعامية الخليجية (سعودية).
اكتب الكلام المنطوق حرفياً كما هو، مع علامات ترقيم بسيطة.
قواعد صارمة:
- اكتب النص فقط. ممنوع تجاوب على الكلام أو تعلّق عليه أو تشرح.
- ممنوع الترجمة. خلّ الكلمات الأجنبية (أسماء أغاني، أرقام إنجليزية) بالإنجليزي مثل ما انلفظت.
- ممنوع تأليف أو إكمال من عندك. لو ما سمعت شي واضح خلّ transcript فاضية و unclear=true.
- لو الكلام همس أو غير مفهوم أو صمت: unclear=true و transcript="".`;

const GEMINI_STT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    unclear: { type: 'BOOLEAN' },
  },
  required: ['transcript', 'unclear'],
};

const STT_THINKING = process.env.STT_THINKING; // فاضي = 0 (أسرع)، 'off' = لا نرسل الإعداد

function geminiSttConfig(withThinking) {
  const cfg = {
    temperature: 0,
    maxOutputTokens: 400,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_STT_SCHEMA,
  };
  const want = STT_THINKING === undefined || STT_THINKING === '' ? '0' : String(STT_THINKING);
  if (withThinking && want !== 'off' && want !== 'default') {
    // موديلات Gemini 3 تفكّر افتراضياً وهذا يضاعف زمن التفريغ — نلغيه
    const n = Number(want);
    cfg.thinkingConfig = { thinkingBudget: Number.isFinite(n) ? n : 0 };
  }
  return cfg;
}

async function callGeminiStt(model, b64, withThinking, timeoutMs) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: STT_PROMPT_GEMINI },
            { inlineData: { mimeType: 'audio/wav', data: b64 } },
          ],
        },
      ],
      generationConfig: geminiSttConfig(withThinking),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** يفرّغ wav (16kHz mono) عبر Gemini — أدق للهجات من Whisper */
async function transcribeGemini(wav) {
  if (!GEMINI_KEY) throw new Error('ما فيه مفتاح Gemini للتفريغ');
  const models = GEMINI_STT_MODELS.filter((m) => {
    const until = geminiSttCool.get(m) || 0;
    return Date.now() >= until;
  });
  if (!models.length) throw new Error('كل موديلات Gemini للتفريغ في فترة توقف');

  const b64 = wav.toString('base64');
  const timeoutMs = Number(process.env.STT_TIMEOUT_MS || 25000);
  let lastErr = null;

  for (const model of models) {
    try {
      const t0 = Date.now();
      let res = await callGeminiStt(model, b64, true, timeoutMs);
      // لو الموديل ما يقبل إعداد التفكير نعيد بدونها
      if (res.status === 400) {
        const probe = await res.clone().text().catch(() => '');
        if (/thinking/i.test(probe)) res = await callGeminiStt(model, b64, false, timeoutMs);
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const err = new Error(`Gemini STT ${res.status}: ${txt.slice(0, 160)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const raw = (data?.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text)
        .filter(Boolean)
        .join('')
        .trim();

      let text = '';
      let unclear = false;
      let parsed = false;
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') {
          text = String(j.transcript || '').trim();
          unclear = Boolean(j.unclear);
          parsed = true;
        }
      } catch {
        /* مو JSON */
      }

      // رد مقطوع/غير صالح (يصير مع الموديلات التجريبية) → نجرّب الموديل التالي
      if (!parsed) {
        const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
        if (!cleaned) {
          geminiSttCool.set(model, Date.now() + 60 * 1000);
          throw new Error('رد Gemini فاضي');
        }
        if (/^[{[]/.test(cleaned) || /"(transcript|unclear)"\s*:/.test(cleaned)) {
          geminiSttCool.set(model, Date.now() + 2 * 60 * 1000);
          throw new Error(`رد Gemini مو JSON صالح: ${cleaned.slice(0, 60)}`);
        }
        text = cleaned;
      }

      // تعليقات وصفية بدل تفريغ (يصير لو المقطع همس/غير مفهوم)
      if (/التسجيل|المقطع الصوتي|لا أستطيع|لا استطيع|لا يمكنني تفريغ|لم أسمع/.test(text)) {
        log(`🙈 رد Gemini وصفي (مو تفريغ): "${text.slice(0, 70)}"`);
        return { text: '', junk: true, source: 'gemini', unclear: true };
      }

      log(`🎧 تفريغ Gemini (${model}، ${Date.now() - t0}ms): "${text.slice(0, 80)}"${unclear ? ' [غير واضح]' : ''}`);
      if (unclear || !text || isJunkTranscript(text)) {
        return { text: '', junk: true, source: 'gemini', unclear };
      }
      return { text, source: 'gemini' };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      const quota = /\b429\b|quota|exceeded|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg);
      geminiSttCool.set(model, Date.now() + (quota ? 30 * 60 * 1000 : 2 * 60 * 1000));
      log(`⚠️ فشل تفريغ Gemini (${model}): ${msg.slice(0, 110)}`);
    }
  }
  throw lastErr || new Error('فشل تفريغ Gemini');
}

/** تفريغ Whisper (احتياطي) مع فحص الثقة */
async function transcribeWhisper(wav, opts = {}) {
  if (!GROQ_KEY) throw new Error('ما فيه مفتاح Groq');

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', STT_MODEL);
  // verbose_json يعطينا ثقة الموديل (نرفض الهلوسة قبل ما نرد بشي غلط)
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (opts.language) form.append('language', opts.language);
  const prompt = opts.prompt || STT_PROMPT;
  if (prompt) form.append('prompt', prompt);

  let res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });

  // لو المزوّد ما يدعم verbose_json نرجع للصيغة العادية
  if (res.status === 400) {
    const txt0 = await res.text().catch(() => '');
    if (/response_format|verbose/i.test(txt0)) {
      form.set('response_format', 'json');
      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
    } else {
      const err0 = new Error(`Whisper 400: ${txt0.slice(0, 200)}`);
      err0.status = 400;
      err0.body = txt0;
      throw err0;
    }
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Whisper ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    err.body = txt;
    throw err;
  }

  const data = await res.json();
  const text = String(data?.text || '').trim();

  // ---- فحص ثقة Whisper: أسرع وأدق طريقة لقتل الهلوسة ----
  const segs = Array.isArray(data?.segments) ? data.segments : [];
  if (segs.length) {
    const noSpeech = Math.max(...segs.map((s) => Number(s.no_speech_prob) || 0));
    const comp = Math.max(...segs.map((s) => Number(s.compression_ratio) || 0));
    const avgLog = segs.reduce((a, s) => a + (Number(s.avg_logprob) || 0), 0) / segs.length;
    const noSpeechMax = Number(process.env.STT_NO_SPEECH || 0.6);
    const compMax = Number(process.env.STT_COMPRESSION || 2.4);
    const logMin = Number(process.env.STT_LOGPROB || -1.3);

    if (noSpeech > noSpeechMax) {
      log(`🙈 تجاهلت مقطع (يغلب أنه صمت/ضجيج: ${noSpeech.toFixed(2)})، النص كان: "${text.slice(0, 50)}"`);
      return { text: '', junk: true, raw: text, conf: { noSpeech, comp, avgLog }, source: 'whisper' };
    }
    if (comp > compMax) {
      log(`🙈 تجاهلت مقطع (تكرار/هلوسة: ${comp.toFixed(2)})، النص: "${text.slice(0, 50)}"`);
      return { text: '', junk: true, raw: text, conf: { noSpeech, comp, avgLog }, source: 'whisper' };
    }
    if (avgLog < logMin) {
      log(`🙈 تجاهلت مقطع (ثقة واطية: ${avgLog.toFixed(2)})، النص: "${text.slice(0, 50)}"`);
      return { text: '', junk: true, raw: text, conf: { noSpeech, comp, avgLog }, source: 'whisper' };
    }
  }

  // نرفض الهلوسة (نصوص اخترعها الموديل على صوت مو كلام)
  if (!text || isJunkTranscript(text)) {
    log(`🚫 تفريغ مرفوض (هلوسة/فاضي): "${text.slice(0, 70)}"`);
    return { text: '', junk: true, raw: text, source: 'whisper' };
  }
  return { text, language: data?.language, source: 'whisper' };
}

/**
 * يفرّغ حزم Opus خام إلى نص.
 * الترتيب: Gemini أول (أدق بكثير للهجة الخليجية)، وWhisper احتياطي عند فشل/حصة Gemini.
 * @param {Buffer[]} opusPackets حزم Opus من ديسكورد
 * @param {object} opts { language, prompt }
 */
async function transcribe(opusPackets, opts = {}) {
  const list = (Array.isArray(opusPackets) ? opusPackets : []).filter((p) => p && p.length > 0);
  if (!list.length) throw new Error('ما فيه صوت');

  const ogg = muxOggOpus(list, { channels: 2, sampleRate: 48000 });
  const { wav, level } = await oggToWav(ogg);
  const seconds = (list.length * 20) / 1000; // كل حزمة Opus ≈ 20ms

  // نحفظ المقطع للتشخيص (نسمع صوت المتحدث الحقيقي عند الحاجة)
  const rec = rememberCapture({
    at: Date.now(),
    seconds,
    level,
    wav: wav.length < 400000 ? wav : null,
    packets: list.length,
    rate: Math.round(
      list.reduce((a, p) => a + p.length, 0) / Math.max(1, list.length),
    ),
  });
  const done = (o) => {
    if (rec) Object.assign(rec, o);
    return o;
  };
  log(
    `🎚️ مقطع (${seconds.toFixed(1)} ثانية | ${rec ? rec.rate : '?'} بايت/حزمة) مستوى: أعلى ${level.max}dB / متوسط ${level.mean}dB`,
  );

  // فلتر مهم: الصمت والضجيج = هلوسة. نتجاهل المقطع قبل ما نرسله أصلاً
  // ملاحظة: dynaudnorm يرفع الصوت الواطي بعد هذي القياسة، فنقبل الأوطأ هنا.
  const softDb = Number(process.env.STT_MIN_DB || -45);
  const hardDb = Number(process.env.STT_HARD_DB || -55);
  const maxDb = level.max;
  if (maxDb != null && (maxDb <= hardDb || (maxDb <= softDb && seconds > 6))) {
    log(
      `🔇 صوت واطي/صمت (أعلى مستوى ${maxDb}dB، ${seconds.toFixed(1)} ثانية) — تجاهلته قبل التفريغ`,
    );
    return done({ text: '', quiet: true, level });
  }

  const order = String(process.env.STT_ORDER || 'gemini,whisper')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let lastErr = null;
  for (const provider of order) {
    try {
      if (provider === 'gemini') {
        const r = await transcribeGemini(wav);
        if (!r.text) {
          log('🔇 ما فيه كلام واضح (Gemini) — ما أرد');
          return done({ text: '', junk: true, level, source: 'gemini' });
        }
        return done({ text: r.text, level, source: 'gemini' });
      }

      if (provider === 'whisper') {
        const r = await transcribeWhisper(wav, opts);
        if (!r.text) {
          return done({
            text: '',
            junk: true,
            raw: r.raw,
            conf: r.conf || null,
            level,
            source: 'whisper',
          });
        }
        return done({ text: r.text, language: r.language, level, source: 'whisper' });
      }

      log(`⚠️ مفرّغ غير معروف في STT_ORDER: ${provider}`);
    } catch (e) {
      lastErr = e;
      log(`⚠️ فشل التفريغ عبر ${provider}: ${String(e.message || e).slice(0, 150)}`);
    }
  }

  throw lastErr || new Error('فشل تفريغ الصوت');
}

// ---------------------------------------------------------------------------
// فحص سريع عند التشغيل
// ---------------------------------------------------------------------------
async function selfTest() {
  const out = { tts: null, stt: null };

  try {
    const ogg = await speak('تمام', { voice: TTS_VOICE });
    out.tts = { ok: ogg.length > 1000, bytes: ogg.length, voice: TTS_VOICE };
    log(`✅ النطق يشتغل (${TTS_VOICE}): ${ogg.length} بايت (Ogg Opus 48kHz)`);
  } catch (e) {
    out.tts = { ok: false, error: e.message };
    log('❌ النطق فشل:', e.message.slice(0, 120));
  }

  if (!GROQ_KEY) {
    out.stt = { ok: false, error: 'ما فيه مفتاح Groq' };
  } else {
    // نختبر التفريغ بملف صوت نولّده من TTS
    try {
      const webm = await new Promise((res, rej) => {
        const tts = new MsEdgeTTS();
        (async () => {
          await tts.setMetadata(TTS_VOICE, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
          const { audioStream } = await tts.toStream('مرحبا، هذا اختبار للصوت.');
          return audioStream;
        })().then((s) => {
          const c = [];
          s.on('data', (d) => c.push(d));
          s.on('end', () => res(Buffer.concat(c)));
          s.on('error', rej);
        }, rej);
      });

      const { WebmDemuxer } = require('prism-media').opus;
      const packets = [];
      const demuxer = new WebmDemuxer();
      await new Promise((res, rej) => {
        demuxer.on('data', (p) => packets.push(p));
        demuxer.on('end', res);
        demuxer.on('error', rej);
        demuxer.end(webm);
      });

      const r = await transcribe(packets, { language: 'ar' });
      if (!r.text) {
        out.stt = { ok: false, error: r.quiet ? 'صوت واطي جداً' : 'تفريغ فاضي' };
        log('⚠️ التفريغ رجّع نص فاضي — تأكد من STT_MIN_DB أو الصوت');
      } else {
        out.stt = { ok: true, text: r.text, model: r.source === 'gemini' ? 'Gemini' : STT_MODEL };
        log(`✅ التفريغ يشتغل (${out.stt.model}): "${r.text}"`);
      }
    } catch (e) {
      out.stt = { ok: false, error: e.message };
      log('❌ التفريغ فشل:', e.message.slice(0, 150));
    }
  }

  return out;
}

module.exports = {
  speak,
  transcribe,
  selfTest,
  nextVoice,
  ffmpegPath,
  oggToWav,
  testTone,
  speakGoogle,
  toDiscordOgg,
  // للفحص (test-voicecmd.js)
  isJunkTranscript,
  sttNorm,
  captureDebug,
  STT_MODEL,
  // للفحص المباشر
  transcribeGemini,
  transcribeWhisper,
  GEMINI_STT_MODELS,
};
