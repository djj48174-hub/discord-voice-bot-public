/**
 * 📻 راديو الروم الصوتي
 * يدخل الروم الصوتي ويبقى فيه (بدون تشغيل صوت افتراضياً).
 *
 * أوامر:
 *   radio.start(client)                 — دخول تلقائي 24/7
 *   radio.join(client, channelId?)      — دخول أي روم (يوقف الإيقاف اليدوي)
 *   radio.leave()                       — خروج من الروم (يبقى متوقف لين join)
 *   radio.status()                      — حالة الاتصال
 *
 * لتشغيل التلاوة الصوتية: QURAN_RADIO_AUDIO=true
 */

'use strict';

const { spawn } = require('child_process');
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');

const DEFAULT_CHANNEL_ID = (process.env.QURAN_RADIO_CHANNEL_ID || '1562222163140939803').trim();
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');

// الصوت ملغي افتراضياً: البوت يدخل الروم ويجلس بدون تشغيل.
// لو رجعت تبي التلاوة، حط QURAN_RADIO_AUDIO=true.
const AUDIO_ENABLED = String(process.env.QURAN_RADIO_AUDIO || 'false').toLowerCase() === 'true';

// تلاوة مشاري راشد العفاسي — سورة كاملة لكل ملف
const SURAH_BASE = (
  process.env.QURAN_RADIO_BASE ||
  'https://download.quranicaudio.com/quran/mishaari_raashid_al_3afaasee/'
).trim();

