/**
 * بوت ديسكورد يبقى 24/7 داخل الروم الصوتي المحدد.
 *
 * الفكرة:
 *  - أول ما يشتغل يدخل الروم الصوتي المحدد في .env
 *  - كل 30 ثانية يتأكد إنه لسا متصل، وإذا طلع يرجع تلقائيًا
 *  - لو انقطع الاتصال أو طردوه أو نقله أحد، يرجع بنفسه
 *  - أوامر سلاش: /join  /leave  /status
 */

'use strict';

require('dotenv').config();

const http = require('http');
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  SlashCommandBuilder,
  Routes,
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const music = require('./music');

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const VOICE_CHANNEL_ID = (process.env.VOICE_CHANNEL_ID || '').trim();
const CHECK_MS = Math.max(5, Number(process.env.CHECK_SECONDS || 30)) * 1000;
const LOCK_TO_CHANNEL = String(process.env.LOCK_TO_CHANNEL || 'true').toLowerCase() !== 'false';

let autoRejoin = true;   // يتوقف لما تكتب /leave
let joinTimer = null;    // مؤقت إعادة الدخول

// ---------------------------------------------------------------------------
// سجل بسيط
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ---------------------------------------------------------------------------
// عميل ديسكورد
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ---------------------------------------------------------------------------
// HTTP Health Check (لـ Render/Koyeb — يمنع النوم)
// ---------------------------------------------------------------------------
const HEALTH_PORT = Number(process.env.PORT || 3000);
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const conn = client.guilds.cache.first()?.voiceAdapterCreator ? 'connected' : 'disconnected';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      bot: client.user?.tag ?? 'starting',
      voice: conn,
      uptime: process.uptime(),
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log(`HTTP health server listening on :${HEALTH_PORT}`);
});

// ---------------------------------------------------------------------------
// منطق الصوت
// ---------------------------------------------------------------------------
function scheduleJoin(delayMs = 5000) {
  if (joinTimer) clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    joinTimer = null;
    ensureConnected().catch((e) => log('خطأ في إعادة الدخول:', e.message));
  }, delayMs);
}

function isConnectedTo(conn, channelId) {
  if (!conn) return false;
  const okState =
    conn.state.status === VoiceConnectionStatus.Ready ||
    conn.state.status === VoiceConnectionStatus.Signalling ||
    conn.state.status === VoiceConnectionStatus.Connecting;
  return okState && conn.joinConfig.channelId === channelId;
}

async function ensureConnected() {
  if (!autoRejoin) return;
  if (!VOICE_CHANNEL_ID) return;

  let channel;
  try {
    channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  } catch (err) {
    log('ما قدرت أجيب الروم الصوتي:', err.message);
    return;
  }

  if (!channel || !channel.guild) {
    log('الروم الصوتي غير موجود (يمكن البوت مو داخل السيرفر).');
    return;
  }

  if (
    channel.type !== ChannelType.GuildVoice &&
    channel.type !== ChannelType.GuildStageVoice
  ) {
    log('تنبيه: المعرف المحدد ليس رومًا صوتيًا.');
    return;
  }

  const guild = channel.guild;
  const conn = getVoiceConnection(guild.id);

  // متصل أصلاً بالروم الصحيح -> ما نسوي شي
  if (isConnectedTo(conn, channel.id)) return;

  // متصل بروم ثاني
  if (conn && LOCK_TO_CHANNEL && conn.joinConfig.channelId !== channel.id) {
    log('موجود في روم ثاني — أرجع للروم المحدد.');
    try {
      conn.rejoin({ channelId: channel.id, selfDeaf: false, selfMute: false });
      return;
    } catch {
      conn.destroy();
    }
  } else if (conn) {
    conn.destroy();
  }

  connect(guild, channel);
}

function connect(guild, channel) {
  let conn;
  try {
    conn = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  } catch (err) {
    log('فشل الاتصال الصوتي:', err.message);
    scheduleJoin(5000);
    return;
  }

  conn.on(VoiceConnectionStatus.Ready, () => {
    log(`✅ دخلت الروم الصوتي: ${channel.name}`);
    // نربط مشغّل الموسيقى بالاتصال عشان يشتغل الصوت
    try {
      music.attachPlayerToConnection(guild.id, conn);
    } catch (e) {
      log('تنبيه: ما قدرت أربط مشغّل الموسيقى:', e.message);
    }
  });

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    log('⚠️ انقطع الاتصال الصوتي — أحاول أرجع...');
    try {
      // احتمال أنه ينقل لسيرفر صوتي جديد (إعادة اتصال طبيعية)
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000),
      ]);
      log('...يعيد الاتصال حالياً.');
    } catch {
      // انقطاع حقيقي -> نتخلص وندخل من جديد
      try { conn.destroy(); } catch {}
      scheduleJoin(3000);
    }
  });

  conn.on('error', (err) => log('خطأ صوتي:', err.message));
}

