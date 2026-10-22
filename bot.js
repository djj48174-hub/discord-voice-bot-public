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
  PermissionFlagsBits,
} = require('discord.js');

const {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const music = require('./music');
const chat = require('./chat');
const speech = require('./speech');
const { VoiceChat } = require('./voicechat');
const admin = require('./admin');
const profanity = require('./profanity');
const quran = require('./quran');
const hadith = require('./hadith');
const radio = require('./radio');
const guard = require('./guard');

// ---------------------------------------------------------------------------
// وحدات الميزات الإضافية (مستويات/سحوبات/تذاكر/فويس مؤقت)
// كل وحدة معزولة: لو وحدة فشلت ما توقف البوت.
// ---------------------------------------------------------------------------
const MODULES = {};
for (const [name, file] of Object.entries({
  tempvoice: './tempvoice',
  levels: './levels',
  giveaways: './giveaways',
  tickets: './tickets',
  rules: './rules',
})) {
  try {
    MODULES[name] = require(file);
  } catch (err) {
    console.error(`[modules] فشل تحميل ${name}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// الدعم الفني وروم الانتظار 🆘
// ---------------------------------------------------------------------------
const WAITING_CHANNEL_ID = (process.env.WAITING_CHANNEL_ID || '1562222156178259969').trim();
const SUPPORT_TEXT_CHANNEL_ID = (process.env.SUPPORT_TEXT_CHANNEL_ID || '1562222149379301426').trim();
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID || '1562213525563383880').trim();

// الأعضاء اللي كتمناهم في روم الانتظار (عشان نفكّهم لما ينتقلون)
const waitingMuted = new Set();

// ---------------------------------------------------------------------------
// ميزات ملغاة: صار البوت إداري فقط (لا موسيقى ولا صوت)
// ---------------------------------------------------------------------------
const MUSIC_ENABLED = false;
const VOICE_ENABLED = false;

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const VOICE_CHANNEL_ID = (process.env.VOICE_CHANNEL_ID || '').trim();
const CHECK_MS = Math.max(5, Number(process.env.CHECK_SECONDS || 30)) * 1000;
let memTick = 0;
const LOCK_TO_CHANNEL = String(process.env.LOCK_TO_CHANNEL || 'true').toLowerCase() !== 'false';
// ترحيب صوتي عند دخول أول شخص للروم (يشتغل كفحص تلقائي للنطق)
const GREET_ON_JOIN = String(process.env.VOICE_GREET_ON_JOIN || 'true').toLowerCase() !== 'false';

// المحادثة
const CHAT_ENABLED = String(process.env.CHAT_ENABLED || 'true').toLowerCase() !== 'false';
// لازم تفعّل "Message Content Intent" في بوابة المطورين قبل ما تشغّل هذا
const MSG_CONTENT =
  String(process.env.ENABLE_MESSAGE_CONTENT || 'false').toLowerCase() === 'true';

// رتبة العضو الافتراضية للأعضاء الجدد
const MEMBER_ROLE_NAME = (process.env.MEMBER_ROLE_NAME || 'عضو').trim();
const MEMBER_ROLE_ID = (process.env.MEMBER_ROLE_ID || '').trim();

// حالة كل سيرفر على حدة — البوت يخدم أكثر من سيرفر في نفس الوقت
// الرد الصوتي: الافتراضي من الإعدادات، وكل سيرفر له حالته (تشغيل/إيقاف مستقل)
const VOICE_CHAT_DEFAULT = String(process.env.VOICE_CHAT || 'true').toLowerCase() !== 'false';
// أوامر الموسيقى/الروم بالصوت — مقفلة افتراضياً: الأوامر (شغل/طف/التالي) تكون من الشات
// نطق "شغل الأغنية" بالصوت يسبب سوء فهم للأسماء — الشات أدق
const VOICE_SONG_COMMANDS =
  String(process.env.VOICE_SONG_COMMANDS || 'false').toLowerCase() === 'true';
const guildState = new Map();
function gs(guildId) {
  const id = String(guildId || '');
  let s = guildState.get(id);
  if (!s) {
    s = {
      voiceChat: null, // وحدة المحادثة الصوتية (سماع المتكلمين)
      autoRejoin: true, // يتوقف لما تكتب /leave
      joinTimer: null, // مؤقت إعادة الدخول
      lastJoinAt: 0, // وقت آخر محاولة دخول (عشان ما نكررها بسرعة)
      channelId: null, // الروم الصوتي اللي قعد فيه بهذا السيرفر
      busy: false, // البوت يرد حالياً — نحفظ الكلام الجديد ونرد عليه بعدين
      pending: null, // آخر كلام وصل والبوت مشغول (عشان ما نفقده)
      lastSpoken: '', // آخر شي نطقه البوت (نكشف صدى صوتنا)
      voiceOn: VOICE_CHAT_DEFAULT, // الرد الصوتي في هذا السيرفر
    };
    guildState.set(id, s);
  }
  return s;
}

/** الروم الصوتي اللي البوت قاعد فيه فعلياً الآن */
function botChannelOf(guild) {
  return guild?.members?.me?.voice?.channel ?? null;
}

// آخر كلام صوتي (للفحص): أي سيرفر سمع منه، وش قال، وش رددنا
let lastVoice = null;

// سجل آخر عمليات تشغيل/إيقاف الرد الصوتي (للفحص من /health)
const voiceToggleHistory = [];

// (الرد الصوتي لكل سيرفر حالته الخاصة — انظر gs().voiceOn)

// مهلة السماح لمحاولة الاتصال قبل ما نعتبرها فاشلة ونعيدها
const JOIN_GRACE_MS = 8000;

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
    GatewayIntentBits.GuildMessages,
    // لازم لاستقبال الأعضاء الجدد وإعطائهم رتبة "عضو"
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    // اختياري: يخلي البوت يقرأ كل الرسائل (يحتاج تفعيله في بوابة المطورين)
    ...(MSG_CONTENT ? [GatewayIntentBits.MessageContent] : []),
  ],
});

// تشغيل الوحدات الإضافية (كل وحدة داخل try/catch)
for (const [name, mod] of Object.entries(MODULES)) {
  try {
    if (typeof mod.init === 'function') mod.init(client);
  } catch (err) {
    console.error(`[modules] فشل تشغيل ${name}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP Health Check (لـ Render/Koyeb — يمنع النوم)
// ---------------------------------------------------------------------------
const HEALTH_PORT = Number(process.env.PORT || 3000);
const healthServer = http.createServer(async (req, res) => {
  const ua = req.headers['user-agent'] || 'unknown';

  // فحص المصادر من داخل السيرفر (محمي بمفتاح)
  if (req.url.startsWith('/diag')) {
    const key = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
    const want = (process.env.DIAG_KEY || '').trim();
    if (!want || key !== want) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    log('[diag] طلب فحص المصادر…');
    try {
      const u = new URL(req.url, 'http://localhost');

      // قياس سرعة/دقة التفريغ لكل موديل على مقاطع حقيقية (stt=1)
      if (u.searchParams.get('stt') === '1') {
        const modelsParam = (u.searchParams.get('models') || '').split(',').map((s) => s.trim()).filter(Boolean);
        const caps = Number(u.searchParams.get('caps') || 2);
        const rows = await speech.benchStt({
          models: modelsParam.length ? modelsParam : undefined,
          caps,
          keys: Number(u.searchParams.get('keys') || 0),
          perModelMs: Number(u.searchParams.get('timeout') || 12000),
        });
        log(`[diag] قياس التفريغ: ${rows.length} نتيجة`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, rows }, null, 2));
        return;
      }

      // فحص سريع للاتصال الصوتي بدون تشغيل صوت (info=1)
      if (u.searchParams.get('info') === '1') {
        const g = (GUILD_ID && client.guilds.cache.get(GUILD_ID)) || client.guilds.cache.first();
        const conn = g ? getVoiceConnection(g.id) : null;
        const cd = conn ? music.connConnectionData(conn) : null;
        const dave = conn ? music.connDave(conn) : null;
        const chId = conn?.joinConfig?.channelId;
        const ch = chId ? g?.channels?.cache?.get(chId) : null;
        const voice = g?.members?.me?.voice;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            {
              connStatus: conn?.state?.status ?? null,
              channelName: ch?.name ?? null,
              members: ch ? [...ch.members.values()].map((mm) => mm.displayName) : [],
              selfMute: conn?.joinConfig?.selfMute ?? null,
              selfDeaf: conn?.joinConfig?.selfDeaf ?? null,
              serverMute: voice?.mute ?? null,
              serverDeaf: voice?.deaf ?? null,
              packetsPlayed: cd?.packetsPlayed ?? null,
              encryptionMode: cd?.encryptionMode ?? null,
              daveProtocol: dave?.protocolVersion ?? null,
              daveReady: dave?.session?.ready ?? false,
              voiceChat: gs(g.id).voiceChat ? gs(g.id).voiceChat.stats : null,
              voiceDebug: music.getVoiceDebug(50),
              captures: speech.captureDebug(u.searchParams.get('audio') === '1'),
            },
            null,
            2,
          ),
        );
        return;
      }

      // تحكّم صوتي للفحص (join/leave/status) — لكل سيرفر على حدة
      if (u.searchParams.get('radio')) {
        const action = String(u.searchParams.get('radio'));
        const gid = u.searchParams.get('guild') || undefined;
        let out;
        if (action === 'join') {
          out = await radio.join(client, u.searchParams.get('channel') || '', gid);
        } else if (action === 'leave') {
          out = radio.leave(gid || null);
        } else {
          out = radio.status(gid);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, radio: out }, null, 2));
        return;
      }

      // تشغيل صوت تجريبي في الروم الصوتي (لتشخيص مشكلة عدم سماع الرد)
      if (u.searchParams.get('play') === '1') {
        const send = (obj, code = 200) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj, null, 2));
        };

        const g = (GUILD_ID && client.guilds.cache.get(GUILD_ID)) || client.guilds.cache.first();
        if (!g) {
          send({ error: 'ما فيه سيرفر' }, 404);
          return;
        }

        const conn = getVoiceConnection(g.id);
        if (!conn) {
          send({ error: 'البوت مو في روم صوتي' }, 409);
          return;
        }
        const packetsAtStart = music.countPlayedPackets(conn);

        const m = music.getQueue(g.id);
        const states = [];

        // نحاول نلغي كتم/صمم السيرفر عن البوت نفسه (لو صار بالغلط)
        let fixVoice = null;
        const me0 = g.members?.me;
        try {
          if (me0?.voice?.deaf) {
            await me0.voice.setDeaf(false, 'إصلاح تلقائي').then(
              () => {
                fixVoice = 'ألغيت صمم السيرفر';
              },
              (e) => {
                fixVoice = `فشل إلغاء الصمم: ${String(e.message).slice(0, 90)}`;
              },
            );
          } else if (me0?.voice?.mute) {
            await me0.voice.setMute(false, 'إصلاح تلقائي').then(
              () => {
                fixVoice = 'ألغيت كتم السيرفر';
              },
              (e) => {
                fixVoice = `فشل إلغاء الكتم: ${String(e.message).slice(0, 90)}`;
              },
            );
          }
        } catch (e) {
          fixVoice = `خطأ: ${String(e.message).slice(0, 90)}`;
        }

        const onState = (o, n) => {
          states.push(`${o.status} -> ${n.status}`);
          log(`[diag] player: ${o.status} -> ${n.status}`);
        };
        m.player.on('stateChange', onState);

        // tone=1 يجبر نغمة محلية (يعزل مسار التشغيل عن Edge/Groq TTS)
        const forceTone = u.searchParams.get('tone') === '1';
        let ogg;
        let source = 'tts';
        if (forceTone) {
          ogg = await speech.testTone(3, 440);
          source = 'tone';
        } else {
          try {
            ogg = await speech.speak('هلا، هذا اختبار صوت من البوت. هل تسمعني؟');
          } catch (e) {
            log('[diag] النطق فشل، نستخدم نغمة:', String(e.message).slice(0, 80));
            ogg = await speech.testTone(3, 440);
            source = 'tone';
          }
        }

        // تأكيد ربط المشغّل قبل الاختبار
        try {
          music.attachPlayerToConnection(g.id, conn);
        } catch {
          /* ignore */
        }

        const p = m.speak(ogg, 1).then(
          (v) => ({ ok: v }),
          (e) => ({ ok: false, error: String(e.message).slice(0, 120) }),
        );

        // ننتظر انتهاء النطق بحد أقصى 15 ثانية
        const result = await Promise.race([
          p,
          new Promise((r) => setTimeout(() => r({ ok: null, note: 'لسا يشتغل بعد 15ث' }), 15000)),
        ]);

        setTimeout(() => m.player.off('stateChange', onState), 2000);

        const me = g.members?.me;
        const voice = me?.voice;
        const ch = g.channels.cache.get(conn.joinConfig.channelId);
        const cd = music.connConnectionData(conn);
        const dave = music.connDave(conn);
        send({
          ...result,
          states,
          playerStatus: m.player.state.status,
          subscribers: m.player.playable?.length ?? m.player.subscribers?.size ?? null,
          connStatus: conn.state?.status ?? null,
          channelId: conn.joinConfig.channelId,
          channelName: ch?.name || null,
          selfMute: conn.joinConfig.selfMute,
          selfDeaf: conn.joinConfig.selfDeaf,
          serverMute: voice?.mute ?? null,
          serverDeaf: voice?.deaf ?? null,
          suppress: voice?.suppress ?? null,
          speaking: voice?.speaking ?? null,
          voiceChannelMembers: ch?.members?.size ?? 0,
          voiceChannelMemberNames: ch
            ? [...ch.members.values()].map((mm) => mm.displayName || mm.user?.username)
            : [],
          // مؤشرات إرسال الصوت الفعلية
          packetsPlayed: cd?.packetsPlayed ?? null,
          packetsSentDuringTest: (cd?.packetsPlayed ?? 0) - packetsAtStart,
          sequence: cd?.sequence ?? null,
          timestamp: cd?.timestamp ?? null,
          ssrc: cd?.ssrc ?? null,
          encryptionMode: cd?.encryptionMode ?? null,
          sentSpeaking: cd?.speaking ?? null,
          daveProtocol: dave?.protocolVersion ?? null,
          daveReady: dave?.session?.ready ?? null,
          davePrivacyCode: (() => {
            try {
              return dave?.voicePrivacyCode ?? null;
            } catch {
              return 'err';
            }
          })(),
          audioBytes: ogg.length,
          audioSource: source,
          fixVoice,
          voiceDebug: music.getVoiceDebug(60),
          perms: (() => {
            const p = me?.permissions;
            if (!p) return null;
            return {
              admin: p.has('Administrator'),
              deafenMembers: p.has('DeafenMembers'),
              muteMembers: p.has('MuteMembers'),
              connect: p.has('Connect'),
              speak: p.has('Speak'),
              prioritySpeaker: p.has('PrioritySpeaker'),
            };
          })(),
        });
        return;
      }

      // فحص تشغيل أغنية فعلياً: ?song=اسم الأغنية (يبحث ويشغّل ويرجّع النتيجة)
      const songQ = (u.searchParams.get('song') || '').trim();
      if (songQ) {
        const send = (obj, code = 200) => {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj, null, 2));
        };
        const gid = u.searchParams.get('guild') || GUILD_ID || client.guilds.cache.first()?.id;
        const g = client.guilds.cache.get(gid) || client.guilds.cache.first();
        if (!g) {
          send({ error: 'ما فيه سيرفر' }, 404);
          return;
        }
        const conn = getVoiceConnection(g.id);
        if (!conn) {
          send({ error: `البوت مو في روم صوتي بسيرفر ${g.name}` }, 409);
          return;
        }
        const m = music.getQueue(g.id);
        try {
          music.attachPlayerToConnection(g.id, conn);
        } catch {
          /* ignore */
        }
        const states = [];
        const onState = (o, n) => states.push(`${o.status} -> ${n.status}`);
        m.player.on('stateChange', onState);
        const t0 = Date.now();
        let resolved;
        try {
          resolved = await music.resolveQuery(songQ);
        } catch (e) {
          resolved = { error: e };
        }
        if (!resolved || resolved.error || !Array.isArray(resolved.songs)) {
          setTimeout(() => m.player.off('stateChange', onState), 1000);
          send({
            ok: false,
            stage: 'البحث',
            query: songQ,
            error: String(resolved?.error?.message || 'فشل البحث').slice(0, 300),
            closest: resolved?.error?.closest ?? null,
            ms: Date.now() - t0,
          });
          return;
        }
        const first = resolved.songs[0];
        m.songs.push(...resolved.songs);
        const waitMs = Math.max(5, Number(u.searchParams.get('wait') || 45)) * 1000;
        const resolveMs = Date.now() - t0;
        const played = await m.startAndWait(waitMs).catch(() => false);
        const cd = music.connConnectionData(conn);
        const out = {
          ok: Boolean(played),
          query: songQ,
          title: first.title,
          source: first.source || null,
          weak: Boolean(resolved.weak),
          resolveMs,
          totalMs: Date.now() - t0,
          playerStatus: m.player.state.status,
          packetsPlayed: cd?.packetsPlayed ?? null,
          states,
        };
        setTimeout(() => m.player.off('stateChange', onState), 2000);
        send(out);
        // نوقف الأغنية بعد الفحص (إلا لو keep=1)
        if (u.searchParams.get('keep') !== '1') {
          setTimeout(() => {
            try {
              m.stopAll();
            } catch {
              /* ignore */
            }
          }, 2500);
        }
        return;
      }

      // نطق اختباري في سيرفر محدد: ?say=النص&guild=ID
      // (يقيس كم حزمة صوت طلعت من اتصال هذا السيرفر بالذات — للتأكد ما فيه خلط بين السيرفرات)
      const sayText = (u.searchParams.get('say') || '').trim();
      if (sayText) {
        const gid = u.searchParams.get('guild') || GUILD_ID || client.guilds.cache.first()?.id;
        const g = client.guilds.cache.get(gid) || client.guilds.cache.first();
        if (!g) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'ما فيه سيرفر' }));
          return;
        }
        const conn = getVoiceConnection(g.id);
        if (!conn) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `البوت مو في روم صوتي بسيرفر ${g.name}` }));
          return;
        }
        const m = music.getQueue(g.id);
        try {
          music.attachPlayerToConnection(g.id, conn);
        } catch {
          /* ignore */
        }
        const t0 = Date.now();
        const before = music.connConnectionData(conn)?.packetsPlayed ?? 0;
        let played = false;
        let errMsg = null;
        try {
          const ogg = await speech.speak(sayText);
          played = await m.speak(ogg, 1);
        } catch (e) {
          errMsg = String(e.message).slice(0, 200);
        }
        const cd = music.connConnectionData(conn);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            {
              guild: g.name,
              guildId: g.id,
              channel: botChannelOf(g)?.name ?? null,
              played,
              error: errMsg,
              ms: Date.now() - t0,
              packetsSent: (cd?.packetsPlayed ?? 0) - before,
              packetsPlayed: cd?.packetsPlayed ?? null,
              lastVoice,
            },
            null,
            2,
          ),
        );
        return;
      }

      // فحص المصادر يأكل معالج كثير — نسمح به فقط لمن يطلب صراحة (q أو vids أو diag=1)
      const wantsSourceDiag =
        u.searchParams.has('q') || u.searchParams.has('vids') || u.searchParams.get('diag') === '1';
      if (!wantsSourceDiag) {
        log('[diag] طلب بدون معاملات — ما نشغّل فحص المصادر الثقيل');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify(
            {
              note: 'فحص المصادر يحتاج معامل: q=اسم أو vids=ids أو diag=1',
              usage: {
                info: '?info=1',
                play: '?play=1 (نطق اختباري)',
                song: '?song=اسم الأغنية (تشغيل فعلي)',
                say: '?say=نص&guild=ID (نطق اختباري في سيرفر محدد)',
                stt: '?stt=1',
                sources: '?diag=1',
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      const data = await music.diagnose({
        query: u.searchParams.get('q') || '',
        vids: u.searchParams.get('vids') || '',
        client: u.searchParams.get('client') || '',
        seq: u.searchParams.get('seq') || '',
        timeout: u.searchParams.get('timeout') || '',
        jsr: u.searchParams.get('jsr') || '',
      });
      log('[diag] تم الفحص');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data, null, 2));
    } catch (e) {
      log('[diag] فشل:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    const guild =
      (GUILD_ID && client.guilds.cache.get(GUILD_ID)) || client.guilds.cache.first();
    const conn = guild ? getVoiceConnection(guild.id) : null;
    const inChannelId = guild?.members?.me?.voice?.channelId ?? null;
    const ready = Boolean(conn) && conn.state.status === VoiceConnectionStatus.Ready;
    const voice = ready && inChannelId ? 'connected' : inChannelId ? 'connecting' : 'disconnected';

    log(`[health] زيارة من: ${ua}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        modules: Object.keys(MODULES),
        commands: REGISTER_STATE,
        bot: client.user?.tag ?? 'starting',
        gateway: client.isReady() ? 'ready' : 'offline',
        voice,
        channel: inChannelId
          ? guild.channels.cache.get(inChannelId)?.name ?? inChannelId
          : null,
        uptime: Math.round(process.uptime()),
        voiceChat: guild && gs(guild.id).voiceChat ? gs(guild.id).voiceChat.stats : null,
        lastVoice: lastVoice,
        // أوامر الموسيقى بالصوت: مقفلة = الأوامر من الشات فقط
        voiceSongCommands: VOICE_SONG_COMMANDS,
        // آخر عمليات تشغيل/إيقاف الرد الصوتي (لمعرفة متى انطفأ وبأي كلمة)
        voiceToggles: voiceToggleHistory,
        music: guild
          ? (() => {
              try {
                const q = music.getQueue(guild.id);
                const cd2 = conn ? music.connConnectionData(conn) : null;
                return {
                  status: q.player.state.status,
                  title: q.current?.title ?? null,
                  source: q.current?.source ?? null,
                  queued: q.songs?.length ?? 0,
                  packetsPlayed: cd2?.packetsPlayed ?? null,
                  positionSec:
                    typeof q.player.state.playbackDuration === 'number'
                      ? Math.round(q.player.state.playbackDuration / 1000)
                      : null,
                };
              } catch (e) {
                return { error: String(e.message).slice(0, 80) };
              }
            })()
          : null,
        guilds: [...client.guilds.cache.values()].map((g2) => ({
          id: g2.id,
          name: g2.name,
          channel:
            botChannelOf(g2)?.name ?? null,
          channelId: botChannelOf(g2)?.id ?? null,
          connState: getVoiceConnection(g2.id)?.state?.status ?? null,
          members: botChannelOf(g2)?.members?.size ?? 0,
          autoRejoin: gs(g2.id).autoRejoin,
          voiceChat: Boolean(gs(g2.id).voiceChat),
          voiceOn: gs(g2.id).voiceOn,
          packetsPlayed: (() => {
            try {
              const c2 = getVoiceConnection(g2.id);
              return c2 ? music.connConnectionData(c2)?.packetsPlayed ?? null : null;
            } catch {
              return null;
            }
          })(),
        })),
        voiceMembers: (() => {
          const ch = inChannelId ? guild?.channels?.cache?.get(inChannelId) : null;
          return ch ? [...ch.members.values()].map((mm) => mm.displayName) : [];
        })(),
        dave: conn
          ? {
              ready: Boolean(music.connDave(conn)?.session?.ready),
              protocol: music.connDave(conn)?.protocolVersion ?? null,
            }
          : null,
        voiceState: guild?.members?.me?.voice
          ? {
              mute: guild.members.me.voice.mute ?? null,
              deaf: guild.members.me.voice.deaf ?? null,
              selfMute: guild.members.me.voice.selfMute ?? null,
              selfDeaf: guild.members.me.voice.selfDeaf ?? null,
              suppress: guild.members.me.voice.suppress ?? null,
            }
          : null,
      }),
    );
  } else {
    log(`[health] 404: ${req.method} ${req.url} — ${ua}`);
    res.writeHead(404);
    res.end('Not Found');
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log(`HTTP health server listening on :${HEALTH_PORT}`);
});

// ---------------------------------------------------------------------------
// منبّه ذاتي (لـ Render/Koyeb): يزور نفسه كل ٥ دقايق عشان ما ينام من قلة الزيارات
// ---------------------------------------------------------------------------
const SELF_URL = (process.env.SELF_PING_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
if (SELF_URL && String(process.env.SELF_PING || 'true').toLowerCase() !== 'false') {
  const everyMs = Math.max(60, Number(process.env.SELF_PING_SECONDS || 300)) * 1000;
  const ping = async () => {
    try {
      const res = await fetch(`${SELF_URL.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) log(`🔔 منبّه ذاتي: رد غير متوقع ${res.status}`);
    } catch (e) {
      log(`🔔 منبّه ذاتي فشل: ${String(e.message).slice(0, 90)}`);
    }
  };
  setTimeout(ping, 45000);
  setInterval(ping, everyMs);
  log(`🔔 المنبّه الذاتي شغّال كل ${Math.round(everyMs / 1000)} ثانية على ${SELF_URL}`);
}

// ---------------------------------------------------------------------------
// منطق الصوت
// ---------------------------------------------------------------------------
let joinTimer = null; // مؤقت إعادة الدخول (للمسار العام بدون سيرفر محدد)

function scheduleJoin(delayMs = 5000, guildId = '') {
  if (!VOICE_ENABLED) return;
  const key = String(guildId || '');
  const st = key ? gs(key) : null;
  const run = () => {
    if (st) st.joinTimer = null;
    else joinTimer = null;
    ensureConnected(key || undefined).catch((e) => log('خطأ في إعادة الدخول:', e.message));
  };
  if (st) {
    if (st.joinTimer) clearTimeout(st.joinTimer);
    st.joinTimer = setTimeout(run, delayMs);
  } else {
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = setTimeout(run, delayMs);
  }
}

function isConnectedTo(conn, channelId) {
  if (!conn) return false;
  const okState =
    conn.state.status === VoiceConnectionStatus.Ready ||
    conn.state.status === VoiceConnectionStatus.Signalling ||
    conn.state.status === VoiceConnectionStatus.Connecting;
  return okState && conn.joinConfig.channelId === channelId;
}

/** الرومات الصوتية المحددة في الإعدادات (تقبل أكثر من روم مفصولة بفاصلة) */
function configuredChannelIds() {
  const raw = [process.env.VOICE_CHANNEL_ID, process.env.VOICE_CHANNEL_IDS]
    .filter(Boolean)
    .join(',');
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d{5,}$/.test(s)),
    ),
  ];
}