let connection = null;
let player = null;
let currentFfmpeg = null;
let currentSurah = 1;
let currentChannelId = DEFAULT_CHANNEL_ID;
let lastGuildId = null;
let starting = false;
let paused = false; // true بعد /leave — ما نرجع تلقائياً لين /join
let lastClient = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [radio]`, ...args);
}

function surahUrl(n) {
  return `${SURAH_BASE}${String(n).padStart(3, '0')}.mp3`;
}

function killFfmpeg() {
  if (currentFfmpeg) {
    try {
      currentFfmpeg.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    currentFfmpeg = null;
  }
}

function playSurah() {
  if (!AUDIO_ENABLED || !player) return;
  killFfmpeg();

  const n = currentSurah;
  const url = surahUrl(n);
  currentSurah = n >= 114 ? 1 : n + 1;
  log(`playing surah ${String(n).padStart(3, '0')}`);
  const proc = spawn(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', url,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  currentFfmpeg = proc;

  proc.on('error', (e) => log('ffmpeg error:', e.message));
  proc.on('close', () => {
    if (currentFfmpeg === proc) currentFfmpeg = null;
  });

  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
  player.play(resource);
}

function attachPlayer(conn) {
  if (!AUDIO_ENABLED) {
    log('الصوت ملغي — البوت يجلس في الروم بدون تشغيل');
    return;
  }
  try {
    if (player) player.removeAllListeners();
  } catch {
    /* ignore */
  }
  player = createAudioPlayer();
  conn.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    playSurah();
  });

  player.on('error', (e) => {
    log('player error:', e.message);
    killFfmpeg();
    setTimeout(() => playSurah(), 5000);
  });

  playSurah();
}

function destroyConnection() {
  killFfmpeg();
  try {
    if (player) player.stop(true);
  } catch {
    /* ignore */
  }
  player = null;
  try {
    if (connection) connection.destroy();
  } catch {
    /* ignore */
  }
  connection = null;
}

async function connect(client, channelId) {
  lastClient = client;
  const id = String(channelId || currentChannelId || DEFAULT_CHANNEL_ID);
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !channel.isVoiceBased?.()) {
    log('ما لقيت روم قرآن راديو الصوتي:', id);
    return false;
  }
  const guild = channel.guild;
  if (!guild) return false;
  lastGuildId = guild.id;

  // لو البوت موجود بالروم الصحيح وما فيه اتصال سليم، نبقى على نفس الاتصال
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.joinConfig.channelId === channel.id) {
    connection = existing;
    if (!player) attachPlayer(existing);
    return true;
  }

  destroyConnection();
  currentChannelId = channel.id;
  log('جاري الاتصال بالروم', channel.name);

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log('انقطع الاتصال');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      log('انقطع الاتصال — إعادة محاولة');
      // لو أحد نقله لروم ثاني نكمل فيه (ما نرجعه للروم الأول)
      const g = client.guilds.cache.get(guild.id);
      const now = g?.members?.me?.voice?.channelId;
      if (now) currentChannelId = now;
      destroyConnection();
      if (!paused) setTimeout(() => startup(client), 5000);
    }
  });

  connection.on('error', (e) => log('connection error:', e.message));
  connection.on('stateChange', (o, n) =>
    log('state', o.status, '->', n.status, n.closeCode || ''),
  );
  if (process.env.RADIO_DEBUG) connection.on('debug', (m) => log('dbg', m));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    log('متصل بالروم الصوتي', channel.name);
  } catch {
    log('تعذر الوصول لحالة Ready — بنحاول لاحقاً');
  }

  attachPlayer(connection);
  return true;
}

async function startup(client) {
  if (starting || paused) return;
  starting = true;
  try {
    await connect(client, currentChannelId);
  } catch (e) {
    log('فشل التشغيل:', e.message);
  } finally {
    starting = false;
  }
}

/** دخول الروم يدوياً (أو روم محدد) — يجلس فيه ويرجّع الاتصال */
async function join(client, channelId) {
  paused = false;
  if (channelId) currentChannelId = String(channelId);
  await connect(client, currentChannelId);
  return status();
}

/** خروج من الروم — يقفل الاتصال ويمنع الرجوع التلقائي لين join */
function leave() {
  paused = true;
  destroyConnection();
  log('خرجت من الروم (إيقاف يدوي)');
  return status();
}

/** حالة الراديو */
function status() {
  const st = connection?.state?.status ?? 'disconnected';
  const chName = connection?.joinConfig?.channelId ?? null;
  return {
    state: st,
    channelId: chName,
    surah: currentSurah,
    audio: AUDIO_ENABLED,
    paused,
    playing: Boolean(AUDIO_ENABLED && player && player.state?.status === AudioPlayerStatus.Playing),
  };
}

function start(client) {
  if (!DEFAULT_CHANNEL_ID) return;
  lastClient = client;
  setTimeout(() => {
    if (!paused) startup(client);
  }, 5000);

  // حارس كل 30 ثانية: يضمن إن البوت داخل روم صوتي والاتصال سليم.
  // يسمح بأي روم: إذا نقله أحد لروم ثاني نكمل فيه (ما نرجعه للقرآن)،
  // وإذا طلع من الصوت نهائياً نرجعه لآخر روم كان فيه.
  const timer = setInterval(async () => {
    if (paused) return;
    const c = lastClient || client;
    if (!c) return;
    try {
      const guildId =
        connection?.joinConfig?.guildId || lastGuildId || c.guilds?.cache?.first?.()?.id;
      const guild = guildId ? c.guilds.cache.get(guildId) : null;
      if (!guild) {
        await startup(c);
        return;
      }
      const whereNow = guild.members?.me?.voice?.channelId ?? null;
      const st = connection?.state?.status;
      const connHealthy =
        st === VoiceConnectionStatus.Ready ||
        st === VoiceConnectionStatus.Connecting ||
        st === VoiceConnectionStatus.Signalling;

      // البوت انتقل لروم ثاني -> نكمل فيه ونعتمده كروم حالي
      if (whereNow && whereNow !== currentChannelId) {
        log('حارس: البوت انتقل لروم آخر — أكمل فيه');
        currentChannelId = whereNow;
      }
      // البوت مو بأي روم صوتي (طُرد/طلع) -> نرجعه لآخر روم كان فيه
      if (!whereNow) {
        log('حارس: البوت مو بأي روم صوتي — أرجعه');
        await startup(c);
        return;
      }
      // داخل روم لكن الاتصال غير سليم -> نعيد الدخول
      if (!connHealthy) {
        log('حارس: الاتصال غير سليم (' + st + ') — أعيد الدخول');
        await startup(c);
      }
    } catch (e) {
      log('حارس: خطأ', String(e.message || e).slice(0, 120));
      startup(c);
    }
  }, 30 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { start, join, leave, status, DEFAULT_CHANNEL_ID };
