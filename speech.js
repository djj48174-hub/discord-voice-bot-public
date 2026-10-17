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
const STT_MODEL = (process.env.STT_MODEL || 'whisper-large-v3-turbo').trim();
const STT_TIMEOUT_MS = Math.max(5000, Number(process.env.STT_TIMEOUT_MS || 25000));

const TTS_VOICE = (process.env.TTS_VOICE || 'ar-SA-HamedNeural').trim();
const TTS_RATE = (process.env.TTS_RATE || '+8%').trim();

// أصوات عربية بديلة (تتناوب عليها عشان ما يطلع الصوت ممل)
const ARABIC_VOICES = [
  'ar-SA-HamedNeural',
  'ar-EG-ShakirNeural',
  'ar-SA-ZariyahNeural',
  'ar-AE-FatimaNeural',
  'ar-KW-NaayfNeural',
  'ar-JO-TaimNeural',
];
let voiceCursor = 0;

function nextVoice() {
  const v = ARABIC_VOICES[voiceCursor % ARABIC_VOICES.length];
  voiceCursor++;
  return v;
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
function toDiscordOgg(inputBuf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-af',
        'aresample=48000,volume=2.5',
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
  return toDiscordOgg(mp3);
}

/**
 * محرّك Edge TTS (أصوات مايكروسوفت العربية) — مجاني لكن يتقيّد (429).
 */
async function speakEdge(text, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(opts.voice || nextVoice(), OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = await tts.toStream(text, { rate: opts.rate || TTS_RATE });

      const mp3 = await streamToBuffer(audioStream);
      if (mp3.length < 200) throw new Error('الصوت فاضي من محرّك النطق');
      return await toDiscordOgg(mp3);
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      log(`⚠️ محاولة Edge ${attempt + 1} فشلت: ${msg.slice(0, 90)}`);
      // 429 = تقييد — ننتقل للاحتياطي بسرعة
      if (/\b429\b|rate.?limit|throttl/i.test(msg)) break;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('فشل Edge TTS');
}

/**
 * يرجّع صوتاً (Ogg Opus 48kHz ستيريو) جاهزاً للتشغيل في ديسكورد مباشرة.
 * الترتيب قابل للتغيير عبر TTS_ORDER (الافتراضي: Groq -> Edge -> Google)
 */
async function speak(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('ما فيه نص للنطق');

  const order = String(process.env.TTS_ORDER || 'groq,edge,google')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let lastErr = null;

  for (const provider of order) {
    try {
      if (provider === 'groq') {
        if (!GROQ_KEY) throw new Error('ما فيه مفتاح Groq للنطق');
        const ogg = await speakGroq(clean, opts);
        log(`🔊 صوت جاهز (Groq Orpheus): ${ogg.length} بايت`);
        return ogg;
      }
      if (provider === 'edge') {
        const ogg = await speakEdge(clean, opts);
        log(`🔊 صوت جاهز (Edge): ${ogg.length} بايت`);
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
      }
    }
  }

  throw lastErr || new Error('فشل توليد الصوت');
}

/** نطق عربي سعودي عبر Groq (أصوات: abdullah, fahad, sultan, lulwa, noura, aisha) */
const GROQ_TTS_VOICES = ['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha'];
const GROQ_TTS_MODEL = (
  process.env.GROQ_TTS_MODEL || 'canopylabs/orpheus-arabic-saudi'
).trim();
let groqVoiceCursor = 0;

async function speakGroq(text, opts = {}) {
  const voice = opts.groqVoice || GROQ_TTS_VOICES[groqVoiceCursor++ % GROQ_TTS_VOICES.length];
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
  return toDiscordOgg(wav);
}

// ---------------------------------------------------------------------------
// STT — تفريغ الصوت إلى نص
// ---------------------------------------------------------------------------
/** Ogg Opus -> WAV (16kHz مونو — الأفضل لـ Whisper) */
function oggToWav(ogg) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'ogg',
        '-i',
        'pipe:0',
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
      if (code !== 0) {
        reject(new Error(`ffmpeg: ${Buffer.concat(err).toString().trim().slice(0, 200) || 'exit ' + code}`));
        return;
      }
      const wav = Buffer.concat(out);
      if (wav.length < 100) return reject(new Error('الصوت فاضي بعد التحويل'));
      resolve(wav);
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(ogg);
  });
}

/**
 * يفرّغ حزم Opus خام إلى نص.
 * @param {Buffer[]} opusPackets حزم Opus من ديسكورد
 * @param {object} opts { language, prompt }
 */
async function transcribe(opusPackets, opts = {}) {
  if (!GROQ_KEY) throw new Error('ما فيه مفتاح Groq');
  const list = (Array.isArray(opusPackets) ? opusPackets : []).filter((p) => p && p.length > 0);
  if (!list.length) throw new Error('ما فيه صوت');

  const ogg = muxOggOpus(list, { channels: 2, sampleRate: 48000 });
  const wav = await oggToWav(ogg);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', STT_MODEL);
  form.append('response_format', 'json');
  if (opts.language) form.append('language', opts.language);
  if (opts.prompt) form.append('prompt', opts.prompt);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Whisper ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    err.body = txt;
    throw err;
  }

  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('ما فهمت شي من الصوت');
  return { text, language: data?.language };
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
      out.stt = { ok: true, text: r.text, model: STT_MODEL };
      log(`✅ التفريغ يشتغل (${STT_MODEL}): "${r.text}"`);
    } catch (e) {
      out.stt = { ok: false, error: e.message };
      log('❌ التفريغ فشل:', e.message.slice(0, 150));
    }
  }

  return out;
}

module.exports = { speak, transcribe, selfTest, nextVoice, ffmpegPath, oggToWav, testTone, speakGoogle, toDiscordOgg };