function isVoiceType(ch) {
  return Boolean(ch) && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice);
}

/** أول روم صوتي ممكن ندخله في السيرفر (لما ما فيه روم محدد بالإعدادات) */
function pickVoiceChannel(guild) {
  try {
    const me = guild.members.me;
    const list = [...guild.channels.cache.values()].filter(
      (c) => c && c.type === ChannelType.GuildVoice && c.id !== guild.afkChannelId,
    );
    const withPeople = list.find((c) => c.members.size > 0);
    if (withPeople) return withPeople;
    const joinable = list.filter((c) => {
      const perms = me ? c.permissionsFor(me) : null;
      const canJoin = !perms || perms.has(PermissionFlagsBits.Connect);
      return canJoin && (c.userLimit === 0 || c.members.size < c.userLimit);
    });
    return joinable[0] || list[0] || null;
  } catch {
    return null;
  }
}

/** الروم الصوتي المطلوب لسيرفر معيّن */
async function targetChannelFor(guildId) {
  const st = gs(guildId);

  // 1) آخر روم قعد فيه (يتحدد من /join أو من دخول تلقائي سابق)
  if (st.channelId) {
    const cached = client.channels.cache.get(st.channelId);
    if (cached && cached.guildId === guildId && isVoiceType(cached)) return cached;
    const fetched = await client.channels.fetch(st.channelId).catch(() => null);
    if (fetched && fetched.guildId === guildId && isVoiceType(fetched)) return fetched;
  }

  // 2) الرومات المحددة في الإعدادات
  for (const id of configuredChannelIds()) {
    const ch =
      client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
    if (ch && ch.guildId === guildId && isVoiceType(ch)) return ch;
  }

  // 3) أول روم صوتي متاح بالسيرفر
  const guild = client.guilds.cache.get(guildId);
  return guild ? pickVoiceChannel(guild) : null;
}

