/**
 * 📻 الروم الصوتي — اتصال مستقل لكل سيرفر
 * البوت يدخل الروم ويبقى فيه (بدون تشغيل صوت افتراضياً).
 * كل سيرفر له اتصاله الخاص: الدخول في سيرفر ما يطلّع البوت من السيرفر الثاني.
 *
 * أوامر:
 *   radio.start(client)                        — دخول تلقائي في سيرفر الروم الافتراضي
 *   radio.join(client, channelId?, guildId?)   — دخول أي روم (يوقف الإيقاف اليدوي)
 *   radio.leave(guildId?)                      — خروج من روم سيرفر معيّن (أو الكل)
 *   radio.status(guildId?)                     — حالة الاتصال
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

// رومات الدخول التلقائي (لكل سيرفر على حدة) — مفصولة بفاصلة
const AUTO_JOIN_IDS = (process.env.AUTO_JOIN_VOICE_IDS || DEFAULT_CHANNEL_ID)
  .split(/[,\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');

// الصوت ملغي افتراضياً: البوت يدخل الروم ويجلس بدون تشغيل.
// لو رجعت تبي التلاوة، حط QURAN_RADIO_AUDIO=true.
const AUDIO_ENABLED = String(process.env.QURAN_RADIO_AUDIO || 'false').toLowerCase() === 'true';

// تلاوة مشاري راشد العفاسي — سورة كاملة لكل ملف
const SURAH_BASE = (
  process.env.QURAN_RADIO_BASE ||
  'https://download.quranicaudio.com/quran/mishaari_raashid_al_3afaasee/'
).trim();

// guildId -> { connection, player, ffmpeg, surah, channelId, paused, starting }
const states = new Map();
let lastClient = null;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [radio]`, ...args);
}

function getState(guildId) {
  const id = String(guildId);
  let s = states.get(id);
  if (!s) {
    s = {
      guildId: id,
      connection: null,
      player: null,
      ffmpeg: null,
      surah: 1,
      channelId: null,
      paused: false,
      starting: false,
    };
    states.set(id, s);
  }
  return s;
}

function surahUrl(n) {
  return `${SURAH_BASE}${String(n).padStart(3, '0')}.mp3`;
}

function killFfmpeg(s) {
  if (s.ffmpeg) {
    try {
      s.ffmpeg.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    s.ffmpeg = null;
  }
}

function playSurah(s) {
  if (!AUDIO_ENABLED || !s.player) return;
  killFfmpeg(s);

  const n = s.surah;
  const url = surahUrl(n);
  s.surah = n >= 114 ? 1 : n + 1;
  log(`[${s.guildId}] playing surah ${String(n).padStart(3, '0')}`);
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
  s.ffmpeg = proc;

  proc.on('error', (e) => log('ffmpeg error:', e.message));
  proc.on('close', () => {
    if (s.ffmpeg === proc) s.ffmpeg = null;
  });

  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw });
  s.player.play(resource);
}

function attachPlayer(s, conn) {
  if (!AUDIO_ENABLED) {
    log(`[${s.guildId}] الصوت ملغي — البوت يجلس في الروم بدون تشغيل`);
    return;
  }
  try {
    if (s.player) s.player.removeAllListeners();
  } catch {
    /* ignore */
  }
  s.player = createAudioPlayer();
  conn.subscribe(s.player);

  s.player.on(AudioPlayerStatus.Idle, () => {
    playSurah(s);
  });

  s.player.on('error', (e) => {
    log('player error:', e.message);
    killFfmpeg(s);
    setTimeout(() => playSurah(s), 5000);
  });

  playSurah(s);
}

function destroyState(s) {
  killFfmpeg(s);
  try {
    if (s.player) s.player.stop(true);
  } catch {
    /* ignore */
  }
  s.player = null;
  try {
    if (s.connection) s.connection.destroy();
  } catch {
    /* ignore */
  }
  s.connection = null;
}

