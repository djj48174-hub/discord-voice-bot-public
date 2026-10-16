/**
 * نظام الموسيقى للبوت.
 * - يبحث في يوتيوب باسم الأغنية أو الرابط (yt-dlp)
 * - يشغّل الصوت في الروم الصوتي نفسه اللي البوت قاعد فيه
 * - طابور (Queue) لكل سيرفر + تحكم كامل (skip/pause/resume/volume/...)
 *
 * طريقة الصوت:
 *   yt-dlp (صوت خام) -> ffmpeg (Opus/Ogg) -> @discordjs/voice (تمرير مباشر)
 *   ما نحتاج أي مكتبة ترميز Opus إضافية.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
} = require('@discordjs/voice');

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, '[music]', ...args);
}

// ---------------------------------------------------------------------------
// الأدوات (yt-dlp / ffmpeg)
// ---------------------------------------------------------------------------
function resolveYtDlp() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [
    process.env.YTDLP_PATH,
    path.join(__dirname, 'bin', exe),
    path.join(__dirname, 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'yt-dlp';
}

let FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
try {
  const staticFfmpeg = require('ffmpeg-static');
  if (staticFfmpeg && fs.existsSync(staticFfmpeg)) FFMPEG = staticFfmpeg;
} catch {
  /* نستخدم ffmpeg من النظام */
}

const YTDLP = resolveYtDlp();
const IS_WIN = process.platform === 'win32';

function extraYtdlpArgs() {
  const args = ['--no-warnings', '--no-check-certificates'];
  if (process.env.YTDLP_COOKIES && fs.existsSync(process.env.YTDLP_COOKIES)) {
    args.push('--cookies', process.env.YTDLP_COOKIES);
  }
  if (process.env.YTDLP_EXTRA_ARGS) {
    args.push(...process.env.YTDLP_EXTRA_ARGS.split(' ').filter(Boolean));
  }
  return args;
}

// ---------------------------------------------------------------------------
// البحث عبر yt-dlp
// ---------------------------------------------------------------------------
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(YTDLP, args, { windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ out, err, code }));
  });
}

function mapEntry(e) {
  const id = e.id;
  return {
    id,
    title: e.title || 'بدون عنوان',
    url:
      e.webpage_url ||
      e.original_url ||
      (id ? `https://www.youtube.com/watch?v=${id}` : e.url),
    duration: Number(e.duration) || 0,
    uploader: e.uploader || e.channel || e.artist || '',
  };
}