/** يتأكد أن البوت داخل الروم الصوتي — لسيرفر واحد أو لكل السيرفرات */
async function ensureConnected(guildId) {
  if (!guildId) {
    for (const g of client.guilds.cache.values()) {
      await ensureConnected(g.id).catch(() => {});
    }
    return;
  }

  const st = gs(guildId);
  if (!st.autoRejoin) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  let channel = null;
  try {
    channel = await targetChannelFor(guildId);
  } catch (err) {
    log('ما قدرت أجيب الروم الصوتي:', err.message);
    return;
  }

  if (!channel) {
    if (!st.warnedNoChannel) {
      st.warnedNoChannel = true;
      log(`ما فيه روم صوتي في «${guild.name}» — ادخل روم بصوتك واكتب /join.`);
    }
    return;
  }
  st.channelId = channel.id;

  const conn = getVoiceConnection(guild.id);

  // مصدر الحقيقة: رأي ديسكورد نفسه عن مكان البوت
  const meChannelId = botChannelOf(guild)?.id ?? null;
  const ready = Boolean(conn) && conn.state.status === VoiceConnectionStatus.Ready;

  // متصل فعلاً بالروم الصحيح -> ما نسوي شي
  if (ready && meChannelId === channel.id) return;

  // لسا داخل مهلة محاولة حديثة -> ننتظرها
  if (Date.now() - st.lastJoinAt < JOIN_GRACE_MS) return;

  log(
    `⚠️ الاتصال غير سليم (state=${conn ? conn.state.status : 'لا يوجد'}, ` +
      `في الروم=${meChannelId ?? 'لا'}) — أعيد الدخول للروم.`,
  );

  if (conn) {
    try {
      conn.destroy();
    } catch {
      /* ignore */
    }
  }

  st.lastJoinAt = Date.now();
  connect(guild, channel);
}

function connect(guild, channel) {
  const st = gs(guild.id);
  st.lastJoinAt = Date.now();
  st.channelId = channel.id;
  st.warnedNoChannel = false;
  let conn;
  try {
    // مصدر واحد للاتصال — نفس الإعدادات (selfMute/selfDeaf/تصحيح الصوت)
    conn = music.getOrCreateConnection(guild, channel).conn;
  } catch (err) {
    log('فشل الاتصال الصوتي:', err.message);
    scheduleJoin(5000, guild.id);
    return;
  }

  let lastReadyLog = 0;
  conn.on(VoiceConnectionStatus.Ready, () => {
    // نمنع تكرار الرسالة (بروتوكول DAVE يعيد التفاوض أكثر من مرة)
    if (Date.now() - lastReadyLog > 10000) {
      log(`✅ دخلت الروم الصوتي: ${channel.name} — سيرفر «${guild.name}»`);
      lastReadyLog = Date.now();
    }
    // نربط مشغّل الموسيقى بالاتصال عشان يشتغل الصوت
    try {
      music.attachPlayerToConnection(guild.id, conn);
    } catch (e) {
      log('تنبيه: ما قدرت أربط مشغّل الموسيقى:', e.message);
    }

    // نفعّل السماع للمحادثة الصوتية
    try {
      if (st.voiceChat) st.voiceChat.stop();
      // معالجة كلام المستخدم — نستدعيها من الطابور تحت (واحد في كل مرة)
      const handleVoice = async (u) => {
        st.busy = true;
        const t0 = Date.now();
        try {
          const said = await speech.transcribe(u.packets, { language: 'ar' });
          if (!said.text || said.text.trim().length < 2) {
            log(`🔇 ما فيه كلام واضح — ما أرد (${u.count} حزمة)`);
            return;
          }

          const wake = (process.env.VOICE_WAKE_WORD || '').trim();
          const text = wake ? said.text.replace(wake, '').trim() : said.text.trim();
          if (!text) return;

          // لو المقطع جاء وقت البوت يتكلم وكان نفسه كلام البوت = صدى صوتنا، نتجاهله
          if (u.duringSpeech && looksLikeEcho(text, st.lastSpoken)) {
            log(`🔁 تجاهلت صدى صوتي: "${text.slice(0, 60)}"`);
            return;
          }

          log(`🗣️ سمعت «${guild.name}/${channel.name}» (${Date.now() - t0}ms): "${text}"`);

          const name =
            guild.members?.cache?.get(u.userId)?.displayName ||
            guild.members?.cache?.get(u.userId)?.user?.username ||
            'صديقي';

          // 1) هل هو أمر صوتي (شغّل / وقف الرد الصوتي)؟
          const playingNow = (() => {
            try {
              const q = music.getQueue(guild.id);
              return Boolean(q && q.current);
            } catch {
              return false;
            }
          })();
          const intent = voiceToggleIntent(text, playingNow);
          if (intent) {
            const wasOn = st.voiceOn;
            setVoiceChat(intent === 'on', `بالكلام من ${name}: «${text.slice(0, 50)}»`, guild.id);
            st.voiceChat?.setSpeaking(true);
            try {
              if (wasOn !== st.voiceOn) {
                await speakLine(
                  guild,
                  // الإيقاف: تأكيد قصير جداً (عشان ما نطوّل الكلام وهو يبي سكوت)
                  intent === 'on'
                    ? 'تم، شغلت الرد الصوتي. تفضل تكلم وأنا معك.'
                    : 'تم.',
                );
              }
            } catch (e) {
              log('⚠️ ما قدرت أأكد الأمر بالصوت:', String(e.message).slice(0, 120));
            } finally {
              st.voiceChat?.setSpeaking(false);
            }
            return;
          }

          // 2) الرد الصوتي متوقف؟ ما نرد — لكن ننفّذ أوامر الإيقاف/الخروج (عشان ما تعلق الأغنية)
          if (!st.voiceOn) {
            const t2 = normAr(text);
            const urgent =
              VOICE_SONG_COMMANDS && (matchStopCommand(t2, playingNow) || V_LEAVE_RE.test(t2));
            if (urgent) {
              const done2 = await runVoiceCommand(guild, text).catch(() => null);
              if (done2) {
                log(`🎛️ (الرد الصوتي متوقف) نفّذت أمر: "${text}"`);
                if (typeof done2.after === 'function') {
                  await done2
                    .after()
                    .catch?.((e) => log('⚠️ تنفيذ الأمر:', String(e.message).slice(0, 120)));
                }
                return;
              }
            }
            log('🔇 الرد الصوتي متوقف — تجاهلت الكلام');
            return;
          }

          // 3) أوامر الروم بالصوت — مقفلة افتراضياً: الموسيقى والأوامر تُرسل من الشات
          let vcmd = null;
          if (VOICE_SONG_COMMANDS) {
            try {
              vcmd = await runVoiceCommand(guild, text);
            } catch (e) {
              log('⚠️ خطأ في الأمر الصوتي:', String(e.message).slice(0, 140));
            }
          }
          if (vcmd) {
            log(`🎛️ أمر صوتي: "${text}"`);
            st.voiceChat?.setSpeaking(true);
            try {
              if (vcmd.say) await speakLine(guild, forSpeech(vcmd.say));
            } catch (e) {
              log('⚠️ ما قدرت أنطق التأكيد:', String(e.message).slice(0, 120));
            } finally {
              st.voiceChat?.setSpeaking(false);
            }
            if (typeof vcmd.after === 'function') {
              try {
                await vcmd.after();
              } catch (e) {
                log('⚠️ تنفيذ الأمر الصوتي:', String(e.message).slice(0, 140));
              }
            }
            return;
          }

          st.voiceChat?.setSpeaking(true);

          const reply = await chat.voiceReply({
            key: `voice:${guild.id}:${u.userId}`,
            text,
            userLabel: name,
            guildId: guild.id,
          });
          log(`💬 رد «${guild.name}» (${Date.now() - t0}ms${reply.model ? `، ${reply.model}` : ''}): "${reply.text}"`);
          lastVoice = {
            at: new Date().toISOString(),
            guildId: guild.id,
            guildName: guild.name,
            channel: channel.name,
            user: name,
            text,
            reply: reply.text,
          };

          const m = music.getQueue(guild.id);
          try {
            const dv = music.connDave(conn);
            log(
              `🎧 التشفير (DAVE): ${dv?.session?.ready ? 'جاهز' : 'غير جاهز'} (v${dv?.protocolVersion ?? '?'})`,
            );
          } catch {
            /* ignore */
          }
          // لو أحد طفّى الرد الصوتي (من الشات مثلاً) وهو جايب الرد — ما ننطقه
          if (!st.voiceOn) {
            log(`⛔ الرد الصوتي متوقف — ما نطقت الجواب «${guild.name}»`);
            return;
          }
          const stream = await speech.speak(reply.text);
          st.lastSpoken = reply.text;
          const played = await m.speak(stream, 1);
          log(`🔊 نطقنا «${guild.name}» (${Date.now() - t0}ms) — تشغيل=${played ? 'نجح' : 'ما وصل'}`);
          if (lastVoice) lastVoice.played = Boolean(played);
        } catch (e) {
          log('⚠️ فشل الرد الصوتي:', String(e.message).slice(0, 150));
        } finally {
          st.voiceChat?.setSpeaking(false);
          st.busy = false;
        }
      };

      st.voiceChat = new VoiceChat(conn, {
        onUtterance: async (u) => {
          if (st.busy) {
            // البوت مشغول — نحفظ كلامك عشان نرد عليه بعد ما نخلص (بدل ما نرميه)
            // ولو وصل مقطع ثاني بسرعة ندمجهم: كثير ينسحب كلام المتحدث والبوت يتكلم
            // (نص الجملة قبل ونصها بعد) فدمجهم يعطينا جملة مفهومة.
            const now = Date.now();
            if (
              st.pending &&
              st.pending.userId === u.userId &&
              now - st.pending.at < 4000
            ) {
              // نضيف صمت قصير بينهم عشان الكلام ما يتلاصق
              const gap = Array.from({ length: 8 }, () => Buffer.from([0xf8, 0xff, 0xfe]));
              st.pending = {
                ...st.pending,
                packets: st.pending.packets.concat(gap, u.packets),
                count: (st.pending.count || 0) + (u.count || 0),
                at: now,
              };
              log(`⏳ البوت مشغول — دمجت مقاطعك (${st.pending.packets.length} حزمة)`);
            } else {
              st.pending = { ...u, at: now };
              log('⏳ البوت مشغول — بحفظ كلامك وأرد عليه بعد ما أخلص ردي');
            }
            return;
          }
          await handleVoice(u);
          // نعالج آخر كلام وصل أثناء الرد
          let guard = 0;
          while (st.pending && guard++ < 4) {
            const next = st.pending;
            st.pending = null;
            await handleVoice(next);
          }
          st.pending = null;
        },
      });
      st.voiceChat.setEnabled(st.voiceOn);
      st.voiceChat.start();
    } catch (e) {
      log('تنبيه: تعذّر تشغيل المحادثة الصوتية:', e.message);
    }
  });

  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    log('⚠️ انقطع الاتصال الصوتي — أحاول أرجع...');
    try {
      // احتمال أنه ينقل لسيرفر صوتي جديد (إعادة اتصال طبيعية) — نعطيه فرصة قصيرة فقط
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 2500),
        entersState(conn, VoiceConnectionStatus.Connecting, 2500),
        entersState(conn, VoiceConnectionStatus.Ready, 2500),
      ]);
      log('...يعيد الاتصال حالياً.');
    } catch {
      // انقطاع حقيقي (أو طرد/نقل) -> نتخلص وندخل من جديد بسرعة
      log('↩️ ما رجع بسرعة — ندخل الروم من جديد فوراً.');
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
      st.lastJoinAt = 0;
      scheduleJoin(800, guild.id);
    }
  });

  // شبكة أمان: لو صار الاتصال Destroyed لأي سبب بدون حدث disconnect
  conn.on('stateChange', (oldS, newS) => {
    if (newS.status === VoiceConnectionStatus.Destroyed && st.autoRejoin && st.channelId) {
      log(`♻️ الاتصال انتهى (${oldS.status} → destroyed) — أعيد الدخول.`);
      st.lastJoinAt = 0;
      scheduleJoin(1200, guild.id);
    }
  });

  conn.on('error', (err) => log('خطأ صوتي:', err.message));
}

/**
 * نطق ترحيب عند دخول أول شخص للروم — يشتغل كفحص تلقائي لمسار الصوت كامل.
 */
async function greetTest(guild, who = '') {
  const t0 = Date.now();
  const st = gs(guild.id);
  try {
    const conn = getVoiceConnection(guild.id);
    // ننتظر لين تشفير E2EE يجهز (وإلا الصوت ينرسل بدون تشفير ويسكت عند المستمع)
    const daveOk = await music.waitForDaveReady(conn, 6000);
    log(`🎧 التشفير (DAVE) عند الترحيب: ${daveOk ? 'جاهز' : 'غير جاهز'}`);
    st.voiceChat?.setSpeaking(true);
    const m = music.getQueue(guild.id);
    const line = `يا هلا ${who}! أنا أسمعك وأرد عليك، تكلّم طبيعي.`;
    const ogg = await speech.speak(line);
    const played = await m.speak(ogg, 1);
    log(`👋 ترحيب صوتي (${Date.now() - t0}ms) — تشغيل=${played ? 'نجح' : 'ما وصل'}`);
  } catch (e) {
    log('⚠️ النطق فشل:', String(e.message).slice(0, 160));
    throw e;
  } finally {
    st.voiceChat?.setSpeaking(false);
  }
}

