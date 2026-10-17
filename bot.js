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
const chat = require('./chat');
const speech = require('./speech');
const { VoiceChat } = require('./voicechat');

// ---------------------------------------------------------------------------
// الإعدادات
// ---------------------------------------------------------------------------
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();
const VOICE_CHANNEL_ID = (process.env.VOICE_CHANNEL_ID || '').trim();
const CHECK_MS = Math.max(5, Number(process.env.CHECK_SECONDS || 30)) * 1000;
const LOCK_TO_CHANNEL = String(process.env.LOCK_TO_CHANNEL || 'true').toLowerCase() !== 'false';
// ترحيب صوتي عند دخول أول شخص للروم (يشتغل كفحص تلقائي للنطق)
const GREET_ON_JOIN = String(process.env.VOICE_GREET_ON_JOIN || 'true').toLowerCase() !== 'false';

// المحادثة
const CHAT_ENABLED = String(process.env.CHAT_ENABLED || 'true').toLowerCase() !== 'false';
// لازم تفعّل "Message Content Intent" في بوابة المطورين قبل ما تشغّل هذا
const MSG_CONTENT =
  String(process.env.ENABLE_MESSAGE_CONTENT || 'false').toLowerCase() === 'true';

let autoRejoin = true;   // يتوقف لما تكتب /leave
let joinTimer = null;    // مؤقت إعادة الدخول
let lastJoinAt = 0;      // وقت آخر محاولة دخول (عشان ما نكررها بسرعة)
let voiceChat = null;    // وحدة المحادثة الصوتية (سماع المتكلمين)
let voiceBusy = false;   // البوت يرد حالياً — نحفظ الكلام الجديد ونرد عليه بعدين
let pendingVoice = null; // آخر كلام وصل والبوت مشغول (عشان ما نفقده)
let lastSpokenText = ''; // آخر شي نطقه البوت (نكشف صدى صوتنا)
// الرد الصوتي شغّال ولا متوقف (ينشغّل/ينوقف بأمر بالكلام أو بالكتابة أو بـ /voice)
let voiceChatOn = String(process.env.VOICE_CHAT || 'true').toLowerCase() !== 'false';

