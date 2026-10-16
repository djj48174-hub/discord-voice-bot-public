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

/** WebM Opus (24kHz مونو من مايكروسوفت) -> Ogg Opus (48kHz ستيريو — ما يقبله ديسكورد) */
function webmToOgg(webm) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
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
    ff.stdin.end(webm);
  });
}

/**
 * يرجّع صوتاً (Ogg Opus 48kHz ستيريو) جاهزاً للتشغيل في ديسكورد مباشرة.
 * صوت Edge TTS عربي + سرعة أعلى شوي عشان ما يطوّل.
 */
async function speak(text, opts = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('ما فيه نص للنطق');

  const tts = new MsEdgeTTS();
  await tts.setMetadata(opts.voice || nextVoice(), OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);
  const { audioStream } = await tts.toStream(clean, { rate: opts.rate || TTS_RATE });

  const webm = await streamToBuffer(audioStream);
  if (webm.length < 200) throw new Error('الصوت فاضي من محرّك النطق');

  const ogg = await webmToOgg(webm);
  log(`🔊 صوت جاهز: ${ogg.length} بايت`);
  return ogg;
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

module.exports = { speak, transcribe, selfTest, nextVoice, ffmpegPath, oggToWav };