// ---------------------------------------------------------------------------
// الأحداث
// ---------------------------------------------------------------------------
client.once('ready', async () => {
  log(`تم تسجيل الدخول باسم ${client.user.tag} (ID: ${client.user.id})`);
  log(`البوت موجود في ${client.guilds.cache.size} سيرفر.`);

  // 🛡️ نتحقق من كل سيرفر: أي سيرفر مو مصرّح له نخرج منه فورًا
  for (const guild of [...client.guilds.cache.values()]) {
    const ok = await guard.verify(guild, client).catch(() => false);
    if (!ok) {
      log(`⛔ سيرفر غير مصرّح: ${guild.name} (${guild.id}) — أخرج منه.`);
      guild.leave().catch(() => {});
    }
  }

  try {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
  } catch (e) {
    log('تنبيه: مكتبة التشفير الصوتي ما تحمّلت:', e.message);
  }

  await registerCommands();

  // فحص أدوات الموسيقى (yt-dlp + ffmpeg)
  if (MUSIC_ENABLED) {
    try {
      music.diagnostics();
    } catch (e) {
      log('تنبيه: فحص أدوات الموسيقى فشل:', e.message);
    }
  }

  // جدولة آية/ذكر كل ساعة في روم القرآن 📖
  quran.start(client);
  // حديث صحيح كل ساعة 🕌
  hadith.start(client);
  // قرآن راديو ٢٤/٧ 📻
  radio.start(client);

  // فحص عملاء يوتيوب بالخلفية واختيار أول واحد شغّال
  // (يتجاوز حجب "Sign in to confirm you're not a bot")
  if (MUSIC_ENABLED) {
    music.ensureWorkingClient().catch((e) => log('تنبيه: فحص عملاء يوتيوب فشل:', e.message));
  }

  // فحص مفتاح الذكاء الاصطناعي (لو موجود)
  chat.selfTest().catch((e) => log('تنبيه: فحص المحادثة فشل:', e.message));

  // معلومات اللحظة للذكاء الاصطناعي: الروم وحالة السوالف الصوتية
  chat.setContextProvider((userLabel, guildId) => {
    const out = [];
    try {
      const g =
        (guildId && client.guilds.cache.get(guildId)) ||
        (GUILD_ID && client.guilds.cache.get(GUILD_ID)) ||
        client.guilds.cache.first();
      if (g) out.push(`- انت الآن في سيرفر «${g.name}» (لا تخلط بين السيرفرات)`);
      const ch = g?.members?.me?.voice?.channel;
      if (ch) {
        const n = Math.max(0, (ch.members?.size || 1) - 1);
        out.push(`- انت الآن في الروم الصوتي «${ch.name}» معك ${n} ${n === 1 ? 'شخص' : 'أشخاص'}`);
      } else {
        out.push('- انت مو داخل أي روم صوتي حالياً');
      }
      if (g && gs(g.id).voiceChat) {
        out.push(`- السوالف الصوتية في هذا السيرفر: ${gs(g.id).voiceOn ? 'مشغّلة (تسمع وترد بالصوت)' : 'موقفة (تشتغل بأمر صوتي)'}`);
      }
      const r = radio.status?.(guildId);
      if (r?.channelId) out.push('- البوت جالس في روم صوتي (بدون صوت)');
    } catch {
      /* تجاهل */
    }
    return out.join('\n');
  });

  if (VOICE_ENABLED) {
    // فحص محرّك النطق (يبيّن أي مزوّد يشتغل: Groq / Edge / Google)
    speech
      .speak('أنا جاهز أسمعك وأرد عليك')
      .then((ogg) => log(`✅ محرّك النطق شغّال (${ogg.length} بايت)`))
      .catch((e) => log('❌ محرّك النطق ما يشتغل:', String(e.message).slice(0, 160)));

    // فحص التفريغ (Gemini أولاً ثم Whisper) — يولّد جملة ويكشفها، يبيّن لنا وش شغّال بالسيرفر
    speech
      .selfTest()
      .then((r) => log(`🧪 فحص التفريغ: ${r?.stt?.ok ? 'شغّال' : 'مشكلة — ' + (r?.stt?.error || 'غير معروف')}`))
      .catch((e) => log('⚠️ فحص التفريغ فشل:', String(e.message).slice(0, 140)));

    // تسخين جُمل التأكيد المتكررة بنفس الصوت — تصير فورية وما تتأثر بأي تقييد لاحق
    speech
      .warmTtsCache()
      .catch((e) => log('⚠️ تسخين النطق فشل:', String(e.message).slice(0, 140)));
  } else {
    log('🎙️ الصوت ملغي — البوت إداري فقط (لا موسيقى ولا كلام).');
  }

  // ندخل الروم الصوتي في كل سيرفر (المحدد بالإعدادات أو أول روم صوتي متاح)
  const AUTO_JOIN_ALL =
    VOICE_ENABLED && String(process.env.AUTO_JOIN_ALL || 'true').toLowerCase() !== 'false';
  if (AUTO_JOIN_ALL || (VOICE_ENABLED && configuredChannelIds().length)) {
    await ensureConnected();
  } else {
    log('ما فيه روم محدد بالإعدادات ودخول باقي السيرفرات متوقف.');
  }

  // رتبة البوت في كل سيرفر 🎖️
  for (const guild of client.guilds.cache.values()) {
    ensureBotRole(guild).catch(() => {});
  }
});

client.on('guildCreate', async (guild) => {
  // 🛡️ ما يشتغل إلا في سيرفرات المالك — أي سيرفر ثاني يخرج منه على طول
  const ok = await guard.verify(guild, client).catch(() => false);
  if (!ok) {
    log(`⛔ انضممت لسيرفر غير مصرّح: ${guild.name} (${guild.id}) — أخرج.`);
    guild.leave().catch(() => {});
    return;
  }
  log(`انضممت لسيرفر جديد: ${guild.name}`);
  ensureBotRole(guild).catch(() => {});
  // نسجّل الأوامر في السيرفر الجديد فوراً، وندخل روم صوتي لو الدخول التلقائي مفعّل
  registerCommands().catch(() => {});
  if (
    VOICE_ENABLED &&
    String(process.env.AUTO_JOIN_ALL || 'true').toLowerCase() !== 'false'
  ) {
    setTimeout(() => ensureConnected(guild.id).catch(() => {}), 4000);
  }
});

// الترحيب بالأعضاء الجدد 👋
const WELCOME_CHANNEL_ID = (process.env.WELCOME_CHANNEL_ID || '').trim();
// الترحيب التلقائي معطّل افتراضياً — يُرسل فقط بأمر /welcome
const WELCOME_ON_JOIN = String(process.env.WELCOME_ON_JOIN || 'false').toLowerCase() === 'true';
const WELCOME_CHANNEL_NAME = (
  process.env.WELCOME_CHANNEL_NAME || '👋｜الترحيب'
).trim();
const RULES_CHANNEL_ID = (process.env.RULES_CHANNEL_ID || '').trim();

function findWelcomeChannel(guild) {
  if (!guild) return null;
  if (WELCOME_CHANNEL_ID) {
    const byId = guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (byId && byId.isTextBased?.()) return byId;
  }
  return (
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && c.name === WELCOME_CHANNEL_NAME,
    ) ||
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && String(c.name).includes('الترحيب'),
    ) ||
    null
  );
}

function findRulesChannel(guild) {
  if (!guild) return null;
  if (RULES_CHANNEL_ID) {
    const byId = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (byId && byId.isTextBased?.()) return byId;
  }
  return (
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && String(c.name).includes('القوانين'),
    ) || null
  );
}