// مهلة السماح لمحاولة الاتصال قبل ما نعتبرها فاشلة ونعيدها
const JOIN_GRACE_MS = 20000;

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
    GatewayIntentBits.DirectMessages,
    // اختياري: يخلي البوت يقرأ كل الرسائل (يحتاج تفعيله في بوابة المطورين)
    ...(MSG_CONTENT ? [GatewayIntentBits.MessageContent] : []),
  ],
});

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
              voiceChat: voiceChat ? voiceChat.stats : null,
              voiceDebug: music.getVoiceDebug(50),
            },
            null,
            2,
          ),
        );
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

      const data = await music.diagnose({
        query: u.searchParams.get('q') || '',
        vids: u.searchParams.get('vids') || '',
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
        bot: client.user?.tag ?? 'starting',
        gateway: client.isReady() ? 'ready' : 'offline',
        voice,
        channel: inChannelId
          ? guild.channels.cache.get(inChannelId)?.name ?? inChannelId
          : null,
        uptime: Math.round(process.uptime()),
        voiceChat: voiceChat ? voiceChat.stats : null,
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

  // مصدر الحقيقة: رأي ديسكورد نفسه عن مكان البوت
  const meChannelId = guild.members.me?.voice?.channelId ?? null;
  const ready = Boolean(conn) && conn.state.status === VoiceConnectionStatus.Ready;

  // متصل فعلاً بالروم الصحيح -> ما نسوي شي
  if (ready && meChannelId === channel.id) return;

  // لسا داخل مهلة محاولة حديثة -> ننتظرها
  if (Date.now() - lastJoinAt < JOIN_GRACE_MS) return;

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

  lastJoinAt = Date.now();
  connect(guild, channel);
}

function connect(guild, channel) {
  lastJoinAt = Date.now();
  let conn;
  try {
    // مصدر واحد للاتصال — نفس الإعدادات (selfMute/selfDeaf/تصحيح الصوت)
    conn = music.getOrCreateConnection(guild, channel).conn;
  } catch (err) {
    log('فشل الاتصال الصوتي:', err.message);
    scheduleJoin(5000);
    return;
  }

  let lastReadyLog = 0;
  conn.on(VoiceConnectionStatus.Ready, () => {
    // نمنع تكرار الرسالة (بروتوكول DAVE يعيد التفاوض أكثر من مرة)
    if (Date.now() - lastReadyLog > 10000) {
      log(`✅ دخلت الروم الصوتي: ${channel.name}`);
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
      if (voiceChat) voiceChat.stop();
      // معالجة كلام المستخدم — نستدعيها من الطابور تحت (واحد في كل مرة)
      const handleVoice = async (u) => {
        voiceBusy = true;
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
          if (u.duringSpeech && looksLikeEcho(text, lastSpokenText)) {
            log(`🔁 تجاهلت صدى صوتي: "${text.slice(0, 60)}"`);
            return;
          }

          log(`🗣️ سمعت (${Date.now() - t0}ms): "${text}"`);

          const name =
            guild.members?.cache?.get(u.userId)?.displayName ||
            guild.members?.cache?.get(u.userId)?.user?.username ||
            'صديقي';

          // 1) هل هو أمر صوتي (شغّل / وقف الرد الصوتي)؟
          const intent = voiceToggleIntent(text);
          if (intent) {
            const wasOn = voiceChatOn;
            setVoiceChat(intent === 'on', `بالكلام من ${name}`);
            voiceChat.setSpeaking(true);
            try {
              if (wasOn !== voiceChatOn || intent === 'on') {
                await speakLine(
                  guild,
                  intent === 'on'
                    ? 'تم، شغلت الرد الصوتي. تفضل تكلم وأنا معك.'
                    : 'تم، وقفت الرد الصوتي. لو تبي أرجعه قل: شغل الرد الصوتي.',
                );
              }
            } catch (e) {
              log('⚠️ ما قدرت أأكد الأمر بالصوت:', String(e.message).slice(0, 120));
            } finally {
              voiceChat.setSpeaking(false);
            }
            return;
          }

          // 2) الرد الصوتي متوقف؟ نتجاهل الكلام (بس نظل نسمع عشان أمر التشغيل)
          if (!voiceChatOn) {
            log('🔇 الرد الصوتي متوقف — تجاهلت الكلام');
            return;
          }

          // 3) أوامر الروم بالصوت (شغّل أغنية / اطلع / وقف / التالي / الصوت)
          let vcmd = null;
          try {
            vcmd = await runVoiceCommand(guild, text);
          } catch (e) {
            log('⚠️ خطأ في الأمر الصوتي:', String(e.message).slice(0, 140));
          }
          if (vcmd) {
            log(`🎛️ أمر صوتي: "${text}"`);
            voiceChat.setSpeaking(true);
            try {
              if (vcmd.say) await speakLine(guild, forSpeech(vcmd.say));
            } catch (e) {
              log('⚠️ ما قدرت أنطق التأكيد:', String(e.message).slice(0, 120));
            } finally {
              voiceChat.setSpeaking(false);
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

          voiceChat.setSpeaking(true);

          const reply = await chat.voiceReply({ key: `voice:${u.userId}`, text, userLabel: name });
          log(`💬 رد (${Date.now() - t0}ms): "${reply.text}"`);

          const m = music.getQueue(guild.id);
          try {
            const dv = music.connDave(conn);
            log(
              `🎧 التشفير (DAVE): ${dv?.session?.ready ? 'جاهز' : 'غير جاهز'} (v${dv?.protocolVersion ?? '?'})`,
            );
          } catch {
            /* ignore */
          }
          const stream = await speech.speak(reply.text);
          lastSpokenText = reply.text;
          const played = await m.speak(stream, 1);
          log(`🔊 نطقنا (${Date.now() - t0}ms) — تشغيل=${played ? 'نجح' : 'ما وصل'}`);
        } catch (e) {
          log('⚠️ فشل الرد الصوتي:', String(e.message).slice(0, 150));
        } finally {
          voiceChat.setSpeaking(false);
          voiceBusy = false;
        }
      };

      voiceChat = new VoiceChat(conn, {
        onUtterance: async (u) => {
          if (voiceBusy) {
            // البوت مشغول — نحفظ آخر كلام عشان نرد عليه بعد ما نخلص (بدل ما نرميه)
            pendingVoice = u;
            log('⏳ البوت مشغول — بحفظ كلامك وأرد عليه بعد ما أخلص ردي');
            return;
          }
          await handleVoice(u);
          // نعالج آخر كلام وصل أثناء الرد
          while (pendingVoice) {
            const next = pendingVoice;
            pendingVoice = null;
            await handleVoice(next);
          }
        },
      });
      voiceChat.setEnabled(voiceChatOn);
      voiceChat.start();
    } catch (e) {
      log('تنبيه: تعذّر تشغيل المحادثة الصوتية:', e.message);
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

/**
 * نطق ترحيب عند دخول أول شخص للروم — يشتغل كفحص تلقائي لمسار الصوت كامل.
 */
async function greetTest(guild, who = '') {
  const t0 = Date.now();
  try {
    const conn = getVoiceConnection(guild.id);
    // ننتظر لين تشفير E2EE يجهز (وإلا الصوت ينرسل بدون تشفير ويسكت عند المستمع)
    const daveOk = await music.waitForDaveReady(conn, 6000);
    log(`🎧 التشفير (DAVE) عند الترحيب: ${daveOk ? 'جاهز' : 'غير جاهز'}`);
    if (voiceChat) voiceChat.setSpeaking(true);
    const m = music.getQueue(guild.id);
    const line = `يا هلا ${who}! أنا أسمعك وأرد عليك، تكلّم طبيعي.`;
    const ogg = await speech.speak(line);
    const played = await m.speak(ogg, 1);
    log(`👋 ترحيب صوتي (${Date.now() - t0}ms) — تشغيل=${played ? 'نجح' : 'ما وصل'}`);
  } catch (e) {
    log('⚠️ النطق فشل:', String(e.message).slice(0, 160));
    throw e;
  } finally {
    if (voiceChat) voiceChat.setSpeaking(false);
  }
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

  // فحص عملاء يوتيوب بالخلفية واختيار أول واحد شغّال
  // (يتجاوز حجب "Sign in to confirm you're not a bot")
  music.ensureWorkingClient().catch((e) => log('تنبيه: فحص عملاء يوتيوب فشل:', e.message));

  // فحص مفتاح الذكاء الاصطناعي (لو موجود)
  chat.selfTest().catch((e) => log('تنبيه: فحص المحادثة فشل:', e.message));

  // فحص محرّك النطق (يبيّن أي مزوّد يشتغل: Groq / Edge / Google)
  speech
    .speak('أنا جاهز أسمعك وأرد عليك')
    .then((ogg) => log(`✅ محرّك النطق شغّال (${ogg.length} بايت)`))
    .catch((e) => log('❌ محرّك النطق ما يشتغل:', String(e.message).slice(0, 160)));

  if (VOICE_CHANNEL_ID) {
    await ensureConnected();
  } else {
    log('VOICE_CHANNEL_ID غير محدد — البوت ما بيدخل روم تلقائيًا.');
  }

  // رتبة البوت في كل سيرفر 🎖️
  for (const guild of client.guilds.cache.values()) {
    ensureBotRole(guild).catch(() => {});
  }
});

client.on('guildCreate', (guild) => {
  log(`انضممت لسيرفر جديد: ${guild.name}`);
  ensureBotRole(guild).catch(() => {});
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!client.user || newState.id !== client.user.id) return;
  if (!autoRejoin) return;

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
    if (GREET_ON_JOIN && voiceChatOn && humanJoined && botChannelId === newState.channelId && onlyBot) {
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
    lastJoinAt = 0; // نسمح بإعادة الدخول فوراً
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
    if (LOCK_TO_CHANNEL) {
      lastJoinAt = 0; // نسمح بإعادة الدخول فوراً
      scheduleJoin(3000);
    }
  }
});

// ---------------------------------------------------------------------------
// تنفيذ كلام المستخدم فعلياً (موسيقى) من الشات
// ---------------------------------------------------------------------------
const PLAY_INTENT =
  /^\s*(?:يا\s*)?(?:شغل لي|شغّل لي|شغل|شغّل|سمعني|سمّعني|ابغى اسمع|أبغى اسمع|ابي اسمع|أبي اسمع|play me|play)\s*[:،\-]?\s*(.+)$/i;
const STOP_INTENT = /^\s*(?:وقف|أوقف|اوقف|اقفل|سكّر|سكر|اسكت|خلص|stop)\s*[!.؟]*$/i;
const SKIP_INTENT = /^\s*(?:تخطى|تخطي|سكب|التالي|اللي بعدها|skip|next)\s*[!.؟]*$/i;

/** يجيب الروم الصوتي: روم المستخدم أو الروم المحدد في الإعدادات */
async function resolveVoiceChannel(message) {
  const own = message.member?.voice?.channel;
  if (own) return own;
  if (!message.guild || !VOICE_CHANNEL_ID) return null;
  return (
    message.guild.channels.cache.get(VOICE_CHANNEL_ID) ||
    (await message.guild.channels.fetch(VOICE_CHANNEL_ID).catch(() => null))
  );
}

/**
 * لو الرسالة أمر موسيقى ("شغل لي ...") ينفّذه ويرجّع نص الرد.
 * يرجّع null لو ما كان أمر موسيقى.
 */
async function runMusicFromChat(message, text) {
  const guild = message.guild;
  if (!guild) return null;

  if (STOP_INTENT.test(text)) {
    if (!music.hasQueue(guild.id) || !music.getQueue(guild.id).current) {
      return 'ما فيه شي شغّال أصلاً 🤷';
    }
    music.getQueue(guild.id).stopAll();
    return '⏹️ وقفت الموسيقى وفضّيت الطابور.';
  }

  if (SKIP_INTENT.test(text)) {
    const m = music.hasQueue(guild.id) ? music.getQueue(guild.id) : null;
    if (!m || !m.current) return 'ما فيه شي شغّال 🤷';
    m.skip();
    return '⏭️ تخطيت الأغنية.';
  }

  const play = text.match(PLAY_INTENT);
  if (!play) return null;
  const query = (play[1] || '').replace(/^لي\s+/, '').trim();
  if (!query) return null;

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
  return started
    ? `▶️ شغّالة الآن: **${resolved.songs[0].title}** 🎧`
    : '❌ ما قدرت أشغّلها — جرّب تكتب اسمها بطريقة ثانية.';
}

// ---------------------------------------------------------------------------
// رتبة البوت في السيرفر 🎖️
// ---------------------------------------------------------------------------
const BOT_ROLE_NAME = (process.env.BOT_ROLE_NAME || 'بوت 24/7').trim();
const BOT_ROLE_COLOR = (process.env.BOT_ROLE_COLOR || '#5865F2').trim();

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
        hoist: false,
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
];

// عبارات تشغيل الرد الصوتي
const VOICE_ON_PHRASES = [
  'شغل الرد الصوتي',
  'فعل الرد الصوتي',
  'افتح الرد الصوتي',
  'رجع الرد الصوتي',
  'شغل المحادثه الصوتيه',
  'فعل المحادثه الصوتيه',
  'افتح المحادثه الصوتيه',
  'شغل الصوت',
  'كلمني',
  'تكلم معي',
];

/**
 * يفحص إذا النص أمر تشغيل/إيقاف للرد الصوتي.
 * @returns {'on'|'off'|null}
 */
function voiceToggleIntent(raw) {
  const t = normAr(raw);
  if (!t || t.length > 45) return null;
  // نفحص الإيقاف أول (لأن "لا ترد علي" تحتوي "رد علي")
  if (VOICE_OFF_PHRASES.some((p) => t.includes(p))) return 'off';
  if (VOICE_ON_PHRASES.some((p) => t.includes(p))) return 'on';
  return null;
}

/** يشغّل/يوقف الرد الصوتي فعلياً */
function setVoiceChat(on, by = '') {
  voiceChatOn = Boolean(on);
  if (voiceChat) {
    try {
      voiceChat.setEnabled(voiceChatOn);
    } catch {
      /* ignore */
    }
  }
  log(`🎚️ الرد الصوتي: ${voiceChatOn ? 'شغّال ✅' : 'متوقف ⛔'}${by ? ` — ${by}` : ''}`);
  return voiceChatOn;
}

/** ينطق جملة قصيرة (تأكيد أمر صوتي) */
async function speakLine(guild, line) {
  lastSpokenText = line;
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
// إيقاف الموسيقى (واضح)
const V_STOP_RE =
  /^(?:وقف|اوقف|وقفها|ايقاف|اوقفها|وقف الموسيقي|وقف الاغنيه|وقف الاغاني|طفي الموسيقي|اطفي الموسيقي|اقفل الموسيقي|قفل الموسيقي|سكر الموسيقي|سكرها)$/;
// كلمات قصيرة تعني "سكّت الصوت" — نقبلها فقط إذا فيه موسيقى شغالة
const V_STOP_WEAK_RE = /^(?:بس|خلاص|اسكت|سكت|تكفي)$/;
const V_SKIP_RE =
  /^(?:تخطي|تخطى|سكب|التالي|التاليه|اللي بعدها|غير الاغنيه|غير الموسيقي|بدلها|روح للي بعدها|skip|next)$/;
// «لا مو هذي» = الأغنية اللي شغّلها غلط -> نشغّل أفضل بديل من نفس البحث
const V_WRONG_RE =
  /^(?:لا مو هذي|لا مو هاذي|مو هذي|مو هاذي|مو ذي|مو هي|مو هذاك|مو هذي الاغنيه|لا لا مو هذي|غلط|خطا|مو غلط|هذي مو هي|هذي غلط|جيب غيرها|غيرها|ابي غيرها|ابغى غيرها|شي ثاني|جيب شي ثاني|مو هالاغنيه)$/;
const V_PAUSE_RE = /^(?:وقفها شوي|وقف الموسيقي شوي|اسكت شوي|بريح|بريك|pause)$/;
const V_RESUME_RE = /^(?:كمل|كملها|اكمل|واصل|شغلها مره ثانيه|شغل الموسيقي|resume|continue)$/;
const V_LOOP_RE = /^(?:كرر|كررها|اعد|اعيد|كرر الاغنيه|loop)$/;
const V_LOOP_OFF_RE = /^(?:الغي التكرار|وقف التكرار|لا تكرر|loop off)$/;
const V_VOL_UP_RE = /^(?:ارفع الصوت|علي الصوت|زود الصوت|ارفع شوي|صوتك واطي|ارفع صوتك|ارفع صوت)$/;
const V_VOL_DOWN_RE = /^(?:نزل الصوت|وطي الصوت|خفض الصوت|قلل الصوت|نزل شوي|وطي شوي|نزل صوتك)$/;
const V_GENERIC_SONG_RE = /^(?:لي|اغنيه|موسيقي|شي|شيء|اي شي|اغاني|شي زين)$/;
// طلب تشغيل أغنية بالصوت (يسمح بكلمة تمهيدية مثل "طيب" أو "يا")
const V_PLAY_RE =
  /^(?:(?:طيب|يا|هلا|يالله|يلا|لو سمحت|ممكن|الحين|هي|والله)\s+)*(?:شغّل لي|شغل لي|شغللي|شغلي|شغّللي|سمّعني|سمعني|ابغي اسمع|أبغي اسمع|ابي اسمع|أبي اسمع|شغل اغنية|شغّل أغنية|شغل اغنيه|شغّل|شغل|play me|play)\s*[:،\-]?\s*(.+)$/i;

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

  if (!wasIdle) {
    return { say: `ضفتها للطابور. الحين شغالة ${forSpeech(m.current?.title || '')}.` };
  }

  return {
    say: `طيب، شغالة الآن ${title}.`,
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
    autoRejoin = false;
    try {
      m0?.stopAll();
    } catch {
      /* ignore */
    }
    return {
      say: `طيب، اطلع من ${chName}. لو تبي أرجع قول: ادخل الروم.`,
      after: async () => {
        await new Promise((r) => setTimeout(r, 2500));
        autoRejoin = false;
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
    autoRejoin = true;
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
  if (V_STOP_RE.test(n) || (playing && V_STOP_WEAK_RE.test(n))) {
    if (!playing) return { say: 'ما فيه شي شغال الحين.' };
    try {
      m0.stopAll();
    } catch {
      /* ignore */
    }
    return { say: 'طيب، وقفت الموسيقى.' };
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
    query = query.replace(/^لي\s+/, '').trim();
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
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  if (t.includes('بوت')) return true;
  if (/bot\s*24\s*\/?\s*7/.test(t)) return true;
  if (/\bbot\b/.test(t) && t.length < 60) return true; // "بوت" المكتوبة بحروف انجليزية
  return false;
}

client.on('messageCreate', async (message) => {
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

    // أمر تشغيل/إيقاف الرد الصوتي (بالكتابة)
    const vIntent = voiceToggleIntent(text);
    if (vIntent) {
      const on = setVoiceChat(vIntent === 'on', `بالكتابة من ${message.author.tag}`);
      await message.reply({
        content: on
          ? '✅ شغّلت الرد الصوتي — تكلم في الروم وأنا أرد عليك بالصوت.'
          : '⛔ وقفت الرد الصوتي.\n' +
              'ترجعه بإحدى الطرق:\n' +
              '• `/voice` → **تشغيل**\n' +
              '• أو قل في الروم بالصوت: **«شغّل الرد الصوتي»**',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    // أولاً: هل هو أمر موسيقى؟ ("شغل لي ...") — ننفّذه فعلياً
    const musicResult = await runMusicFromChat(message, text);
    if (musicResult) {
      await message.reply({ content: musicResult, allowedMentions: { repliedUser: false } });
      return;
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
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('join').setDescription('يدخل الروم الصوتي ويقعد فيه'),
    new SlashCommandBuilder().setName('leave').setDescription('يطلع من الروم ويوقف الرجوع التلقائي'),
    new SlashCommandBuilder().setName('status').setDescription('يعرض حالة البوت'),
    new SlashCommandBuilder()
      .setName('voice')
      .setDescription('يشغّل أو يوقف الرد الصوتي في الروم 🎙️')
      .addStringOption((o) =>
        o
          .setName('الحالة')
          .setDescription('تشغيل أو إيقاف')
          .setRequired(true)
          .addChoices({ name: 'تشغيل', value: 'on' }, { name: 'إيقاف', value: 'off' }),
      ),
    ...music.buildCommands(),
    ...chat.buildCommands(),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));

  try {
    if (GUILD_ID) {
      await client.rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
        body: commands,
      });
      log(`تم تسجيل الأوامر في السيرفر ${GUILD_ID}.`);

      // نمسح أي أوامر عامة قديمة متروكة (مثل /music) عشان ما تلخبط المستخدم
      try {
        const existing = await client.rest.get(Routes.applicationCommands(client.user.id));
        if (Array.isArray(existing) && existing.length) {
          await client.rest.put(Routes.applicationCommands(client.user.id), { body: [] });
          log(`تم مسح ${existing.length} أمر عام قديم (${existing.map((c) => '/' + c.name).join(', ')}).`);
        }
      } catch (e) {
        log('تنبيه: ما قدرت أمسح الأوامر العامة:', e.message);
      }
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

  log(`📥 أمر: /${interaction.commandName} — من ${interaction.user.tag} (${interaction.guild?.name ?? 'خاص'})`);

  try {
    // أوامر الموسيقى أولاً (play/skip/pause/resume/stop/queue/nowplaying/volume)
    const handled = await music.handleInteraction(interaction, {
      defaultChannelId: VOICE_CHANNEL_ID,
    });
    if (handled) return;

    // أوامر المحادثة (chat/chatreset)
    const chatHandled = await chat.handleInteraction(interaction);
    if (chatHandled) return;

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

    if (interaction.commandName === 'voice') {
      const v = interaction.options.getString('الحالة');
      const on = setVoiceChat(v === 'on', `أمر /voice من ${interaction.user.username}`);
      await interaction.reply(
        on
          ? '✅ شغّلت الرد الصوتي — تكلم في الروم وأنا أرد عليك بالصوت.'
          : '⛔ وقفت الرد الصوتي.\n' +
              'ترجعه بإحدى الطرق:\n' +
              '• `/voice` → **تشغيل**\n' +
              '• أو قل في الروم بالصوت: **«شغّل الرد الصوتي»**',
      );
      return;
    }

    if (interaction.commandName === 'status') {
      const conn = interaction.guild ? getVoiceConnection(interaction.guild.id) : null;
      if (conn && conn.state.status === VoiceConnectionStatus.Ready) {
        await interaction.reply(
          `داخل الروم 🟢\n` +
            `اسم الروم: **${interaction.guild.channels.cache.get(conn.joinConfig.channelId)?.name ?? 'غير معروف'}**\n` +
            `زمن الاستجابة: ${Math.round(client.ws.ping)}ms\n` +
            `الرجوع التلقائي: ${autoRejoin ? 'مفعّل' : 'متوقف'}\n` +
            `الرد الصوتي: ${voiceChatOn ? 'مفعّل ✅' : 'متوقف ⛔'}\n` +
            `السوالف: ${CHAT_ENABLED ? 'مفعّل' : 'متوقف'}\n` +
            `ذكاء اصطناعي: ${
              chat.hasAI()
                ? `${chat.model || 'متصل'} — موديلات متاحة: ${chat.stats().gemini + chat.stats().groq}`
                : 'لا (ردود جاهزة)'
            }`,
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
    return;
  }

  // شبكة أمان: أي أمر ما تعاملنا معه نرد عليه عشان ما يطلع "التطبيق ما استجاب"
  if (!interaction.replied && !interaction.deferred) {
    log(`⚠️ أمر غير معروف: /${interaction.commandName}`);
    await interaction
      .reply({
        content:
          `ما عرفت الأمر \`/${interaction.commandName}\` 😅\n` +
          'الأوامر المتاحة: `/play` `/skip` `/pause` `/resume` `/stop` `/queue` `/nowplaying` `/volume` `/join` `/leave` `/status` `/chat`',
        ephemeral: true,
      })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// الفحص الدوري
// ---------------------------------------------------------------------------
setInterval(() => {
  ensureConnected().catch((e) => log('خطأ في الفحص الدوري:', e.message));

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
  module.exports = { normAr, voiceToggleIntent, forSpeech, runVoiceCommand, looksLikeEcho, translitArabic };
}