async function connect(client, channelId, guildIdHint) {
  lastClient = client;
  const id = String(channelId || '');
  if (!id) return false;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !channel.isVoiceBased?.()) {
    log('ما لقيت روم صوتي:', id);
    return false;
  }
  const guild = channel.guild;
  if (!guild) return false;
  if (guildIdHint && String(guildIdHint) !== guild.id) {
    log('تحذير: الروم لا يتبع السيرفر المطلوب — أستخدم سيرفر الروم');
  }

  const s = getState(guild.id);
  s.channelId = channel.id;

  // لو البوت متصل فعلاً بنفس الروم (Ready)، نعيد استخدام الاتصال
  const existing = getVoiceConnection(guild.id);
  if (
    existing &&
    existing.joinConfig.channelId === channel.id &&
    existing.state.status === VoiceConnectionStatus.Ready
  ) {
    s.connection = existing;
    if (!s.player) attachPlayer(s, existing);
    return true;
  }

  // نغلق اتصال هذا السيرفر فقط (السيرفرات الثانية تبقى متصلة)
  destroyState(s);
  log(`[${guild.id}] جاري الاتصال بالروم ${channel.name}`);

  s.connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  const state = s;
  state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log(`[${state.guildId}] انقطع الاتصال`);
    try {
      await Promise.race([
        entersState(state.connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(state.connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      log(`[${state.guildId}] انقطع الاتصال — إعادة محاولة`);
      // لو أحد نقله لروم ثاني نكمل فيه
      const g = client.guilds.cache.get(state.guildId);
      const now = g?.members?.me?.voice?.channelId;
      if (now) state.channelId = now;
      destroyState(state);
      if (!state.paused) setTimeout(() => startup(client, state.guildId), 5000);
    }
  });

  state.connection.on('error', (e) => log('connection error:', e.message));
  state.connection.on('stateChange', (o, n) =>
    log(`[${state.guildId}] state`, o.status, '->', n.status, n.closeCode || ''),
  );
  if (process.env.RADIO_DEBUG) state.connection.on('debug', (m) => log('dbg', m));

  try {
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
    log(`[${guild.id}] متصل بالروم الصوتي ${channel.name}`);
  } catch {
    log(`[${guild.id}] تعذر الوصول لحالة Ready — بنحاول لاحقاً`);
  }

  attachPlayer(state, state.connection);
  return true;
}

async function startup(client, guildId) {
  const s = getState(guildId);
  if (s.starting || s.paused) return;
  s.starting = true;
  try {
    await connect(client, s.channelId || DEFAULT_CHANNEL_ID, s.guildId);
  } catch (e) {
    log('فشل التشغيل:', e.message);
  } finally {
    s.starting = false;
  }
}

/** دخول الروم يدوياً — لسيرفر محدد فقط، ما يمس السيرفرات الثانية */
async function join(client, channelId, guildId) {
  lastClient = client;
  let gid = guildId ? String(guildId) : null;

  // لو ما عطونا السيرفر، نستنتجه من الروم
  if (!gid) {
    const id = channelId || DEFAULT_CHANNEL_ID;
    const ch = await client.channels.fetch(id).catch(() => null);
    gid = ch?.guild?.id || null;
  }
  if (!gid) return status();

  const s = getState(gid);
  s.paused = false;
  if (channelId) s.channelId = String(channelId);
  await connect(client, s.channelId || DEFAULT_CHANNEL_ID, gid);
  return status(gid);
}

/** خروج من الروم — لسيرفر محدد، أو من كل السيرفرات لو ما حددت */
function leave(guildId) {
  if (guildId) {
    const s = getState(guildId);
    s.paused = true;
    destroyState(s);
    log(`[${s.guildId}] خرجت من الروم (إيقاف يدوي)`);
    return status(s.guildId);
  }
  for (const s of states.values()) {
    s.paused = true;
    destroyState(s);
  }
  log('خرجت من كل الرومات (إيقاف يدوي)');
  return { paused: true };
}

/** حالة الراديو لسيرفر واحد أو ملخص الكل */
function status(guildId) {
  if (guildId) {
    const s = states.get(String(guildId));
    if (!s) {
      return {
        state: 'disconnected',
        channelId: null,
        surah: 1,
        audio: AUDIO_ENABLED,
        paused: false,
        playing: false,
      };
    }
    return {
      state: s.connection?.state?.status ?? 'disconnected',
      channelId: s.connection?.joinConfig?.channelId ?? s.channelId ?? null,
      surah: s.surah,
      audio: AUDIO_ENABLED,
      paused: s.paused,
      playing: Boolean(
        AUDIO_ENABLED && s.player && s.player.state?.status === AudioPlayerStatus.Playing,
      ),
    };
  }
  return {
    audio: AUDIO_ENABLED,
    guilds: [...states.values()].map((s) => ({
      guildId: s.guildId,
      state: s.connection?.state?.status ?? 'disconnected',
      channelId: s.connection?.joinConfig?.channelId ?? s.channelId ?? null,
      paused: s.paused,
    })),
  };
}

function start(client) {
  if (!AUTO_JOIN_IDS.length) return;
  lastClient = client;

  // دخول تلقائي لكل الرومات المحددة (كل سيرفر له اتصاله المستقل)
  setTimeout(async () => {
    for (const id of AUTO_JOIN_IDS) {
      const ch = await client.channels.fetch(id).catch(() => null);
      const gid = ch?.guild?.id;
      if (!gid) continue;
      const s = getState(gid);
      s.channelId = id;
      s.paused = false;
      await startup(client, gid);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }, 10000);

  // حارس كل 30 ثانية لكل سيرفر على حدة
  const timer = setInterval(async () => {
    const c = lastClient || client;
    if (!c) return;
    for (const s of [...states.values()]) {
      if (s.paused) continue;
      try {
        const guild = c.guilds.cache.get(s.guildId);
        if (!guild) continue;
        const whereNow = guild.members?.me?.voice?.channelId ?? null;
        const st = s.connection?.state?.status;
        const connHealthy = st === VoiceConnectionStatus.Ready;

        // انتقل لروم ثاني -> نكمل فيه
        if (whereNow && whereNow !== s.channelId) {
          log(`[${s.guildId}] البوت انتقل لروم آخر — أكمل فيه`);
          s.channelId = whereNow;
        }
        // مو بأي روم صوتي -> نرجعه لآخر روم
        if (!whereNow) {
          log(`[${s.guildId}] البوت مو بأي روم صوتي — أرجعه`);
          await startup(c, s.guildId);
          continue;
        }
        // داخل روم لكن الاتصال غير سليم -> نعيد الدخول
        if (!connHealthy) {
          log(`[${s.guildId}] الاتصال غير سليم (${st}) — أعيد الدخول`);
          await startup(c, s.guildId);
        }
      } catch (e) {
        log('حارس: خطأ', String(e.message || e).slice(0, 120));
        startup(c, s.guildId);
      }
    }
  }, 30 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { start, join, leave, status, DEFAULT_CHANNEL_ID };