// ---------------------------------------------------------------------------
// الأحداث
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  log(`تم تسجيل الدخول باسم ${client.user.tag} (ID: ${client.user.id})`);
  log(`البوت موجود في ${client.guilds.cache.size} سيرفر.`);

  try {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
  } catch (e) {
    log('تنبيه: مكتبة التشفير الصوتي ما تحمّلت:', e.message);
  }

  await registerCommands();

  // فحص أدوات الموسيقى (yt-dlp + ffmpeg)
  try {
    music.diagnostics();
  } catch (e) {
    log('تنبيه: فحص أدوات الموسيقى فشل:', e.message);
  }

  if (VOICE_CHANNEL_ID) {
    await ensureConnected();
  } else {
    log('VOICE_CHANNEL_ID غير محدد — البوت ما بيدخل روم تلقائيًا.');
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!client.user || newState.id !== client.user.id) return;
  if (!autoRejoin) return;

  // طلع من الروم (انفصل / طردوه)
  if (oldState.channelId && !newState.channelId) {
    log('⚠️ طلعت من الروم الصوتي — أحاول أرجع.');
    scheduleJoin(3000);
    return;
  }

  // نقله أحد لروم ثاني
  if (
    oldState.channelId &&
    newState.channelId &&
    oldState.channelId !== newState.channelId
  ) {
    log(`نقلوني إلى روم ثاني: ${newState.channel?.name ?? newState.channelId}`);
    if (LOCK_TO_CHANNEL) scheduleJoin(3000);
  }
});

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('join').setDescription('يدخل الروم الصوتي ويقعد فيه'),
    new SlashCommandBuilder().setName('leave').setDescription('يطلع من الروم ويوقف الرجوع التلقائي'),
    new SlashCommandBuilder().setName('status').setDescription('يعرض حالة البوت'),
    ...music.buildCommands(),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));

  try {
    if (GUILD_ID) {
      await client.rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
        body: commands,
      });
      log(`تم تسجيل الأوامر في السيرفر ${GUILD_ID}.`);
    } else {
      await client.rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      log('تم تسجيل الأوامر عالميًا (قد تأخذ وقت لتظهر).');
    }
  } catch (err) {
    log('ما قدرت أسجّل أوامر السلاش:', err.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // أوامر الموسيقى أولاً (play/skip/pause/resume/stop/queue/nowplaying/volume)
    const handled = await music.handleInteraction(interaction, {
      defaultChannelId: VOICE_CHANNEL_ID,
    });
    if (handled) return;

    if (interaction.commandName === 'join') {
      autoRejoin = true;
      await interaction.deferReply();
      let channel = null;
      if (VOICE_CHANNEL_ID) {
        channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
      }
      if (!channel) channel = interaction.member?.voice?.channel ?? null;
      if (!channel) {
        await interaction.editReply('لازم تحدد روم صوتي في الإعدادات أو تدخل روم بصوتك.');
        return;
      }
      const guild = channel.guild;
      const conn = getVoiceConnection(guild.id);
      if (conn) conn.destroy();
      connect(guild, channel);
      await interaction.editReply(`دخلت الروم الصوتي: **${channel.name}** ✅`);
      return;
    }

    if (interaction.commandName === 'leave') {
      autoRejoin = false;
      // نوقف الموسيقى أيضاً
      if (interaction.guild && music.hasQueue(interaction.guild.id)) {
        try {
          music.getQueue(interaction.guild.id).stopAll();
        } catch {
          /* ignore */
        }
      }
      const conn = interaction.guild ? getVoiceConnection(interaction.guild.id) : null;
      if (conn) {
        conn.destroy();
        await interaction.reply('طلعت من الروم ووقفت الرجوع التلقائي. اكتب `/join` عشان أرجع.');
      } else {
        await interaction.reply('أنا أصلاً مو داخل أي روم.');
      }
      return;
    }

    if (interaction.commandName === 'status') {
      const conn = interaction.guild ? getVoiceConnection(interaction.guild.id) : null;
      if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
        await interaction.reply(
          `داخل الروم 🟢\n` +
            `اسم الروم: **${interaction.guild.channels.cache.get(conn.joinConfig.channelId)?.name ?? 'غير معروف'}**\n` +
            `زمن الاستجابة: ${Math.round(client.ws.ping)}ms\n` +
            `الرجوع التلقائي: ${autoRejoin ? 'مفعّل' : 'متوقف'}`,
        );
      } else {
        await interaction.reply('لست داخل أي روم صوتي 🔴');
      }
    }
  } catch (err) {
    log('خطأ في الأمر:', err.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`صار خطأ: ${err.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `صار خطأ: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// الفحص الدوري
// ---------------------------------------------------------------------------
setInterval(() => {
  ensureConnected().catch((e) => log('خطأ في الفحص الدوري:', e.message));
}, CHECK_MS);

// شبكة أمان: أي خطأ غير متوقع لا يوقف البوت
process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.message ?? err));
process.on('uncaughtException', (err) => log('uncaughtException:', err?.message ?? err));

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------
if (!TOKEN) {
  log('❌ ما لقيت DISCORD_TOKEN في ملف .env');
  process.exit(1);
}

log('جاري تسجيل الدخول...');
client.login(TOKEN).catch((err) => {
  log('❌ فشل تسجيل الدخول:', err.message);
  process.exit(1);
});
