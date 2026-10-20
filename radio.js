/**
 * 📻 قرآن راديو — إذاعة القرآن الكريم ٢٤/٧
 * يدخل الروم الصوتي ويشغّل التلاوة باستمرار (بدون كلام).
 */

'use strict';

const { spawn } = require('child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');

const CHANNEL_ID = (process.env.QURAN_RADIO_CHANNEL_ID || '1562222163140939803').trim();
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');

// تلاوة مشاري راشد العفاسي — سورة كاملة لكل ملف
const SURAH_BASE = (
  process.env.QURAN_RADIO_BASE ||
  'https://download.quranicaudio.com/quran/mishaari_raashid_al_3afaasee/'
).trim();

let connection = null;
let player = null;
let currentFfmpeg = null;
let currentSurah = 1;
let starting = false;

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
  if (!player) return;
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

async function connect(client) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isVoiceBased?.()) {
    log('ما لقيت روم قرآن راديو الصوتي:', CHANNEL_ID);
    return;
  }
  const guild = channel.guild;
  if (!guild) return;

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
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
      connection = null;
      setTimeout(() => startup(client), 10000);
    }
  });

  connection.on('error', (e) => log('connection error:', e.message));
  connection.on('stateChange', (o, n) => log('state', o.status, '->', n.status, n.closeCode || ''));
  if (process.env.RADIO_DEBUG) connection.on('debug', (m) => log('dbg', m));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    log('متصل بالروم الصوتي', channel.name);
  } catch {
    log('تعذر الوصول لحالة Ready — بنحاول لاحقاً');
  }

  attachPlayer(connection);
}

async function startup(client) {
  if (starting) return;
  starting = true;
  try {
    await connect(client);
  } catch (e) {
    log('فشل التشغيل:', e.message);
  } finally {
    starting = false;
  }
}

function start(client) {
  if (!CHANNEL_ID) return;
  setTimeout(() => startup(client), 5000);

  // مراقبة كل دقيقة: إذا طلع البوت أو انقطع يرجع
  const timer = setInterval(() => {
    try {
      const status = connection?.state?.status;
      const healthy =
        status === VoiceConnectionStatus.Ready ||
        status === VoiceConnectionStatus.Connecting ||
        status === VoiceConnectionStatus.Signalling;
      if (!healthy) startup(client);
    } catch {
      startup(client);
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { start };