async function sendWelcome(member) {
  const channel = findWelcomeChannel(member.guild);
  if (!channel) return;
  const rules = findRulesChannel(member.guild);
  const created = Math.floor(member.user.createdTimestamp / 1000);
  const joined = Math.floor(Date.now() / 1000);
  const total = member.guild.memberCount;

  await channel.send({
    content: `<@${member.id}>`,
    allowedMentions: { users: [member.id] },
    embeds: [
      {
        title: `👋 أهلاً ${member.displayName || member.user.username}`,
        description:
          'نوّرت السيرفر! 🎉\n\n' +
          '**خطوتك الأولى:** تطلع لك أسئلة الترحيب — جاوب عليها ' +
          '(ولد/بنت، العمر، ألعابك) وبتنفتح لك الرومات والفويسات اللي تبيها.\n\n' +
          '🆘 تحتاج مساعدة؟ ادخل روم **🔊｜الانتظار** وتكلم مع الإدارة، ' +
          'أو اكتب مشكلتك في **🛠️｜الدعم-الفني** أو **📩｜الشكاوى**.\n\n' +
          (rules ? `📜 اقرأ القوانين أول شي: <#${rules.id}>` : '📜 اقرأ القوانين أول شي.'),
        color: 0xf1c40f,
        thumbnail: member.user.displayAvatarURL?.({ size: 256 })
          ? { url: member.user.displayAvatarURL({ size: 256 }) }
          : undefined,
        fields: [
          {
            name: '👥 الأعضاء',
            value: `أنت العضو رقم **${total}**`,
            inline: true,
          },
          {
            name: '🎮 الرومات',
            value: 'اختر ألعابك وبتظهر لك تلقائياً',
            inline: true,
          },
        ],
        footer: { text: 'استمتع — وأي مشكلة كلّم الإدارة' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

// إعطاء العضو الجديد رتبة "عضو" تلقائياً 👤
client.on('guildMemberAdd', async (member) => {
  if (!member.guild || member.user.bot) return;
  if (!guard.isAllowed(member.guild.id)) return;
  const role =
    (MEMBER_ROLE_ID && member.guild.roles.cache.get(MEMBER_ROLE_ID)) ||
    member.guild.roles.cache.find(
      (r) => !r.managed && r.name === MEMBER_ROLE_NAME,
    );
  if (!role) {
    log(`⚠️ رتبة العضو (${MEMBER_ROLE_NAME}) غير موجودة في ${member.guild.name}`);
  } else {
    try {
      await member.roles.add(role, 'رتبة العضو الافتراضية');
      log(`👤 أعطيت ${member.user.username} رتبة ${role.name}`);
    } catch (e) {
      log(`⚠️ تعذر إعطاء رتبة العضو لـ ${member.user.username}: ${e.message}`);
    }
  }

  try {
    if (WELCOME_ON_JOIN) await sendWelcome(member);
    log(`👋 رحّبت بـ ${member.user.username} في ${member.guild.name}`);
  } catch (e) {
    log(`⚠️ تعذر إرسال الترحيب لـ ${member.user.username}: ${e.message}`);
  }
});

// روم الانتظار: كتم تلقائي لين يجي إداري وينقله للدعم 🆘
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild || !newState.member || newState.member.user.bot) return;
  if (!guard.isAllowed(newState.guild.id)) return;
  if (!WAITING_CHANNEL_ID) return;

  const member = newState.member;
  const joined =
    newState.channelId === WAITING_CHANNEL_ID && oldState.channelId !== WAITING_CHANNEL_ID;
  const left =
    oldState.channelId === WAITING_CHANNEL_ID && newState.channelId !== WAITING_CHANNEL_ID;

  if (joined) {
    const isStaff = member.permissions?.has(PermissionFlagsBits.ManageGuild);
    if (isStaff) return;
    try {
      await member.voice.setMute(true, 'انتظار الدعم الفني');
      waitingMuted.add(member.id);
      log(`🎙️ كتمت ${member.user.username} في روم الانتظار`);
    } catch (e) {
      log('⚠️ تعذر كتم عضو الانتظار:', e.message);
    }
    try {
      const ch = await client.channels.fetch(SUPPORT_TEXT_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased?.()) {
        await ch.send({
          content:
            `🆘 <@${member.id}> في روم الانتظار ويحتاج مساعدة.\n` +
            (STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}>` : ''),
          allowedMentions: { users: [member.id], roles: STAFF_ROLE_ID ? [STAFF_ROLE_ID] : [] },
        });
      }
    } catch (e) {
      log('⚠️ تعذر إرسال تنبيه الدعم:', e.message);
    }
    return;
  }

  if (left && waitingMuted.has(member.id)) {
    waitingMuted.delete(member.id);
    try {
      await member.voice.setMute(false, 'انتقل من روم الانتظار');
      log(`🔊 فككت كتم ${member.user.username} بعد الانتقال`);
    } catch (e) {
      log('⚠️ تعذر فك كتم العضو:', e.message);
    }
  }
});

client.on('guildMemberRemove', (member) => {
  waitingMuted.delete(member.id);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!VOICE_ENABLED) return;
  if (!client.user || newState.id !== client.user.id) return;
  const vState = gs(newState.guild?.id);
  if (!vState.autoRejoin) return;

  // أحد صمّم/كتم البوت على السيرفر -> نحاول نلغيها فوراً (تحتاج صلاحية Deafen Members)
  if (newState.deaf || newState.mute) {
    log(
      `⚠️ البوت ${newState.deaf ? 'مصمّم (Deafened)' : 'مكتوم (Muted)'} على السيرفر — أحاول ألغيها تلقائياً.`,
    );
    if (newState.deaf) newState.setDeaf(false, 'إصلاح تلقائي').catch(() => {});
    if (newState.mute) newState.setMute(false, 'إصلاح تلقائي').catch(() => {});
  }

  // ترحيب/فحص صوتي عند دخول أول شخص للروم (يفيد كاختبار تلقائي للنطق)
  try {
    const humanJoined =
      newState.channelId &&
      oldState.channelId !== newState.channelId &&
      !newState.member?.user?.bot;
    const botChannelId = newState.guild?.members?.me?.voice?.channelId ?? null;
    const onlyBot =
      newState.channel && [...newState.channel.members.values()].every((mm) => mm.user?.bot);
    if (GREET_ON_JOIN && vState.voiceOn && humanJoined && botChannelId === newState.channelId && onlyBot) {
      setTimeout(() => {
        greetTest(newState.guild, newState.member?.displayName || 'يا هلا').catch((e) =>
          log('⚠️ فشل الترحيب الصوتي:', String(e.message).slice(0, 140)),
        );
      }, 2500);
    }
  } catch {
    /* ignore */
  }

  // طلع من الروم (انفصل / طردوه)
  if (oldState.channelId && !newState.channelId) {
    log('⚠️ طلعت من الروم الصوتي — أحاول أرجع.');
    vState.lastJoinAt = 0; // نسمح بإعادة الدخول فوراً
    scheduleJoin(3000, newState.guild?.id);
    return;
  }

  // نقله أحد لروم ثاني
  if (
    oldState.channelId &&
    newState.channelId &&
    oldState.channelId !== newState.channelId
  ) {
    log(`نقلوني إلى روم ثاني: ${newState.channel?.name ?? newState.channelId}`);
    if (LOCK_TO_CHANNEL) {
      vState.lastJoinAt = 0; // نسمح بإعادة الدخول فوراً
      scheduleJoin(3000, newState.guild?.id);
    }
  }
});

// ---------------------------------------------------------------------------
// تنفيذ كلام المستخدم فعلياً (موسيقى) من الشات
// ---------------------------------------------------------------------------
const PLAY_INTENT =
  /^\s*(?:يا\s*)?(?:شغل لي|شغّل لي|شغللي|شغّللي|شغل|شغّل|حط لي|حطلي|سمعني|سمّعني|ابغى اسمع|أبغى اسمع|ابي اسمع|أبي اسمع|play me|play)\s*[:،\-]?\s*(.+)$/i;
// صيغ إضافية للكتابة: «ابي أغنية X»، «ودي اسمع X»
const PLAY_INTENT2 =
  /^\s*(?:يا\s*)?(?:ابغى|ابغي|ابي|أبي|ودي|نفسي)\s+(?:اسمع|اغنيه|أغنيه|اغنية|أغنية|موسيقي|موسيقى|طرب)\s*[:،\-]?\s*(.+)$/i;
const STOP_INTENT = /^\s*(?:وقف|أوقف|اوقف|اقفل|سكّر|سكر|اسكت|خلص|stop)\s*[!.؟]*$/i;
const SKIP_INTENT = /^\s*(?:تخطى|تخطي|سكب|التالي|اللي بعدها|skip|next)\s*[!.؟]*$/i;
// طلب عام بدون اسم أغنية («شغل لي» / «شغل الأغنية») — ما نشغّل شي عشوائي
const GENERIC_SONG_Q =
  /^(?:ال)?(?:لي|اغنيه|أغنيه|اغنية|أغنية|موسيقي|موسيقى|شي|شيء|شي زين|اي شي|أي شي|اي شيء|طرب|شغله|شغلة)$/;

/** يجيب الروم الصوتي: الروم اللي البوت قاعد فيه (ثابت 24/7) أو روم المستخدم أو المخصص للسيرفر */
async function resolveVoiceChannel(message) {
  const guild = message.guild;
  if (!guild) return null;
  // الأولوية للروم اللي البوت قاعد فيه أصلاً — عشان ما ننقله من مكانه بالغلط
  const current = botChannelOf(guild);
  if (current) return current;
  const own = message.member?.voice?.channel;
  if (own) return own;
  try {
    return await targetChannelFor(guild.id);
  } catch {
    return null;
  }
}

/**
 * لو الرسالة أمر موسيقى ("شغل لي ...") ينفّذه ويرجّع نص الرد.
 * يرجّع null لو ما كان أمر موسيقى.
 */
async function runMusicFromChat(message, text) {
  const guild = message.guild;
  if (!guild) return null;

  const t = normAr(text); // نسخة منظّفة للمطابقة (بدون همزات/رموز/تشكيل)
  const m0 = music.hasQueue(guild.id) ? music.getQueue(guild.id) : null;
  const isPlaying = Boolean(m0 && m0.current);

  // إيقاف («طفها»، «وقف الأغنية»، «سكرها» …)
  if (STOP_INTENT.test(text) || STOP_INTENT.test(t) || matchStopCommand(t, isPlaying)) {
    if (!isPlaying && !(m0 && m0.songs.length)) return 'ما فيه شي شغّال أصلاً 🤷';
    m0?.stopAll();
    return '⏹️ وقفت الموسيقى وفضّيت الطابور.';
  }

  // التالي («تخطى»، «غير الأغنية» …)
  if (SKIP_INTENT.test(text) || SKIP_INTENT.test(t) || V_SKIP_RE.test(t)) {
    if (!isPlaying) return 'ما فيه شي شغّال 🤷';
    m0.skip();
    return '⏭️ تخطيت الأغنية.';
  }

  if (isPlaying && V_PAUSE_RE.test(t)) {
    m0.player?.pause();
    return '⏸️ وقفتها مؤقتاً — اكتب «كمل» وأرجّعها.';
  }
  if (isPlaying && V_RESUME_RE.test(t)) {
    m0.player?.unpause();
    return '▶️ كمّلت الأغنية.';
  }

  if (V_LOOP_OFF_RE.test(t)) {
    m0?.toggleLoop(false);
    return '⏹️ وقفت التكرار.';
  }
  if (V_LOOP_RE.test(t)) {
    m0?.toggleLoop(true);
    return '🔁 شغّلت التكرار — بيعيد الأغنية نفسها لما تخلص.';
  }

  if (isPlaying && (V_VOL_UP_RE.test(t) || V_VOL_DOWN_RE.test(t))) {
    const up = V_VOL_UP_RE.test(t);
    const v = Math.min(1, Math.max(0.05, (m0.volume ?? 0.7) + (up ? 0.15 : -0.15)));
    m0.setVolume(v);
    return `🔊 الصوت الآن ${Math.round(v * 100)}%.`;
  }

  if (isPlaying && V_NOW_RE.test(t)) {
    return `🎧 شغّال الآن: **${m0.current.title}**${
      m0.songs.length ? `\n📜 وبالطابور: ${m0.songs.length}` : ''
    }`;
  }

  const play = text.match(PLAY_INTENT) || t.match(PLAY_INTENT) || text.match(PLAY_INTENT2);
  if (!play) return null;
  const query = cleanSongQuery((play[1] || '').replace(/^لي\s+/, '').trim());
  if (!query || GENERIC_SONG_Q.test(normAr(query))) {
    return '🎵 اكتب اسم الأغنية بعد الأمر — مثل: `شغل لي محمد عبده`';
  }

  const channel = await resolveVoiceChannel(message);
  if (!channel) return '⚠️ ما لقيت روم صوتي — اكتب `/join` أول.';

  await message.channel.sendTyping?.().catch(() => {});

  const { music: m } = music.getOrCreateConnection(guild, channel);
  m.setTextChannel(message.channel);

  const wasIdle = !m.current;

  let resolved;
  try {
    resolved = await music.resolveQuery(query);
  } catch (e) {
    log(`ما لقيت "${query}": ${e.message}`);
    if (e.closest) {
      return `❓ ما لقيت مطابقة واضحة لـ \`${query}\`.\nأقرب شي: **${e.closest}** — تبي أشغّلها؟ اكتب \`/play ${e.closest.replace(/[`\n]/g, ' ').slice(0, 80)}\``;
    }
    return `❌ ما لقيت \`${query}\` — جرّب تكتب اسمها بشكل أوضح.`;
  }

  m.songs.push(...resolved.songs);

  if (!wasIdle) {
    return `➕ ضفتها للطابور (#${m.songs.length}): **${resolved.songs[0].title}**`;
  }

  const started = await m.startAndWait(60000);
  const weakNote = resolved.weak ? '\n⚠️ مو متأكد إنها هي — لو مو هي اكتب نفس الطلب مع اسم أوضح.' : '';
  return started
    ? `▶️ شغّالة الآن: **${resolved.songs[0].title}** 🎧${weakNote}`
    : '❌ ما قدرت أشغّلها — جرّب تكتب اسمها بطريقة ثانية.';
}

// ---------------------------------------------------------------------------
// رتبة البوت في السيرفر 🎖️
// ---------------------------------------------------------------------------
const BOT_ROLE_NAME = (process.env.BOT_ROLE_NAME || '🤖｜البوت').trim();
const BOT_ROLE_COLOR = (process.env.BOT_ROLE_COLOR || '#95A5A6').trim();

// الصلاحيات في رابط الدعوة (تشمل "إدارة الرتب" عشان يقدر يضبط رتبته)
const INVITE_PERMS = 271961120;
const botRolePending = new Set(); // سيرفرات باقي ما ضبطنا رتبتها

function inviteUrl() {
  if (!client.user) return '';
  return (
    `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}` +
    `&permissions=${INVITE_PERMS}&scope=bot%20applications.commands`
  );
}

async function ensureBotRole(guild) {
  if (!BOT_ROLE_NAME) return null;
  try {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) return null;

    let role = guild.roles.cache.find((r) => r.name === BOT_ROLE_NAME && !r.managed);
    if (!role) {
      role = await guild.roles.create({
        name: BOT_ROLE_NAME,
        colors: { primaryColor: BOT_ROLE_COLOR },
        hoist: true,
        mentionable: false,
        reason: 'رتبة البوت الرسمية',
      });
      log(`✅ أنشأت رتبة للبوت: ${BOT_ROLE_NAME}`);
    }

    if (!me.roles.cache.has(role.id)) {
      await me.roles.add(role, 'رتبة البوت');
      log(`🎖️ أعطيت البوت الرتبة: ${BOT_ROLE_NAME}`);
    }

    botRolePending.delete(guild.id);
    return role;
  } catch (e) {
    if (!botRolePending.has(guild.id)) {
      botRolePending.add(guild.id);
      log(
        `⚠️ ما قدرت أضبط رتبة البوت (${BOT_ROLE_NAME}): ${e.message}\n` +
          '   ديسكورد يمنع البوت يرفع نفسه — سوِّ هالخطوتين وبعدها يصير تلقائي:\n' +
          '   1) افتح هذا الرابط ووافق (يعطي البوت صلاحية إدارة الرتب):\n' +
          `      ${inviteUrl()}\n` +
          `   2) إعدادات السيرفر → الرتب → اسحب رتبة البوت فوق باقي الرتب.`,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// أوامر الرد الصوتي (تشغيل/إيقاف) — تنفهم بالكلام أو بالكتابة أو بأمر /voice
// ---------------------------------------------------------------------------
/** تنظيف عربي: نشيل التشكيل ونوحّد الحروف عشان نقارن بثقة */
function normAr(s) {
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

// عبارات إيقاف الرد الصوتي
const VOICE_OFF_PHRASES = [
  'وقف الرد الصوتي',
  'اوقف الرد الصوتي',
  'اطفي الرد الصوتي',
  'طفي الرد الصوتي',
  'اقفل الرد الصوتي',
  'قفل الرد الصوتي',
  'وقف المحادثه الصوتيه',
  'اوقف المحادثه الصوتيه',
  'اقفل المحادثه الصوتيه',
  'قفل المحادثه الصوتيه',
  'اوقف المحادثه',
  'وقف المحادثه',
  'وقف الرد',
  'اوقف الرد',
  'وقف الصوت',
  'اقفل الصوت',
  'لا ترد علي',
  'خلك ساكت',
  // صيغ السكوت الدارجة («اسكت»، «سكوت»، «انطم» …)
  'اسكت',
  'اسكت انت',
  'انت اسكت',
  'بس اسكت',
  'خلاص اسكت',
  'اسكت شوي',
  'سكوت',
  'انطم',
  'لا تتكلم',
  'لا تكلم',
  'لا تسولف',
  'لا تهرج',
  // أوامر مركّبة (وقف/اقفل + الكلام أو السوالف)
  'وقف الكلام',
  'وقف السوالف',
  'وقف السواليف',
  'سكر السوالف',
  'سكر السواليف',
  'اقفل السوالف',
  'طفي السوالف',
  'عطل السوالف',
];

// صيغة عامة: فعل إيقاف + (الرد/الكلام/السوالف/المحادثة/الصوت)
const VOICE_OFF_RE =
  /(?:وقف|اوقف|اطفي|طفي|اقفل|قفل|سكر|اسكر|بطل|الغ|الغي|عطل|كتم|اكتم)\s+(?:ال)?(?:رد|ردك|ردودك|الكلام|كلامك|سوالف|السوالف|سواليف|السواليف|المحادثه|محادثتك|الصوت|صوتك|نفسك|فمك|هرجك)/;

// عبارات تشغيل الرد الصوتي
const VOICE_ON_PHRASES = [
  'شغل الرد الصوتي',
  'فعل الرد الصوتي',
  'افتح الرد الصوتي',
  'رجع الرد الصوتي',
  'شغل المحادثه الصوتيه',
  'فعل المحادثه الصوتيه',
  'افتح المحادثه الصوتيه',
  'كلمني',
  'تكلم معي',
  'رد علي',
  'عطني كلمه',
  'قول شي',
];

// صيغة عامة للتشغيل: فعل تشغيل + (الرد/الكلام/السوالف/المحادثة)
// ملاحظة: «الصوت» مستثناة عمداً — «شغل الصوت» تنقال كثير في الألعاب وما نقصدها
const VOICE_ON_RE =
  /(?:شغل|فعل|افتح|رجع|تشغل)\s+(?:ال)?(?:رد|ردك|ردودك|الكلام|كلامك|سوالف|السوالف|سواليف|السواليف|المحادثه|محادثتك)/;

/**
 * يفحص إذا النص أمر تشغيل/إيقاف للرد الصوتي.
 * @param {string} raw
 * @param {boolean} playing فيه موسيقى شغالة الحين؟ (عشان «وقف الصوت» تعني وقف الأغنية)
 * @returns {'on'|'off'|null}
 */
function voiceToggleIntent(raw, playing = false) {
  const t = normAr(raw);
  if (!t || t.length > 60) return null;
  // «وقف الصوت / اقفل الصوت / وقف» وأمثالها: لو فيه أغنية شغالة يقصد يوقفها
  // (بس هذا فقط لما تكون أوامر الصوت مفعّلة — الحين الأوامر من الشات)
  if (
    VOICE_SONG_COMMANDS &&
    playing &&
    /^(?:وقف|اوقف|وقفها|اقفل|قفل|طفي|اطفي|سكر|اسكر)\s*(?:ال)?(?:صوت|صوتك)?(?: الحين)?$/.test(t)
  ) {
    return null;
  }
  // نسوّي حدود للكلمات عشان «اسكت» ما تطابق «اسكتت» مثلاً
  const pad = ` ${t} `;
  const hasPhrase = (list) => list.some((p) => pad.includes(` ${p} `));
  // نفحص الإيقاف أول (لأن "لا ترد علي" تحتوي "رد علي")
  if (hasPhrase(VOICE_OFF_PHRASES) || VOICE_OFF_RE.test(t)) return 'off';
  if (hasPhrase(VOICE_ON_PHRASES) || VOICE_ON_RE.test(t)) return 'on';
  return null;
}

/**
 * يشغّل/يوقف الرد الصوتي.
 * @param {boolean} on
 * @param {string} by مين أمر
 * @param {string} guildId سيرفر محدد (وإلا يطبّق على كل السيرفرات)
 */
function setVoiceChat(on, by = '', guildId = '') {
  if (!VOICE_ENABLED) return false;
  const ids = guildId ? [String(guildId)] : [...guildState.keys()];
  for (const id of ids) {
    const s = gs(id);
    s.voiceOn = Boolean(on);
    if (!s.voiceChat) continue;
    try {
      s.voiceChat.setEnabled(s.voiceOn);
    } catch {
      /* ignore */
    }
    // لو طفّى الرد الصوتي وهو يتكلم الحين — نسكّته فوراً
    if (!s.voiceOn) {
      try {
        const m = music.hasQueue(id) ? music.getQueue(id) : null;
        if (m && m._voiceReplyActive) m.player.stop(true);
      } catch {
        /* ignore */
      }
      s.pending = null;
    }
  }
  const where = guildId ? `«${client.guilds.cache.get(String(guildId))?.name ?? guildId}»` : 'كل السيرفرات';
  log(`🎚️ الرد الصوتي ${where}: ${on ? 'شغّال ✅' : 'متوقف ⛔'}${by ? ` — ${by}` : ''}`);
  voiceToggleHistory.push({
    at: new Date().toISOString(),
    guildId: guildId ? String(guildId) : null,
    on: Boolean(on),
    by: String(by || '').slice(0, 80),
  });
  if (voiceToggleHistory.length > 12) voiceToggleHistory.shift();
  return Boolean(on);
}

/** ينطق جملة قصيرة (تأكيد أمر صوتي) */
async function speakLine(guild, line) {
  gs(guild.id).lastSpoken = line;
  const m = music.getQueue(guild.id);
  const ogg = await speech.speak(line);
  return m.speak(ogg, 1);
}

/** هل النص يبدو صدى لكلام البوت نفسه؟ (نمنع البوت يرد على صوته) */
function looksLikeEcho(text, botText) {
  const a = normAr(text);
  const b = normAr(botText);
  if (!a || !b) return false;
  if (a.length >= 6 && b.includes(a)) return true;
  if (b.length >= 6 && a.includes(b)) return true;
  const wa = new Set(a.split(' ').filter((w) => w.length > 2));
  const wb = b.split(' ').filter((w) => w.length > 2);
  if (!wa.size || !wb.length) return false;
  const hit = wb.filter((w) => wa.has(w)).length;
  return hit / wb.length >= 0.6;
}

// ---------------------------------------------------------------------------
// تنفيذ الأوامر بالصوت: شغّل أغنية / اطلع / وقف / التالي / ارفع الصوت ...
// ---------------------------------------------------------------------------
/** يشيل التنسيق والرموز عشان النطق يكون نظيف */
function forSpeech(s) {
  return String(s || '')
    .replace(/[*_`#~|]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
    // نحافظ على الحروف والتشكيل العربي (التشكيل من نوع Mark مو Letter)
    .replace(/[^\p{L}\p{N}\p{M}\s،.؟!]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// أوامر الروم
const V_LEAVE_RE =
  /^(?:اطلع|اطلع من الروم|اطلع برا|اطلع من هنا|اطلع بري|اخرج|اخرج من الروم|طلعني|طلعني من الروم|اقفل الروم|قفل الروم|انزل من الروم|لا تقعد في الروم)$/;
const V_JOIN_RE = /^(?:ادخل|ادخل الروم|دخل الروم|ارجع|ارجع للروم|رجعني|تعال الروم|تعال للروم)$/;
const V_NOW_RE =
  /^(?:(?:وش|ايش)\s+(?:تشغل|شغال|الاغنيه|الاغاني|الطابور)(?:\s+الحين)?|وش اللي شغال|وش هذي الاغنيه|وش اللي تشغله)$/;
// إيقاف الموسيقى (صيغ واضحة تماماً)
const V_STOP_RE =
  /^(?:وقف|اوقف|وقفها|ايقاف|اوقفها|وقف الموسيقي|وقف الاغنيه|وقف الاغاني|طفي الموسيقي|اطفي الموسيقي|اقفل الموسيقي|قفل الموسيقي|سكر الموسيقي|سكرها)$/;
// كلمات قصيرة تعني "سكّت الصوت" — نقبلها فقط إذا فيه موسيقى شغالة
const V_STOP_WEAK_RE = /^(?:بس|خلاص|خلص|اسكت|سكت|تكفي)$/;

// أفعال الإيقاف بكل الصيغ اللي يكتبها Whisper («طفّه» -> طفه/طفاها/اطفيها...)
const STOP_VERBS = [
  'وقف', 'اوقف', 'وقفه', 'وقفها', 'وقفوا', 'وقفي', 'اوقفها', 'اوقفه', 'اوقفي',
  'طفي', 'اطفي', 'طفه', 'اطفه', 'طفها', 'اطفها', 'طفاها', 'اطفاها', 'طفيها', 'اطفيها', 'اطفيه',
  'بطفيها', 'بطفي', 'طفوها', 'طقها', 'اطقها',
  'قفل', 'اقفل', 'قفله', 'اقفله', 'قفلها', 'اقفلها', 'اقفلي',
  'سكر', 'اسكر', 'سكره', 'سكرها', 'اسكرها',
  'كتم', 'اكتم', 'كتمها', 'اكتمها',
  'بطل', 'ابطل', 'بطلها', 'ابطله', 'بطلي',
];
const STOP_OBJECTS = [
  'الاغنيه', 'اغنيه', 'الاغاني', 'اغاني', 'اغنيتك', 'اغنيتي', 'الموسيقي', 'موسيقي', 'موسيقاك',
  'الصوت', 'صوت', 'صوتك', 'الشغله', 'شغله', 'الطرب', 'طرب', 'ذا', 'ذي', 'هذي', 'هذا', 'هالاغنيه',
];
const STOP_FILL = [
  'يا', 'طيب', 'الحين', 'يعني', 'والله', 'لا', 'اقول', 'اقولك', 'قول', 'ولد', 'ياب', 'بط', 'بوت',
  'قوم', 'شوي', 'اذا', 'سمعت', 'قلت', 'لك', 'ممكن', 'لو', 'سمحت', 'هو', 'انت', 'انتي', 'كذا',
];
const STOP_VERB_SET = new Set(STOP_VERBS);
const STOP_OBJ_SET = new Set(STOP_OBJECTS);
const STOP_FILL_SET = new Set(STOP_FILL);
// صيغ قريبة من أفعال الإيقاف (لو الاسم انكتب غلط)
const STOP_STEM_RE =
  /^(?:ا?طف(?:ي|ه|ها|يها|يه|او|و|وا)?|ا?طق(?:ي|ه|ها)?|ا?وقف(?:ي|ه|ها|و|وا)?|ا?قفل(?:ي|ه|ها)?|ا?سكر(?:ي|ه|ها)?|ا?كتم(?:ي|ه|ها)?|ا?بطل(?:ي|ه|ها)?)$/;

/**
 * هل الجملة أمر إيقاف للموسيقى؟ نقبل الصيغ القريبة: «طفّه»، «طفاها»، «قفلها خلاص»، «طفيها يا بوت».
 */
function matchStopCommand(raw, playing = false) {
  const t = normAr(raw);
  if (!t) return false;
  if (V_STOP_RE.test(t)) return true;
  if (playing && V_STOP_WEAK_RE.test(t)) return true;

  const words = t.split(' ').filter(Boolean);
  if (words.length > 8) return false;

  const allowed = (w) =>
    STOP_VERB_SET.has(w) ||
    STOP_OBJ_SET.has(w) ||
    STOP_FILL_SET.has(w) ||
    V_STOP_WEAK_RE.test(w) ||
    w.length <= 2;

  if (words.some((w) => STOP_VERB_SET.has(w) || STOP_STEM_RE.test(w))) {
    // كل الكلمات لازم تكون إيقاف/مفعول/حشو — عشان ما نوقف على كلام عادي فيه "وقف"
    if (words.every((w) => allowed(w) || STOP_STEM_RE.test(w))) return true;
  }

  // جملة قصيرة أثناء التشغيل + صيغة قريبة = أمر إيقاف
  if (playing && words.length <= 3 && words.every((w) => allowed(w) || STOP_STEM_RE.test(w))) {
    return true;
  }
  return false;
}
const V_SKIP_RE =
  /^(?:تخطي|تخطى|سكب|التالي|التاليه|اللي بعدها|غير الاغنيه|غير الموسيقي|بدلها|روح للي بعدها|skip|next)$/;
// «لا مو هذي» = الأغنية اللي شغّلها غلط -> نشغّل أفضل بديل من نفس البحث
const V_WRONG_RE =
  /^(?:لا مو هذي|لا مو هاذي|مو هذي|مو هاذي|مو ذي|مو هي|مو هذاك|مو هذي الاغنيه|لا لا مو هذي|غلط|خطا|مو غلط|هذي مو هي|هذي غلط|جيب غيرها|غيرها|ابي غيرها|ابغى غيرها|شي ثاني|جيب شي ثاني|مو هالاغنيه)$/;
const V_PAUSE_RE =
  /^(?:وقفها شوي|وقف شوي|وقفها مؤقت|وقف مؤقت|ايقاف مؤقت|وقف الموسيقي شوي|اسكت شوي|بريح|بريك|pause)$/;
const V_RESUME_RE =
  /^(?:كمل|كملها|اكمل|اكملها|كمل الاغنيه|واصل|شغلها مره ثانيه|شغل الموسيقي|رجع الاغنيه|resume|continue)$/;
const V_LOOP_RE = /^(?:كرر|كررها|اعد|اعيد|كرر الاغنيه|loop)$/;
const V_LOOP_OFF_RE = /^(?:الغي التكرار|وقف التكرار|لا تكرر|loop off)$/;
const V_VOL_UP_RE = /^(?:ارفع الصوت|علي الصوت|زود الصوت|ارفع شوي|صوتك واطي|ارفع صوتك|ارفع صوت)$/;
const V_VOL_DOWN_RE = /^(?:نزل الصوت|وطي الصوت|خفض الصوت|قلل الصوت|نزل شوي|وطي شوي|نزل صوتك)$/;
const V_GENERIC_SONG_RE = /^(?:لي|اغنيه|موسيقي|شي|شيء|اي شي|اغاني|شي زين)$/;
// طلب تشغيل أغنية بالصوت (يسمح بكلمة تمهيدية مثل "طيب" أو "يا")
const V_PLAY_RE =
  /^(?:(?:طيب|يا|هلا|يالله|يلا|لو سمحت|ممكن|الحين|هي|والله)\s+)*(?:شغّل لي|شغل لي|شغللي|شغلي|شغّللي|سمّعني|سمعني|ابغي اسمع|أبغي اسمع|ابي اسمع|أبي اسمع|شغل اغنية|شغّل أغنية|شغل اغنيه|شغّل|شغل|play me|play)\s*[:،\-]?\s*(.+)$/i;

/** ينظّف كلام الطلب من الحشو عشان البحث يلقى الأغنية */
function cleanSongQuery(raw) {
  let q = String(raw || '')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .trim();
  // ترقيم وعلامات أطراف
  q = q.replace(/^[\s"'«»\-–—.،,:!؟?]+/, '').replace(/[\s"'«»\-–—.،,:!؟?]+$/, '');
  // كلمات تمهيدية
  q = q.replace(/^(?:يا|طيب|هلا|يالله|يلا|لو سمحت|ممكن|الحين|هي|والله|بعد|كمان|ايضا|أيضا)\s+/u, '');
  // «أغنية اسمها X» / «اسمها X» / «أغنية X»
  q = q.replace(
    /^(?:ال)?(?:أغنية|اغنية|أغنيه|اغنيه|أغني|اغني|أغاني|اغاني|موسيقى|موسيقي|شغله|شغلة|طرب)\s+(?:اسمها|اسمه|باسم|اسم)\s+/u,
    '',
  );
  q = q.replace(/^(?:اسمها|اسمه|باسم|اسم)\s+/u, '');
  q = q.replace(/^(?:ال)?(?:أغنية|اغنية|أغنيه|اغنيه|أغني|اغني|أغاني|اغاني|موسيقى|موسيقي)\s+/u, '');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

/** روم البوت الصوتي الحالي */
function botVoiceChannel(guild) {
  const byId = VOICE_CHANNEL_ID ? guild.channels.cache.get(VOICE_CHANNEL_ID) : null;
  return byId || guild.members?.me?.voice?.channel || null;
}

// آخر نتائج بحث (بالأمر الصوتي) — عشان المستخدم يقدر يقول «لا مو هذي» ونشغّل البديل
const lastSearch = new Map(); // guildId -> { query, ranked, index }

// كتابة عربية لحروف لاتينية — لأن Whisper يكتب الأسماء الأجنبية بالعربي
// ("لاف اون ذي كاتووك") فنرتّبها لاتيني عشان نلقى الأغنية الأصلية
const AR2LAT = {
  ا: 'a', أ: 'a', إ: 'a', آ: 'a', ٱ: 'a', ب: 'b', ت: 't', ث: 'th', ج: 'j', ح: 'h', خ: 'kh',
  د: 'd', ذ: 'dh', ر: 'r', ز: 'z', س: 's', ش: 'sh', ص: 's', ض: 'd', ط: 't', ظ: 'dh', ع: 'a',
  غ: 'gh', ف: 'f', ق: 'q', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: 'a', و: 'w', ي: 'y',
  ى: 'a', ء: '', ؤ: 'w', ئ: 'y', پ: 'p', چ: 'ch', ڤ: 'v', گ: 'g',
};

function translitArabic(s) {
  return String(s || '')
    .split('')
    .map((c) => (AR2LAT[c] !== undefined ? AR2LAT[c] : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** يشغّل مرشحاً جاهزاً (نستعمله لما نقول «لا مو هذي») */
async function playCandidate(guild, cand) {
  const channel = botVoiceChannel(guild);
  if (!channel) return { say: 'ما لقيت الروم الصوتي.' };

  let m;
  try {
    ({ music: m } = music.getOrCreateConnection(guild, channel));
  } catch (e) {
    log('⚠️ ما دخلت الروم للأغنية:', String(e.message).slice(0, 120));
    return { say: 'ما قدرت أدخل الروم الصوتي.' };
  }

  const title = forSpeech(cand.title || '');
  const wasPlaying = Boolean(m.current);
  if (wasPlaying) {
    try {
      m.stopAll();
    } catch {
      /* ignore */
    }
  }
  m.songs.push({ ...cand, score: undefined });

  return {
    say: `طيب، هذي: ${title}.`,
    after: async () => {
      try {
        const ok = await m.startAndWait(60000);
        if (!ok) log('⚠️ البديل ما اشتغل');
      } catch (e) {
        log('⚠️ تشغيل البديل:', String(e.message).slice(0, 140));
      }
    },
  };
}

/** يشغّل أغنية طلبها المستخدم بالصوت */
async function playByVoice(guild, query) {
  const channel = botVoiceChannel(guild);
  if (!channel) return { say: 'ما لقيت الروم الصوتي.' };

  let m;
  try {
    ({ music: m } = music.getOrCreateConnection(guild, channel));
  } catch (e) {
    log('⚠️ ما دخلت الروم للأغنية:', String(e.message).slice(0, 120));
    return { say: 'ما قدرت أدخل الروم الصوتي.' };
  }

  const wasIdle = !m.current;

  // نبدأ البحث، ونطق تأكيد سريع بالتوازي عشان ما يحس المستخدم بصمت طويل
  const search = music.resolveQuery(query).catch((e) => {
    log(`⚠️ ما لقيت "${query}": ${String(e.message).slice(0, 160)}`);
    return { error: e };
  });
  await speakLine(guild, 'طيب، أشوفها لك الحين.').catch(() => {});
  let resolved = await search;

  // محاولة ثانية: لو الاسم أجنبي كتبه Whisper بالعربي، نحوّله لاتيني ونبحث مرة ثانية
  if ((!resolved || resolved.error) && /[\u0600-\u06FF]/.test(query)) {
    const lat = translitArabic(query);
    if (lat && /[a-z]{2}/i.test(lat) && lat !== query) {
      log(`🔁 محاولة ثانية بالإنجليزية: "${lat}"`);
      resolved = await music.resolveQuery(lat).catch((e) => {
        log(`⚠️ حتى بالإنجليزية ما لقيت "${lat}": ${String(e.message).slice(0, 120)}`);
        return resolved; // نرجّع خطأ المحاولة الأولى (فيه أقرب نتيجة)
      });
    }
  }

  if (!resolved || resolved.error || !Array.isArray(resolved.songs) || !resolved.songs.length) {
    const closest = resolved && resolved.error ? resolved.error.closest : null;
    return {
      say: closest
        ? `ما لقيت "${query}" بالضبط. أقرب شي لقيت: ${forSpeech(closest)}.`
        : `ما لقيت ${query}. جرب تقول اسمها أوضح.`,
    };
  }

  // نحفظ المرشحين عشان «لا مو هذي» تشغّل اللي بعدها
  if (Array.isArray(resolved.ranked) && resolved.ranked.length) {
    lastSearch.set(guild.id, { query, ranked: resolved.ranked, index: 0 });
  } else {
    lastSearch.delete(guild.id);
  }

  m.songs.push(...resolved.songs);
  const title = forSpeech(resolved.songs[0].title);
  const weak = Boolean(resolved.weak);

  if (!wasIdle) {
    return {
      say: weak
        ? `ضفتها، بس مو متأكد إنها هي: ${title}. لو مو هي قل: لا مو هذي.`
        : `ضفتها للطابور. الحين شغالة ${forSpeech(m.current?.title || '')}.`,
    };
  }

  return {
    say: weak
      ? `مو متأكد إنها هي، بس هذي أقرب شي: ${title}. لو مو هي قل: لا مو هذي.`
      : `طيب، شغالة الآن ${title}.`,
    after: async () => {
      try {
        const ok = await m.startAndWait(60000);
        if (!ok) log('⚠️ الموسيقى ما بدأت (بالأمر الصوتي)');
      } catch (e) {
        log('⚠️ تشغيل الموسيقى بالأمر الصوتي:', String(e.message).slice(0, 140));
      }
    },
  };
}

/**
 * ينفّذ أوامر الروم الصوتي (موسيقى/خروج/دخول/صوت).
 * @returns {Promise<{say?: string|null, after?: Function|null}|null>}
 */
async function runVoiceCommand(guild, rawText) {
  const n = normAr(rawText);
  if (!n) return null;

  const m0 = music.hasQueue(guild.id) ? music.getQueue(guild.id) : null;
  const playing = Boolean(m0 && m0.current);
  const vol = m0 ? m0.volume : 0.5;

  // ---- اطلع من الروم ----
  if (V_LEAVE_RE.test(n)) {
    const chName = forSpeech(botVoiceChannel(guild)?.name || 'الروم');
    gs(guild.id).autoRejoin = false;
    try {
      m0?.stopAll();
    } catch {
      /* ignore */
    }
    return {
      say: `طيب، اطلع من ${chName}. لو تبي أرجع قول: ادخل الروم.`,
      after: async () => {
        await new Promise((r) => setTimeout(r, 2500));
        gs(guild.id).autoRejoin = false;
        try {
          getVoiceConnection(guild.id)?.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  }

  // ---- ارجع للروم ----
  if (V_JOIN_RE.test(n)) {
    gs(guild.id).autoRejoin = true;
    const conn = getVoiceConnection(guild.id);
    if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
      return { say: 'أنا معك في الروم، تفضل.' };
    }
    const ch = botVoiceChannel(guild);
    if (!ch) return { say: 'ما لقيت الروم الصوتي.' };
    return { say: 'طيب، رجعت للروم.', after: async () => connect(guild, ch) };
  }

  // ---- وش شغال الآن ----
  if (V_NOW_RE.test(n)) {
    return {
      say: playing ? `الحين شغالة ${forSpeech(m0.current.title)}.` : 'ما فيه شي شغال الحين.',
    };
  }

  // ---- وقف الموسيقى ----
  if (matchStopCommand(n, playing)) {
    if (!playing) return { say: 'ما فيه شي شغال الحين.' };
    try {
      m0.stopAll();
    } catch {
      /* ignore */
    }
    return { say: 'طيب، وقفتها.' };
  }

  // ---- «لا مو هذي» : شغّل بديل من نفس البحث ----
  if (V_WRONG_RE.test(n)) {
    const st = lastSearch.get(guild.id);
    if (!st || !st.ranked || !st.ranked.length) {
      return { say: 'ما عندي بدائل الحين. قول اسم الأغنية من جديد وأشوف لك غيرها.' };
    }
    st.index += 1;
    if (st.index >= st.ranked.length) {
      lastSearch.delete(guild.id);
      return { say: `ما لقيت غيرها. جرب قول اسمها بشكل ثاني.` };
    }
    const cand = st.ranked[st.index];
    log(`🎵 بديل (${st.index + 1}/${st.ranked.length}) لـ "${st.query}": ${cand.title} [${Math.round(cand.score * 100)}%]`);
    return playCandidate(guild, cand);
  }

  // ---- التالية ----
  if (V_SKIP_RE.test(n)) {
    if (!playing) return { say: 'ما فيه شي شغال الحين.' };
    try {
      m0.skip();
    } catch {
      /* ignore */
    }
    return { say: 'طيب، جبت اللي بعدها.' };
  }

  // ---- إيقاف مؤقت / متابعة ----
  if (V_PAUSE_RE.test(n)) {
    if (!playing) return { say: 'ما فيه شي شغال الحين.' };
    try {
      m0.player.pause();
    } catch {
      /* ignore */
    }
    return { say: 'طيب، وقفتها مؤقتاً. قول كمل عشان أكملها.' };
  }
  if (V_RESUME_RE.test(n)) {
    if (!playing) return { say: 'ما فيه شي شغال الحين.' };
    try {
      m0.player.unpause();
    } catch {
      /* ignore */
    }
    return { say: 'طيب، كملت.' };
  }

  // ---- تكرار ----
  if (V_LOOP_OFF_RE.test(n)) {
    try {
      m0?.toggleLoop(false);
    } catch {
      /* ignore */
    }
    return { say: 'طيب، وقفت التكرار.' };
  }
  if (V_LOOP_RE.test(n)) {
    try {
      m0?.toggleLoop(true);
    } catch {
      /* ignore */
    }
    return { say: 'طيب، بكرر الأغنية.' };
  }

  // ---- الصوت ----
  if (V_VOL_UP_RE.test(n)) {
    const v = Math.min(1, Math.round((vol + 0.2) * 10) / 10);
    try {
      m0?.setVolume(v);
    } catch {
      /* ignore */
    }
    return { say: `طيب، رفعت الصوت إلى ${Math.round(v * 100)} بالمية.` };
  }
  if (V_VOL_DOWN_RE.test(n)) {
    const v = Math.max(0, Math.round((vol - 0.2) * 10) / 10);
    try {
      m0?.setVolume(v);
    } catch {
      /* ignore */
    }
    return { say: `طيب، نزلت الصوت إلى ${Math.round(v * 100)} بالمية.` };
  }

  // ---- شغّل أغنية ----
  const playN = n.match(V_PLAY_RE);
  if (playN) {
    // نستخرج الاسم من النص الأصلي عشان نحفظ الإملاء
    const rawMatch = String(rawText || '').match(V_PLAY_RE);
    let query = String((rawMatch && rawMatch[1]) || playN[1] || '').trim();
    query = cleanSongQuery(query.replace(/^لي\s+/, ''));
    if (!query || V_GENERIC_SONG_RE.test(normAr(query))) {
      return { say: 'وش الأغنية اللي تبي أشغلها؟' };
    }
    return playByVoice(guild, query);
  }

  return null;
}

// ---------------------------------------------------------------------------
// المحادثة (شات) 💬
// ---------------------------------------------------------------------------
/** هل الرسالة تنادي البوت باسمه؟ */
function callsBotByName(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // يناديه بالاسم في بداية الرسالة فقط (عشان ما يرد على كل من كتب «بوت» في كلامه)
  return (
    /^(?:يا\s+)?(?:بوت|bot)(?:\s|$|[،,.!?])/i.test(t) ||
    /^(?:يا\s+)?u7\s*bot(?:\s|$|[،,.!?])/i.test(t)
  );
}

// ---------------------------------------------------------------------------
// الهوني بوت: روم فخ للمخالفين 🍯
// ---------------------------------------------------------------------------
const HONEYPOT_CHANNEL_ID = (process.env.HONEYPOT_CHANNEL_ID || '').trim();
const HONEYPOT_CHANNEL_NAME = (
  process.env.HONEYPOT_CHANNEL_NAME || 'honeypot'
).trim();
const HONEYPOT_LOG_CHANNEL_ID = (process.env.HONEYPOT_LOG_CHANNEL_ID || '').trim();
const HONEYPOT_LOG_CHANNEL_NAME = (
  process.env.HONEYPOT_LOG_CHANNEL_NAME || '📋｜سجل-الحماية'
).trim();
const HONEYPOT_KICK =
  String(process.env.HONEYPOT_KICK || 'true').toLowerCase() !== 'false';

function isHoneypotChannel(channel) {
  if (!channel) return false;
  if (HONEYPOT_CHANNEL_ID && channel.id === HONEYPOT_CHANNEL_ID) return true;
  return (
    channel.name === HONEYPOT_CHANNEL_NAME ||
    (typeof channel.name === 'string' && channel.name.endsWith('honeypot'))
  );
}

function findHoneypotLogChannel(guild) {
  if (!guild) return null;
  if (HONEYPOT_LOG_CHANNEL_ID) {
    const byId = guild.channels.cache.get(HONEYPOT_LOG_CHANNEL_ID);
    if (byId && byId.isTextBased?.()) return byId;
  }
  return (
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && c.name === HONEYPOT_LOG_CHANNEL_NAME,
    ) ||
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && c.name === '📋｜الإدارة',
    ) ||
    null
  );
}

async function logHoneypot(message, action, detail, color) {
  const logChannel = findHoneypotLogChannel(message.guild);
  if (!logChannel) return;
  const content =
    String(message.content || '').trim().slice(0, 1000) || '(المحتوى غير متاح)';
  const userTag = message.author.tag || message.author.username || message.author.id;
  await logChannel
    .send({
      embeds: [
        {
          title: '🚨 محاولة في الهوني بوت',
          description:
            `العضو: <@${message.author.id}> (\`${userTag}\`)\n` +
            `الروم: <#${message.channelId}>\n` +
            `الإجراء: ${action}`,
          color,
          fields: [
            { name: 'الرسالة', value: content.slice(0, 1024) },
            { name: 'التفاصيل', value: String(detail || '—').slice(0, 1024) },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
      allowedMentions: { parse: [] },
    })
    .catch((err) => log('تعذر إرسال سجل الهوني بوت:', err.message));
}

async function handleHoneypot(message) {
  if (!message.guild || !message.author || message.author.bot) return false;
  if (!isHoneypotChannel(message.channel)) return false;

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (err) {
    log('تعذر حذف رسالة الهوني بوت:', err.message);
  }
  const deletion = deleted ? 'تم حذف الرسالة.' : 'تعذر حذف الرسالة.';

  const member =
    message.member ||
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  const isOwner = message.author.id === message.guild.ownerId;
  const isStaff = Boolean(
    member?.permissions?.has(PermissionFlagsBits.ManageGuild),
  );

  if (isOwner || isStaff) {
    await logHoneypot(
      message,
      'تم الرصد — اختبار/إدارة (بدون طرد)',
      `${deletion} ${
        isOwner
          ? 'اختبار من المالك: البوت شغال.'
          : 'العضو من الإدارة، تم تجاهل الطرد.'
      }`,
      0xf1c40f,
    );
    return true;
  }

  if (!member) {
    await logHoneypot(
      message,
      'تم الرصد — تعذر جلب العضو',
      `${deletion} لم يتم الطرد.`,
      0xe67e22,
    );
    return true;
  }

  if (!HONEYPOT_KICK) {
    await logHoneypot(
      message,
      'تم الرصد — الطرد التلقائي مقفول',
      `${deletion} HONEYPOT_KICK=false`,
      0xe67e22,
    );
    return true;
  }

  try {
    if (!member.kickable) {
      await logHoneypot(
        message,
        'تم الرصد — تعذر الطرد',
        `${deletion} رتبة البوت تحت رتبة العضو. ارفع رتبة البوت أو اطرده يدوياً.`,
        0xe67e22,
      );
      return true;
    }
    await member.kick('Honeypot violation');
    await logHoneypot(
      message,
      '✅ تم طرد العضو',
      `${deletion} تم طرد العضو.`,
      0x2ecc71,
    );
  } catch (err) {
    await logHoneypot(
      message,
      'تم الرصد — فشل الطرد',
      `${deletion} ${err.message}`,
      0xe74c3c,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// فلتر القذف: حذف الرسالة + تايم أوت ساعة 🚫
// ---------------------------------------------------------------------------
async function handleProfanity(message) {
  if (!message.guild || !message.author || message.author.bot) return false;
  const content = message.content || '';
  if (!content) return false;

  const hit = profanity.detect(content);
  if (!hit) return false;

  const member =
    message.member ||
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return false;
  // الإدارة والمالك مستثنون
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return false;

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (err) {
    log('تعذر حذف رسالة القذف:', err.message);
  }

  let timedOut = false;
  try {
    if (member.moderatable) {
      await member.timeout(profanity.TIMEOUT_MS, `قذف/سب: ${hit}`);
      timedOut = true;
    }
  } catch (err) {
    log('تعذر تايم أوت القذف:', err.message);
  }

  const logChannel = findHoneypotLogChannel(message.guild);
  if (logChannel) {
    await logChannel
      .send({
        embeds: [
          {
            title: '🚫 قذف/سب — تايم أوت ساعة',
            description:
              `العضو: <@${message.author.id}> (\`${message.author.tag}\`)\n` +
              `الروم: <#${message.channelId}>\n` +
              `الكلمة: \`${hit}\`\n` +
              `حذف الرسالة: ${deleted ? '✅' : '❌'}\n` +
              `تايم أوت ساعة: ${timedOut ? '✅' : '❌'}`,
            color: 0xed4245,
            timestamp: new Date().toISOString(),
          },
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }

  const notice = await message.channel
    .send({
      content: `🚫 ممنوع القذف والسب يا <@${message.author.id}> — تم حذف رسالتك وتايم أوت **ساعة كاملة**.`,
      allowedMentions: { users: [message.author.id] },
    })
    .catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000);

  log(`🚫 قذف من ${message.author.tag} (${hit}) — حذف=${deleted} تايم أوت=${timedOut}`);
  return true;
}

const SALAM_RE = /^[\s\p{So}\p{Sk}\u200d\uFE0F]*(?:السلام|سلام)\s*عليكم(?:\s*ورحمة\s*الله(?:\s*وبركاته)?)?/u;
const salamAt = new Map(); // مفتاح -> آخر رد (لمنع التكرار)

/** رد تلقائي على تحية السلام — يشتغل لكل من يكتب «السلام عليكم» */
async function handleSalam(message) {
  try {
    if (!message?.author || message.author.bot) return false;
    const content = message.content || '';
    if (!SALAM_RE.test(content)) return false;
    // لو فيه منشن للبوت، خل المحادثة ترد (عشان ما يصير ردّان)
    if (message.client?.user && message.mentions?.has?.(message.client.user)) return false;
    const key = `${message.guildId || 'dm'}:${message.channelId}:${message.author.id}`;
    const now = Date.now();
    if (now - (salamAt.get(key) || 0) < 4000) return true;
    salamAt.set(key, now);
    if (salamAt.size > 500) {
      for (const [k, t] of salamAt) if (now - t > 60000) salamAt.delete(k);
    }
    await message.reply({
      content: /ورحمة\s*الله/.test(content)
        ? 'وعليكم السلام ورحمة الله وبركاته'
        : 'وعليكم السلام',
      allowedMentions: { parse: [], repliedUser: false },
    });
    return true;
  } catch (e) {
    log('[salam] تعذر الرد:', String(e.message).slice(0, 120));
    return false;
  }
}

client.on('messageCreate', async (message) => {
  // 🛡️ تجاهل أي رسالة من سيرفر غير مصرّح
  if (message.guildId && !guard.isAllowed(message.guildId)) return;
  if (await handleHoneypot(message)) return;
  if (await handleProfanity(message)) return;
  if (await handleSalam(message)) return;
  if (!CHAT_ENABLED) return;
  try {
    if (!message.author || message.author.bot) return;
    if (!client.user) return;

    const isDM = !message.guild;
    const mentioned = Boolean(message.mentions?.has?.(client.user));
    const content = message.content || '';
    // بدون "Message Content Intent" يوصل النص فقط للرسائل اللي فيها منشن أو الخاص
    const named = MSG_CONTENT && callsBotByName(content);

    if (!isDM && !mentioned && !named) return;

    const key = isDM
      ? `dm:${message.author.id}`
      : `g:${message.guildId}:c:${message.channelId}:u:${message.author.id}`;

    if (chat.throttled(key)) return;

    // نشيل المنشن واسم البوت من النص
    let text = content
      .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), ' ')
      .replace(/^(يا\s*)?(بوت|bot)\s*24\s*\/?\s*7/i, ' ')
      .replace(/^(يا\s*)?(بوت|bot)\b/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    log(
      `💬 رسالة${isDM ? ' (خاص)' : ''} من ${message.author.tag}: ` +
        `"${(text || '(فاضية)').slice(0, 80)}"`,
    );

    await message.channel.sendTyping?.().catch(() => {});

    // أوامر إدارية بالكتابة: «يا بوت ميوت @فلان 60»
    const adminReply = await admin.handleText(message, text);
    if (adminReply) {
      await message.reply({ content: adminReply, allowedMentions: { repliedUser: false } });
      return;
    }

    // أمر تشغيل/إيقاف الرد الصوتي (بالكتابة) — ملغي
    if (VOICE_ENABLED) {
      const playingTxt = (() => {
        try {
          const q = message.guildId ? music.getQueue(message.guildId) : null;
          return Boolean(q && q.current);
        } catch {
          return false;
        }
      })();
      const vIntent = voiceToggleIntent(text, playingTxt);
      if (vIntent) {
        const on = setVoiceChat(
          vIntent === 'on',
          `بالكتابة من ${message.author.tag}: «${String(text || '').slice(0, 50)}»`,
          message.guild?.id,
        );
        await message.reply({
          content: on
            ? '✅ شغّلت الرد الصوتي — تكلم في الروم وأنا أرد عليك بالصوت.'
            : '⛔ وقفت الرد الصوتي — من الحين ما أتكلم في الروم.',
          allowedMentions: { repliedUser: false },
        });
        return;
      }
    }

    // أولاً: هل هو أمر موسيقى؟ ("شغل لي ...") — ملغي
    if (MUSIC_ENABLED) {
      const musicResult = await runMusicFromChat(message, text);
      if (musicResult) {
        await message.reply({ content: musicResult, allowedMentions: { repliedUser: false } });
        return;
      }
    }

    const r = await chat.reply({
      key,
      text: text || 'سلّم علي',
      userLabel: message.member?.displayName || message.author.username,
    });

    await message.reply({ content: r.text, allowedMentions: { repliedUser: false } });
  } catch (err) {
    log('خطأ في المحادثة:', err.message);
  }
});

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
let REGISTER_STATE = { ok: false, count: 0, guilds: 0, error: null };

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('status').setDescription('يعرض حالة البوت'),
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('يدخّل البوت روم صوتي ويجلس فيه (أي روم)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addChannelOption((o) =>
        o
          .setName('الروم')
          .setDescription('أي روم صوتي (افتراضي: الروم اللي أنت فيه)')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
      ),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('يخرج البوت من الروم الصوتي')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    ...admin.buildCommands(),
    ...chat.buildCommands(),
    ...Object.values(MODULES).flatMap((m) =>
      typeof m.buildCommands === 'function' ? m.buildCommands() : [],
    ),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));

  try {
    // 1) نسجّل الأوامر في كل سيرفر البوت فيه (تظهر فوراً)
    const guildIds = [
      ...new Set([
        ...client.guilds.cache.keys(),
        ...(GUILD_ID ? GUILD_ID.split(/[,\s]+/).filter(Boolean) : []),
      ]),
    ].filter((gid) => guard.isAllowed(gid));
    for (const gid of guildIds) {
      try {
        await client.rest.put(Routes.applicationGuildCommands(client.user.id, gid), {
          body: commands,
        });
        REGISTER_STATE.ok = true;
        REGISTER_STATE.count = commands.length;
        REGISTER_STATE.guilds += 1;
        REGISTER_STATE.error = null;
        log(`تم تسجيل الأوامر في السيرفر ${gid}.`);
      } catch (e) {
        log(`تنبيه: ما قدرت أسجّل الأوامر في ${gid}: ${String(e.message).slice(0, 90)}`);
      }
    }

    // 2) نمسح الأوامر العامة القديمة (كانت تظهر بأي سيرفر) — الأوامر الآن لكل سيرفر مصرّح فقط
    try {
      await client.rest.put(Routes.applicationCommands(client.user.id), { body: [] });
      log('تم مسح الأوامر العامة (ما تظهر إلا في السيرفرات المصرّح لها).');
    } catch (e) {
      log('تنبيه: ما قدرت أمسح الأوامر العامة:', String(e.message).slice(0, 90));
    }
  } catch (err) {
    log('ما قدرت أسجّل أوامر السلاش:', err.message);
  }
}

client.on('interactionCreate', async (interaction) => {
  // 🛡️ تجاهل أي أمر من سيرفر غير مصرّح
  if (interaction.guildId && !guard.isAllowed(interaction.guildId)) return;
  if (!interaction.isChatInputCommand()) return;

  log(`📥 أمر: /${interaction.commandName} — من ${interaction.user.tag} (${interaction.guild?.name ?? 'خاص'})`);

  try {
    // أوامر الراديو الصوتي (دخول/خروج)
    if (interaction.commandName === 'join') {
      const ch =
        interaction.options.getChannel('الروم') ||
        interaction.member?.voice?.channel ||
        null;
      await interaction.deferReply({ ephemeral: true });
      const s = await radio.join(client, ch?.id, interaction.guildId);
      await interaction.editReply({
        content:
          s.state === 'ready'
            ? `✅ دخلت الروم الصوتي${ch ? ` <#${ch.id}>` : ''}${
                s.audio ? ` — التلاوة شغّالة (سورة ${s.surah})` : ' — جالس بدون صوت'
              }.`
            : `⚠️ حاولت الدخول لكن الحالة: ${s.state}. تأكد من الصلاحيات.`,
      });
      return;
    }
    if (interaction.commandName === 'leave') {
      await interaction.deferReply({ ephemeral: true });
      radio.leave(interaction.guildId);
      await interaction.editReply({ content: '⏹️ خرجت من الروم الصوتي. اكتب `/join` لرجوعها.' });
      return;
    }

    // أوامر الإدارة أولاً (حظر/طرد/تايم أوت/مسح/قفل/رتب/إعلانات)
    const adminHandled = await admin.handleInteraction(interaction);
    if (adminHandled) return;

    // /chat: ينفّذ الطلبات الفعلية أولاً (إرسال لروم، مسح، قفل…) بدون تدخل
    if (interaction.commandName === 'chat') {
      const raw = interaction.options.getString('الكلام') || '';
      const pseudo = {
        guild: interaction.guild,
        member: interaction.member,
        channel: interaction.channel,
        channelId: interaction.channelId,
        author: interaction.user,
        mentions: {},
      };
      const actionReply = await admin.handleText(pseudo, raw);
      if (actionReply) {
        await interaction.reply({
          content: actionReply,
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }
    }

    // أوامر المحادثة (chat/chatreset)
    const chatHandled = await chat.handleInteraction(interaction);
    if (chatHandled) return;

    // وحدات الميزات الإضافية (مستويات/سحوبات/تذاكر)
    for (const [name, mod] of Object.entries(MODULES)) {
      if (typeof mod.handleInteraction !== 'function') continue;
      try {
        const handled = await mod.handleInteraction(interaction);
        if (handled) return;
      } catch (err) {
        log(`[modules] خطأ في ${name}:`, err.message);
      }
    }

    if (interaction.commandName === 'status') {
      await interaction.reply(
        `🛡️ **بوت إداري**\n` +
          `زمن الاستجابة: ${Math.round(client.ws.ping)}ms\n` +
          `السيرفرات: ${client.guilds.cache.size}\n` +
          `السوالف النصية: ${CHAT_ENABLED ? 'مفعّلة' : 'متوقفة'}\n` +
          `فلتر القذف: ✅ حذف + تايم أوت ساعة\n` +
          `الأوامر: \`/adminhelp\``,
      );
    }
  } catch (err) {
    log('خطأ في الأمر:', err.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`صار خطأ: ${err.message}`).catch(() => {});
    } else {
      await interaction.reply({ content: `صار خطأ: ${err.message}`, ephemeral: true }).catch(() => {});
    }
    return;
  }

  // شبكة أمان: أي أمر ما تعاملنا معه نرد عليه عشان ما يطلع "التطبيق ما استجاب"
  if (!interaction.replied && !interaction.deferred) {
    log(`⚠️ أمر غير معروف: /${interaction.commandName}`);
    await interaction
      .reply({
        content:
          `ما عرفت الأمر \`/${interaction.commandName}\` 😅\n` +
          'الأوامر المتاحة: `/adminhelp` لجميع أوامر الإدارة، و`/status`.',
        ephemeral: true,
      })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// الفحص الدوري
// ---------------------------------------------------------------------------
setInterval(() => {
  if (VOICE_ENABLED) {
    ensureConnected().catch((e) => log('خطأ في الفحص الدوري:', e.message));
  }

  // مراقبة الذاكرة (كل دقيقتين) — تكشف التسريب/الحدود قبل ما يقتلنا المستضيف
  try {
    const mb = (n) => Math.round(n / 1048576);
    const m = process.memoryUsage();
    memTick++;
    if (memTick % 4 === 1) {
      log(
        `🧠 الذاكرة: ${mb(m.rss)}MB (heap ${mb(m.heapUsed)}/${mb(m.heapTotal)}، خارجي ${mb(m.external)}) | شغّال منذ ${Math.round(process.uptime() / 60)} دقيقة`,
      );
    }
    if (memTick % 20 === 0 && typeof global.gc === 'function') global.gc();
  } catch {
    /* ignore */
  }

  // فحص اتصال البوابة (لو تعطّل، ما بنستقبل أوامر)
  try {
    if (client.isReady() && client.ws.status !== 0) {
      log(`⚠️ اتصال البوابة غير سليم (status=${client.ws.status}) — البوت ما بيستقبل أوامر!`);
    }
  } catch {
    /* ignore */
  }

  // إعادة محاولة ضبط رتبة البوت لو فشلت (لين يصلّح المستخدم الصلاحيات)
  if (botRolePending.size) {
    for (const id of [...botRolePending]) {
      const g = client.guilds.cache.get(id);
      if (g) ensureBotRole(g).catch(() => {});
    }
  }
}, CHECK_MS);

// شبكة أمان: أي خطأ غير متوقع لا يوقف البوت
process.on('unhandledRejection', (err) => log('unhandledRejection:', err?.message ?? err));
process.on('uncaughtException', (err) => log('uncaughtException:', err?.message ?? err));

// ---------------------------------------------------------------------------
// التشغيل
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (!TOKEN) {
    log('❌ ما لقيت DISCORD_TOKEN في ملف .env');
    process.exit(1);
  }

  log('جاري تسجيل الدخول...');
  client.login(TOKEN).catch((err) => {
    log('❌ فشل تسجيل الدخول:', err.message);
    process.exit(1);
  });
} else {
  // يسمح باختبار الأوامر الصوتية بدون تشغيل البوت (test-voicecmd.js)
  module.exports = {
    normAr,
    voiceToggleIntent,
    forSpeech,
    runVoiceCommand,
    looksLikeEcho,
    translitArabic,
    matchStopCommand,
    cleanSongQuery,
  };
}