async function searchSongs(query, limit = 5) {
  const { out, err, code } = await runYtDlp([
    `ytsearch${limit}:${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--no-playlist',
    ...extraYtdlpArgs(),
  ]);

  if (code !== 0) {
    const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    throw new Error(last || 'فشل البحث في يوتيوب');
  }

  let json;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error('ما قدرت أقرأ نتيجة البحث');
  }

  const entries = (json.entries && json.entries.length ? json.entries : [json]).filter(Boolean);
  return entries.map(mapEntry).filter((s) => s.url);
}

async function resolveQuery(query, maxPlaylist = 25) {
  const isUrl = /^https?:\/\//i.test(query.trim());

  if (isUrl) {
    const { out, err, code } = await runYtDlp([
      '--dump-single-json',
      '--no-warnings',
      ...extraYtdlpArgs(),
      query.trim(),
    ]);
    if (code !== 0) {
      const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      throw new Error(last || 'ما قدرت أفتح الرابط');
    }
    const json = JSON.parse(out);
    if (json.entries && json.entries.length) {
      const list = json.entries.filter(Boolean).slice(0, maxPlaylist).map(mapEntry);
      if (!list.length) throw new Error('قائمة التشغيل فاضية');
      return { type: 'playlist', songs: list, name: json.title || 'قائمة تشغيل' };
    }
    return { type: 'single', songs: [mapEntry(json)] };
  }

  const results = await searchSongs(query, 1);
  if (!results.length) throw new Error('ما لقيت أي نتيجة لهذا الاسم');
  return { type: 'single', songs: [results[0]] };
}

// ---------------------------------------------------------------------------
// بث الصوت: yt-dlp -> ffmpeg (Ogg Opus)
// ---------------------------------------------------------------------------
function createAudioStream(url, volume) {
  const ytdlp = spawn(
    YTDLP,
    ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--no-part', '--no-progress', ...extraYtdlpArgs(), url],
    { windowsHide: true },
  );

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-vn',
    '-af',
    `volume=${volume}`,
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-f',
    'ogg',
    'pipe:1',
  ];
  const ffmpeg = spawn(FFMPEG, ffmpegArgs, { windowsHide: true });

  ytdlp.stdout.pipe(ffmpeg.stdin);

  let ytdlpErr = '';
  ytdlp.stderr.on('data', (d) => {
    ytdlpErr += d.toString();
    if (ytdlpErr.length > 4000) ytdlpErr = ytdlpErr.slice(-2000);
  });
  ffmpeg.stderr.on('data', (d) => {
    const m = d.toString().trim();
    if (m) log('ffmpeg:', m.slice(0, 300));
  });

  ytdlp.on('error', (e) => log('yt-dlp error:', e.message));
  ffmpeg.on('error', (e) => log('ffmpeg error:', e.message));
  ytdlp.on('close', (code) => {
    if (code !== 0) {
      const last = ytdlpErr.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      log('yt-dlp فشل:', last || `exit ${code}`);
    }
  });

  const kill = () => {
    for (const p of [ytdlp, ffmpeg]) {
      try {
        p.kill(IS_WIN ? undefined : 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  };

  return { stream: ffmpeg.stdout, kill, processes: [ytdlp, ffmpeg] };
}

// ---------------------------------------------------------------------------
// طابور لكل سيرفر
// ---------------------------------------------------------------------------
const queues = new Map();

class GuildMusic {
  constructor(guildId) {
    this.guildId = guildId;
    this.songs = [];
    this.current = null;
    this.volume = Math.max(0, Math.min(1, Number(process.env.DEFAULT_VOLUME || 70) / 100));
    this.connection = null;
    this.currentStream = null;
    this.startedAt = 0;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.currentStream) {
        this.currentStream.kill();
        this.currentStream = null;
      }
      this.current = null;
      setTimeout(() => this.playNext(), 200);
    });

    this.player.on('error', (err) => {
      log('player error:', err.message);
      setTimeout(() => this.playNext(), 200);
    });
  }

  attach(connection) {
    this.connection = connection;
    connection.subscribe(this.player);
  }

  play(song) {
    this.current = song;
    this.startedAt = Date.now();

    const { stream, kill } = createAudioStream(song.url, this.volume);
    this.currentStream = { kill };

    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });
    this.player.play(resource);
    log(`▶️ تشغيل: ${song.title}`);
  }

  playNext() {
    if (!this.songs.length) {
      this.current = null;
      return;
    }
    const next = this.songs.shift();
    try {
      this.play(next);
    } catch (err) {
      log('فشل تشغيل الأغنية:', err.message);
      this.playNext();
    }
  }

  skip() {
    if (this.currentStream) {
      this.player.stop(true);
    }
  }

  stopAll() {
    this.songs = [];
    this.current = null;
    if (this.currentStream) {
      this.currentStream.kill();
      this.currentStream = null;
    }
    this.player.stop(true);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    // نعيد تشغيل الأغنية الحالية بالمستوى الجديد
    if (this.current) {
      this.songs.unshift(this.current);
      if (this.currentStream) {
        this.player.stop(true);
      } else {
        this.playNext();
      }
    }
  }
}

function getQueue(guildId) {
  let q = queues.get(guildId);
  if (!q) {
    q = new GuildMusic(guildId);
    queues.set(guildId, q);
  }
  return q;
}

function hasQueue(guildId) {
  return queues.has(guildId);
}

// ---------------------------------------------------------------------------
// الاتصال الصوتي
// ---------------------------------------------------------------------------
function getOrCreateConnection(guild, channel) {
  const music = getQueue(guild.id);
  let conn = getVoiceConnection(guild.id);

  if (
    conn &&
    conn.joinConfig.channelId !== channel.id &&
    conn.state.status !== VoiceConnectionStatus.Destroyed
  ) {
    try {
      conn.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
    } catch {
      /* ignore */
    }
  }

  if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) {
    conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  }

  music.attach(conn);
  return { conn, music };
}

function attachPlayerToConnection(guildId, connection) {
  if (!hasQueue(guildId)) return;
  getQueue(guildId).attach(connection);
}

// ---------------------------------------------------------------------------
// مساعدات العرض
// ---------------------------------------------------------------------------
function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return 'غير معروف';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function youtubeThumb(id) {
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined;
}

function nowPlayingEmbed(music) {
  const s = music.current;
  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle('🎶 شغّال الآن')
    .setDescription(`**[${s.title}](${s.url})**`)
    .addFields(
      { name: 'المدة', value: formatDuration(s.duration), inline: true },
      { name: 'الصوت', value: `${Math.round(music.volume * 100)}%`, inline: true },
    );
  if (s.uploader) embed.addFields({ name: 'القناة', value: s.uploader, inline: true });
  const thumb = youtubeThumb(s.id);
  if (thumb) embed.setThumbnail(thumb);
  return embed;
}

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('يشغّل أغنية (اكتب الاسم أو الصق رابط يوتيوب)')
      .addStringOption((o) =>
        o.setName('الاسم').setDescription('اسم الأغنية أو الرابط').setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder().setName('skip').setDescription('يتجاوز الأغنية الحالية').toJSON(),
    new SlashCommandBuilder().setName('pause').setDescription('يوقف التشغيل مؤقتاً').toJSON(),
    new SlashCommandBuilder().setName('resume').setDescription('يكمل التشغيل').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('يوقف الموسيقى ويفضي الطابور').toJSON(),
    new SlashCommandBuilder().setName('queue').setDescription('يعرض قائمة الانتظار').toJSON(),
    new SlashCommandBuilder().setName('nowplaying').setDescription('يعرض الأغنية الحالية').toJSON(),
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('يضبط مستوى الصوت (0-100)')
      .addIntegerOption((o) =>
        o
          .setName('المستوى')
          .setDescription('من 0 إلى 100')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100),
      )
      .toJSON(),
  ];
}

const MUSIC_COMMANDS = ['play', 'skip', 'pause', 'resume', 'stop', 'queue', 'nowplaying', 'volume'];

// ---------------------------------------------------------------------------
// معالجة الأوامر
// ---------------------------------------------------------------------------
async function handleInteraction(interaction, opts) {
  const name = interaction.commandName;
  if (!MUSIC_COMMANDS.includes(name)) return false;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'هذا الأمر يشتغل داخل سيرفر فقط.', ephemeral: true });
    return true;
  }

  const music = getQueue(guild.id);

  // ---------------------------------------------------------------- /play
  if (name === 'play') {
    await interaction.deferReply();
    const query = interaction.options.getString('الاسم');

    let channel = interaction.member?.voice?.channel || null;
    if (!channel) {
      const targetId = opts?.defaultChannelId;
      if (targetId) {
        channel =
          guild.channels.cache.get(targetId) ||
          (await guild.channels.fetch(targetId).catch(() => null));
      }
    }
    if (!channel) {
      await interaction.editReply('ادخل روم صوتي أول، أو حدد `VOICE_CHANNEL_ID` في الإعدادات.');
      return true;
    }

    let resolved;
    try {
      resolved = await resolveQuery(query);
    } catch (err) {
      await interaction.editReply(`❌ ما قدرت أجيب الأغنية.\n\`${err.message}\``);
      return true;
    }

    const { music: m } = getOrCreateConnection(guild, channel);

    if (resolved.type === 'playlist') {
      m.songs.push(...resolved.songs);
      await interaction.editReply(
        `➕ أضفت **${resolved.songs.length}** أغنية من \`${resolved.name}\` إلى الطابور.`,
      );
    } else {
      const song = resolved.songs[0];
      m.songs.push(song);
      if (m.current) {
        await interaction.editReply(
          `➕ أضفت **${song.title}** للمركز **#${m.songs.length}** في الطابور.`,
        );
      } else {
        await interaction.editReply(`🔎 جاري تشغيل **${song.title}** ...`);
      }
    }

    if (!m.current) m.playNext();
    return true;
  }

  // باقي الأوامر تحتاج طابور شغّال
  if (!music.current && !music.songs.length) {
    await interaction.reply({ content: 'ما فيه شي شغّال حالياً.', ephemeral: true });
    return true;
  }

  if (name === 'skip') {
    const skipped = music.current?.title ?? '—';
    music.skip();
    await interaction.reply(`⏭️ تخطيت: **${skipped}**`);
    return true;
  }

  if (name === 'pause') {
    music.player.pause();
    await interaction.reply('⏸️ تم الإيقاف المؤقت.');
    return true;
  }

  if (name === 'resume') {
    music.player.unpause();
    await interaction.reply('▶️ رجعنا للتشغيل.');
    return true;
  }

  if (name === 'stop') {
    music.stopAll();
    await interaction.reply('⏹️ وقفت الموسيقى وفضّيت الطابور.');
    return true;
  }

  if (name === 'queue') {
    const lines = [];
    if (music.current) lines.push(`**شغّال الآن:** ${music.current.title}`);
    music.songs
      .slice(0, 15)
      .forEach((s, i) => lines.push(`**${i + 1}.** ${s.title} \`${formatDuration(s.duration)}\``));
    if (music.songs.length > 15) lines.push(`... و **${music.songs.length - 15}** أغنية أخرى`);
    if (!lines.length) lines.push('الطابور فاضي.');
    await interaction.reply(lines.join('\n').slice(0, 1900));
    return true;
  }

  if (name === 'nowplaying') {
    if (!music.current) {
      await interaction.reply({ content: 'ما فيه شي شغّال حالياً.', ephemeral: true });
      return true;
    }
    await interaction.reply({ embeds: [nowPlayingEmbed(music)] });
    return true;
  }

  if (name === 'volume') {
    const level = interaction.options.getInteger('المستوى');
    music.setVolume(level / 100);
    await interaction.reply(`🔊 مستوى الصوت: **${level}%**`);
    return true;
  }

  return false;
}

module.exports = {
  buildCommands,
  handleInteraction,
  getQueue,
  hasQueue,
  attachPlayerToConnection,
  getOrCreateConnection,
  searchSongs,
  resolveQuery,
  formatDuration,
};
