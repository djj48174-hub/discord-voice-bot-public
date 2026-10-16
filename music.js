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
const { PassThrough, Readable } = require('stream');
const fs = require('fs');
const os = require('os');
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

let FFMPEG;
if (process.env.FFMPEG_PATH) {
  // مسار صريح (نستخدمه في Docker -> ffmpeg النظام)
  FFMPEG = process.env.FFMPEG_PATH;
} else {
  FFMPEG = 'ffmpeg'; // من PATH
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg && fs.existsSync(staticFfmpeg)) FFMPEG = staticFfmpeg;
  } catch {
    /* نستخدم ffmpeg من النظام */
  }
}

const YTDLP = resolveYtDlp();
const IS_WIN = process.platform === 'win32';

function extraYtdlpArgs() {
  const args = ['--no-warnings', '--no-check-certificates'];
  const cookieFile = cookieFilePath();
  if (cookieFile) args.push('--cookies', cookieFile);
  if (process.env.YTDLP_EXTRA_ARGS) {
    args.push(...process.env.YTDLP_EXTRA_ARGS.split(' ').filter(Boolean));
  }
  return args;
}

// ---------------------------------------------------------------------------
// تجاوز حجب يوتيوب ("Sign in to confirm you're not a bot")
// نجرّب عدة "عملاء" (clients) بالترتيب، وأول واحد ينجح نعتمده.
// ---------------------------------------------------------------------------
const CLIENT_CANDIDATES = (
  process.env.YTDLP_CLIENTS ||
  'android,tv,android_vr,ios,mweb,tv_simply,web_embedded,web_safari,web,default'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let activeClient = (process.env.YTDLP_CLIENT || '').trim() || null;
const clientResults = new Map(); // client -> true/false (نتيجة آخر تجربة)
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS || 15000);

function clientArgs(client) {
  if (!client || client === 'default') return [];
  return ['--extractor-args', `youtube:player_client=${client}`];
}

/** ملف الكوكيز: إمّا مسار جاهز أو محتوى base64 في متغيّر البيئة */
function cookieFilePath() {
  const p = (process.env.YTDLP_COOKIES || '').trim();
  if (p && fs.existsSync(p)) return p;

  const b64 = (process.env.YTDLP_COOKIES_B64 || '').trim();
  if (b64) {
    try {
      const target = path.join(os.tmpdir(), 'yt-cookies.txt');
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, Buffer.from(b64, 'base64').toString('utf8'));
      }
      return target;
    } catch (e) {
      log('ما قدرت أكتب ملف الكوكيز:', e.message);
    }
  }
  return null;
}

/** يجرّب عميلاً واحداً: هل يوصل فعلاً بايتات صوت؟ */
function probeClient(client, testUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill(IS_WIN ? undefined : 'SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ client, ok, why });
    };

    const proc = spawn(
      YTDLP,
      [
        '-f',
        'bestaudio/best',
        '-o',
        '-',
        '--no-playlist',
        '--no-part',
        '--no-progress',
        ...clientArgs(client),
        ...extraYtdlpArgs(),
        testUrl,
      ],
      { windowsHide: true },
    );

    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 2000) err = err.slice(-1200);
    });
    proc.stdout.once('data', () => finish(true));
    proc.on('error', (e) => finish(false, e.message));
    proc.on('close', (code) => {
      const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      finish(false, last || `exit ${code}`);
    });

    const timer = setTimeout(() => finish(false, 'انتهت المدة'), STREAM_TIMEOUT_MS);
  });
}

/**
 * يفحص العملاء بالترتيب ويختار أول واحد يشتغل.
 */
async function ensureWorkingClient(force = false) {
  if (!force && activeClient && clientResults.get(activeClient) === true) return activeClient;

  const testUrl = process.env.YTDLP_PROBE_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const order = activeClient
    ? [activeClient, ...CLIENT_CANDIDATES.filter((c) => c !== activeClient)]
    : CLIENT_CANDIDATES;

  for (const client of order) {
    if (!force && clientResults.get(client) === false) continue;
    const r = await probeClient(client, testUrl);
    clientResults.set(client, r.ok);
    if (r.ok) {
      activeClient = client;
      log(`✅ عميل يوتيوب شغّال: ${client}`);
      return client;
    }
    log(`❌ عميل يوتيوب فاشل: ${client} — ${r.why || ''}`);
  }
  log('⚠️ كل عملاء يوتيوب فشلوا — السيرفر يحتاج كوكيز.');
  activeClient = null;
  return null;
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
  const url =
    e.webpage_url || e.original_url || (id ? `https://www.youtube.com/watch?v=${id}` : e.url);
  const isSc = /soundcloud\.com|snd\.sc/i.test(url || '');
  const isYt = /youtube\.com|youtu\.be/i.test(url || '');
  return {
    id,
    title: e.title || 'بدون عنوان',
    url,
    duration: Number(e.duration) || 0,
    uploader: e.uploader || e.channel || e.artist || '',
    source: isSc ? 'soundcloud' : isYt ? 'youtube' : 'other',
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

// ---------------------------------------------------------------------------
// ساوند كلاود — مصدر بديل لما يوتيوب يرفض الفيديو
// (كثير مقاطع يوتيوب ترجع "Sign in to confirm you're not a bot" من السيرفرات،
//  بينما ساوند كلاود يشتغل عادي.)
// ---------------------------------------------------------------------------
async function searchSoundCloud(query, limit = 3) {
  const { out, err, code } = await runYtDlp([
    `scsearch${limit}:${query}`,
    '--dump-single-json',
    '--flat-playlist',
    '--no-playlist',
    ...extraYtdlpArgs(),
  ]);

  if (code !== 0) {
    const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    throw new Error(last || 'فشل البحث في ساوند كلاود');
  }

  let json;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error('ما قدرت أقرأ نتيجة ساوند كلاود');
  }

  const entries = (json.entries && json.entries.length ? json.entries : [json]).filter(Boolean);
  return entries
    .map((e) => ({
      id: e.id,
      title: e.title || 'بدون عنوان',
      url: e.webpage_url || e.url || '',
      duration: Number(e.duration) || 0,
      uploader: e.uploader || e.artist || e.channel || '',
      artwork: e.thumbnail || null,
      source: 'soundcloud',
    }))
    .filter((s) => s.url);
}

/** يبحث عن نفس الأغنية في ساوند كلاود ويرجّع أول نتيجة */
async function findOnSoundCloud(song) {
  const q = [song.title, song.uploader].filter(Boolean).join(' ').trim();
  if (!q) return null;
  const results = await searchSoundCloud(q, 3);
  return results[0] || null;
}

async function resolveQuery(query, maxPlaylist = 25) {
  const q = query.trim();
  const isUrl = /^https?:\/\//i.test(q);

  if (isUrl) {
    const isSoundCloud = /soundcloud\.com|snd\.sc/i.test(q);

    const { out, err, code } = await runYtDlp([
      '--dump-single-json',
      '--no-warnings',
      ...extraYtdlpArgs(),
      q,
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
    const single = mapEntry(json);
    if (isSoundCloud) single.source = 'soundcloud';
    return { type: 'single', songs: [single] };
  }

  // اسم أغنية -> ساوند كلاود أولاً.
  // السبب: يوتيوب يحجب مقاطع كثيرة من IP السيرفرات ("Sign in to confirm you're not a bot")
  //         بينما ساوند كلاود يشتغل عادي.
  const preferYouTube = /^youtube$/i.test((process.env.PREFER_SOURCE || '').trim());
  if (!preferYouTube) {
    try {
      const sc = await searchSoundCloud(q, 1);
      if (sc.length) {
        log(`🔎 ساوند كلاود: ${sc[0].title}`);
        return { type: 'single', songs: [{ ...sc[0], source: 'soundcloud' }] };
      }
    } catch (e) {
      log(`⚠️ بحث ساوند كلاود فشل (بنجرّب يوتيوب): ${String(e.message).slice(0, 90)}`);
    }
  }

  const results = await searchSongs(q, 1);
  if (!results.length) throw new Error('ما لقيت أي نتيجة لهذا الاسم');
  return { type: 'single', songs: [{ ...results[0], source: 'youtube' }] };
}

// ---------------------------------------------------------------------------
// بث الصوت: yt-dlp -> ffmpeg (Ogg Opus)
// ---------------------------------------------------------------------------
function createAudioStream(url, volume, client = null) {
  const ytdlp = spawn(
    YTDLP,
    [
      '-f',
      'bestaudio/best',
      '-o',
      '-',
      '--no-playlist',
      '--no-part',
      '--no-progress',
      ...clientArgs(client),
      ...extraYtdlpArgs(),
      url,
    ],
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
    this.textChannel = null;
    this.startedAt = 0;
    this.repeat = false;          // تكرار الأغنية الحالية
    this._suppressRepeat = false; // نتجاهل التكرار لما نتخطى أو نغيّر الصوت
    this._voicePaused = false;    // الموسيقى موقوفة مؤقتاً عشان البوت يرد صوتياً
    this._didPlay = false;        // هل الأغنية الحالية اشتغلت فعلاً؟
    this._lastEndedAt = 0;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on('stateChange', (_old, next) => {
      if (next.status === AudioPlayerStatus.Playing) this._didPlay = true;
    });

    this.player.on(AudioPlayerStatus.Idle, () => this._onEnded());

    this.player.on('error', (err) => {
      log('player error:', err.message);
      this._onEnded();
    });
  }

  /** يننادى لما تخلص الأغنية (أو تفشل) */
  _onEnded() {
    // حماية من الاستدعاء المزدوج (Idle + error)
    const now = Date.now();
    if (now - this._lastEndedAt < 300) return;
    this._lastEndedAt = now;

    if (this.currentStream) {
      this.currentStream.kill();
      this.currentStream = null;
    }

    const suppress = this._suppressRepeat;
    this._suppressRepeat = false;

    // التكرار: نرجّع الأغنية نفسها لأول الطابور
    // (بس لو فعلاً اشتغلت، ومو حالة تخطٍّ)
    if (this.repeat && this.current && !suppress && this._didPlay) {
      this.songs.unshift(this.current);
    }

    this.current = null;
    this._didPlay = false;
    setTimeout(() => {
      this._drainQueue().catch((e) => log('خطأ في تشغيل الطابور:', e.message));
    }, 200);
  }

  /** يشغّل من الطابور لين ينجح، بحد أقصى 3 محاولات (عشان ما يعلق بالحجب) */
  async _drainQueue(maxAttempts = 3) {
    for (let i = 0; i < maxAttempts; i++) {
      const r = await this.playNext();
      if (r.ok || r.empty) return;
    }
    this.notify(
      '❌ ما قدرت أشغّل الأغاني المتبقية.\n' +
        'جرّب `/play` مرة ثانية باسم مختلف، أو الصق رابطاً مباشراً.',
    );
  }

  attach(connection) {
    this.connection = connection;
    connection.subscribe(this.player);
  }

  /**
   * يشغّل أغنية، ويجرّب كل عملاء يوتيوب بالترتيب لين ينجح واحد.
   * يرجّع true فقط لو وصل صوت حقيقي فعلاً.
   */
  async play(song) {
    // مصدر غير يوتيوب (ساوند كلاود) -> نشغّل مباشرة، ما فيه عملاء نجرّبهم
    const isYouTube = /youtube\.com|youtu\.be/i.test(song.url || '');
    if (!isYouTube) {
      this.current = song;
      if (await this._tryPlay(song, null)) return true;

      // فشل ساوند كلاود؟ نجرب نفس الاسم في يوتيوب كحل أخير
      if (!song.altTried) {
        song.altTried = true;
        try {
          const results = await searchSongs(song.title, 1);
          if (results[0]) {
            const alt = { ...results[0], source: 'youtube' };
            log(`🔄 ساوند كلاود ما نفع — أجرّب يوتيوب: «${alt.title}»`);
            if (await this._tryPlay(alt, activeClient || 'android')) {
              Object.assign(song, { url: alt.url, id: alt.id, title: alt.title, source: 'youtube' });
              return true;
            }
          }
        } catch {
          /* تجاهل */
        }
      }

      this.current = null;
      this.currentStream = null;
      return false;
    }

    const order = activeClient
      ? [activeClient, ...CLIENT_CANDIDATES.filter((c) => c !== activeClient)]
      : CLIENT_CANDIDATES;

    const tried = [];
    for (const client of order) {
      if (clientResults.get(client) === false) continue; // فشل قبل كذا — نتخطاه
      tried.push(client);
      const ok = await this._tryPlay(song, client);
      clientResults.set(client, ok);
      if (ok) {
        if (client !== activeClient) {
          activeClient = client;
          log(`✅ اعتمدت عميل يوتيوب: ${client}`);
        }
        return true;
      }
      log(`↩️ العميل ${client} ما نجح — أجرّب غيره`);
    }

    // لو كلهم مسجّلين فشل، نصفّر النتائج ونعيد المحاولة مرة واحدة
    if (!tried.length) {
      log('كل العملاء مسجّلين فشل — أعيد الفحص من جديد');
      clientResults.clear();
      activeClient = null;
      return this.play(song);
    }

    // يوتيوب رفض الفيديو -> نجرّب نفس الأغنية في ساوند كلاود (بدون كوكيز)
    if (!song.altTried && !/soundcloud\.com/i.test(song.url)) {
      song.altTried = true;
      const alt = await findOnSoundCloud(song).catch((e) => {
        log(`⚠️ بحث ساوند كلاود فشل: ${String(e.message).slice(0, 80)}`);
        return null;
      });

      if (alt) {
        const before = { url: song.url, title: song.title, uploader: song.uploader };
        song.url = alt.url;
        song.title = alt.title;
        if (alt.uploader) song.uploader = alt.uploader;

        log(`🔄 يوتيوب رافضها — أجرّب ساوند كلاود: «${alt.title}»`);
        if (await this._tryPlay(song, null)) {
          song.source = 'soundcloud';
          return true;
        }
        Object.assign(song, before); // رجّع بيانات يوتيوب للرسالة
      }
    }

    this.current = null;
    this.currentStream = null;
    return false;
  }

  /** محاولة تشغيل واحدة بعميل محدّد — يرجّع true لو وصل أول بايت صوت */
  _tryPlay(song, client) {
    return new Promise((resolve) => {
      this.current = song;
      this.startedAt = Date.now();
      this._didPlay = false;

      const { stream, kill } = createAudioStream(song.url, this.volume, client);

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        log(`⏱️ العميل ${client}: ما وصل صوت خلال ${Math.round(STREAM_TIMEOUT_MS / 1000)} ثانية`);
        try {
          kill();
        } catch {
          /* ignore */
        }
        finish(false);
      }, STREAM_TIMEOUT_MS);

      // ننتظر أول بايت صوت حقيقي قبل ما نعتبر إنها اشتغلت
      stream.once('data', (chunk) => {
        if (settled) return;
        clearTimeout(timer);

        const pt = new PassThrough();
        pt.write(chunk);
        stream.pipe(pt);

        this.currentStream = { kill };
        const resource = createAudioResource(pt, { inputType: StreamType.OggOpus });
        this.player.play(resource);
        log(`▶️ تشغيل: ${song.title}  (client=${client})`);
        finish(true);
      });

      const bail = () => {
        if (settled) return;
        try {
          kill();
        } catch {
          /* ignore */
        }
        finish(false);
      };
      stream.once('end', bail);
      stream.once('error', bail);
      stream.once('close', bail);
    });
  }

  /** يشغّل اللي بعدها ويرجّع { ok, empty, song } */
  async playNext() {
    if (!this.songs.length) {
      this.current = null;
      return { ok: false, empty: true };
    }
    const next = this.songs.shift();
    const ok = await this.play(next);
    if (!ok) log(`❌ ما قدرت أشغّل: ${next.title}`);
    return { ok, empty: false, song: next };
  }

  /** يستمع لحالة المشغّل ويرجّع true أول ما يبدأ التشغيل فعلياً */
  waitForPlaying(timeoutMs = 20000) {
    if (this.player.state.status === AudioPlayerStatus.Playing) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.player.off('stateChange', onState);
        resolve(val);
      };
      const onState = (_old, next) => {
        if (next.status === AudioPlayerStatus.Playing) return finish(true);
        // رجع Idle وما بقي شي بالطابور -> يعني فشل التشغيل
        if (next.status === AudioPlayerStatus.Idle && !this.current && !this.songs.length) {
          return finish(false);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.player.on('stateChange', onState);
    });
  }

  /** يشغّل اللي بعدها وينتظر النتيجة: true = اشتغلت، false = فشلت */
  async startAndWait(timeoutMs = 25000) {
    const r = await this.playNext();
    if (!r.ok) return false;
    return this.waitForPlaying(timeoutMs);
  }

  /** حفظ قناة نصية لإرسال التنبيهات */
  setTextChannel(ch) {
    this.textChannel = ch || null;
  }

  /** يرسل تنبيه للقناة النصية (إن وُجدت) */
  notify(text) {
    try {
      if (this.textChannel) this.textChannel.send(text).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  skip() {
    if (this.currentStream) {
      this._suppressRepeat = true; // التخطي ما يكرر نفس الأغنية
      this.player.stop(true);
    }
  }

  stopAll() {
    this.songs = [];
    this.current = null;
    this._suppressRepeat = true;
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
        this._suppressRepeat = true; // عشان ما تتكرر مرتين
        this.player.stop(true);
      } else {
        this.playNext();
      }
    }
  }

  toggleLoop(force) {
    this.repeat = typeof force === 'boolean' ? force : !this.repeat;
    return this.repeat;
  }

  // -------------------------------------------------------------------------
  // الرد الصوتي: يوقف الموسيقى، ينطق الرد، وبعدها يرجع الموسيقى
  // -------------------------------------------------------------------------
  pauseForVoice() {
    this._voicePaused = true;
    const st = this.player.state.status;
    if (st === AudioPlayerStatus.Playing || st === AudioPlayerStatus.Paused) {
      try {
        this.player.pause();
      } catch {
        /* ignore */
      }
    }
  }

  resumeAfterVoice() {
    if (!this._voicePaused) return;
    this._voicePaused = false;
    if (!this.current) return;
    // المورد الصوتي ما يرجع بعد الإيقاف — نعيد الأغنية من البداية
    this.songs.unshift(this.current);
    this._suppressRepeat = true;
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    this.playNext();
  }

  /**
   * ينطق نصاً (Ogg Opus 48kHz — نفس صيغة الموسيقى بالضبط) ويرجّع true لو اشتغل.
   */
  speak(oggBuffer, volume = 1) {
    this.pauseForVoice();
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.resumeAfterVoice();
        resolve(ok);
      };

      const onIdle = () => finish(true);
      this.player.once(AudioPlayerStatus.Idle, onIdle);
      const timer = setTimeout(() => finish(false), 90000);

      try {
        // نفس طريقة الموسيقى بالضبط: PassThrough بدون inlineVolume
        // (inlineVolume يفسد حزم Opus المشفّرة)
        const pt = new PassThrough();
        pt.end(oggBuffer);
        const resource = createAudioResource(pt, { inputType: StreamType.OggOpus });
        if (volume !== 1) resource.volume.setVolume(volume);
        this.player.play(resource);
        log(`🔊 نطقنا (${oggBuffer.length} بايت)`);
      } catch (e) {
        log('⚠️ فشل النطق:', e.message);
        finish(false);
      }
    });
  }

  /** يوقف كل شي بما فيه الموسيقى (للمحادثة الصوتية) */
  suspendForVoice() {
    this._voicePaused = true;
    this.songs = [];
    this.current = null;
    this._suppressRepeat = true;
    if (this.currentStream) {
      try {
        this.currentStream.kill();
      } catch {
        /* ignore */
      }
      this.currentStream = null;
    }
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
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
    .setTitle(music.repeat ? '🎶 شغّال الآن 🔁 (تكرار)' : '🎶 شغّال الآن')
    .setDescription(`**[${s.title}](${s.url})**`)
    .addFields(
      { name: 'المدة', value: formatDuration(s.duration), inline: true },
      { name: 'الصوت', value: `${Math.round(music.volume * 100)}%`, inline: true },
      { name: 'التكرار', value: music.repeat ? 'مفعّل 🔁' : 'متوقف', inline: true },
    );
  if (s.uploader) embed.addFields({ name: 'الصوت من', value: s.uploader, inline: true });
  const thumb = s.source === 'youtube' ? youtubeThumb(s.id) : s.artwork || youtubeThumb(s.id);
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
      .setDescription('يشغّل أغنية (اكتب الاسم أو الصق رابط يوتيوب / ساوند كلاود)')
      .addStringOption((o) =>
        o.setName('الاسم').setDescription('اسم الأغنية أو الرابط').setRequired(true),
      )
      .toJSON(),
    new SlashCommandBuilder().setName('skip').setDescription('يتجاوز الأغنية الحالية').toJSON(),
    new SlashCommandBuilder().setName('pause').setDescription('يوقف التشغيل مؤقتاً').toJSON(),
    new SlashCommandBuilder().setName('resume').setDescription('يكمل التشغيل').toJSON(),
    new SlashCommandBuilder().setName('stop').setDescription('يوقف الموسيقى ويفضي الطابور').toJSON(),
    new SlashCommandBuilder()
      .setName('loop')
      .setDescription('يكرر الأغنية الحالية (تشغيل/إيقاف التكرار)')
      .addStringOption((o) =>
        o
          .setName('الوضع')
          .setDescription('اختياري — بدونه يقلب التكرار')
          .setRequired(false)
          .addChoices(
            { name: 'تشغيل التكرار 🔁', value: 'on' },
            { name: 'إيقاف التكرار ⏹️', value: 'off' },
          ),
      )
      .toJSON(),
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

const MUSIC_COMMANDS = [
  'play',
  'skip',
  'pause',
  'resume',
  'stop',
  'loop',
  'queue',
  'nowplaying',
  'volume',
];

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
    m.setTextChannel(interaction.channel);
    music.setTextChannel(interaction.channel);

    // هل كان في شي شغّال قبل ما يضيف؟
    const wasIdle = !m.current;

    if (resolved.type === 'playlist') {
      m.songs.push(...resolved.songs);
      if (!wasIdle) {
        await interaction.editReply(
          `➕ أضفت **${resolved.songs.length}** أغنية من \`${resolved.name}\` إلى الطابور.`,
        );
      }
    } else {
      const song = resolved.songs[0];
      m.songs.push(song);
      if (!wasIdle) {
        await interaction.editReply(
          `➕ أضفت **${song.title}** للمركز **#${m.songs.length}** في الطابور.`,
        );
      }
    }

    if (wasIdle) {
      // نعرض رسالة مؤقتة، بعدين ننتظر لين يشتغل فعلياً ونأكد
      await interaction.editReply(
        resolved.type === 'playlist'
          ? `🔎 جاري تشغيل **${resolved.songs.length}** أغنية من \`${resolved.name}\` ...`
          : `🔎 جاري تشغيل **${resolved.songs[0].title}** ...`,
      );

      const started = await m.startAndWait(60000);

      if (started && m.current) {
        await interaction.editReply({
          content: '▶️ **شغّال الآن**',
          embeds: [nowPlayingEmbed(m)],
        });
      } else if (started) {
        await interaction.editReply(`▶️ **شغّال الآن**: ${resolved.songs[0].title}`);
      } else {
        await interaction.editReply(
          '❌ ما قدرت أشغّل هذي الأغنية.\n' +
            'جرّب تكتب اسمها بطريقة ثانية، أو الصق رابطاً مباشراً (يوتيوب أو ساوند كلاود).',
        );
      }
    }
    return true;
  }

  // أمر التكرار — يشتغل حتى لو ما فيه شي شغّال حالياً
  if (name === 'loop') {
    const mode = interaction.options.getString('الوضع');
    const on = music.toggleLoop(mode ? mode === 'on' : undefined);
    await interaction.reply(
      on
        ? '🔁 **التكرار مفعّل** — راح يعيد الأغنية نفسها لما تخلص.'
        : '⏹️ **التكرار متوقف** — راح ينتقل للأغنية اللي بعدها.',
    );
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

// ---------------------------------------------------------------------------
// فحص الأدوات (يُنادى عند التشغيل للتأكد إن الصوت جاهز)
// ---------------------------------------------------------------------------
function diagnostics() {
  const { execFileSync } = require('child_process');
  const result = { ytdlpPath: YTDLP, ffmpegPath: FFMPEG, ytdlpVersion: null, ffmpegVersion: null, ok: false };
  try {
    result.ytdlpVersion = execFileSync(YTDLP, ['--version'], { timeout: 30000 }).toString().trim();
  } catch (e) {
    result.ytdlpVersion = `خطأ: ${e.message}`;
  }
  try {
    result.ffmpegVersion = execFileSync(FFMPEG, ['-version'], { timeout: 30000 })
      .toString()
      .split('\n')[0]
      .trim();
  } catch (e) {
    result.ffmpegVersion = `خطأ: ${e.message}`;
  }
  result.ok = Boolean(result.ytdlpVersion && !result.ytdlpVersion.startsWith('خطأ')) &&
    Boolean(result.ffmpegVersion && !result.ffmpegVersion.startsWith('خطأ'));
  log(`yt-dlp: ${result.ytdlpVersion}  |  ffmpeg: ${result.ffmpegVersion}`);
  log(result.ok ? '✅ أدوات الصوت جاهزة' : '⚠️ فيه أداة صوت ناقصة — الموسيقى ما بتشتغل');
  return result;
}

// ---------------------------------------------------------------------------
// تشخيص المصادر (يستخدمه /diag عشان نعرف وش يشتغل من هذا السيرفر)
// ---------------------------------------------------------------------------
/** يجرّب تحميل فعلي ويرجّع كم بايت وصل قبل ما نوقفه */
function probeDownload(extraArgs, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const proc = spawn(
      YTDLP,
      [
        '-f',
        'bestaudio/best',
        '-o',
        '-',
        '--no-playlist',
        '--no-part',
        '--no-progress',
        '--no-warnings',
        ...extraYtdlpArgs(),
        ...extraArgs,
      ],
      { windowsHide: true },
    );

    let err = '';
    let out = '';
    let bytes = 0;
    let done = false;

    const finish = (ok, why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill(IS_WIN ? undefined : 'SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ ok, bytes, out, why: why || '' });
    };

    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 3000) err = err.slice(-1500);
    });
    proc.stdout.on('data', (d) => {
      bytes += d.length;
      if (out.length < 400000) out += d.toString();
      if (bytes > 60000) finish(true); // وصلنا بايتات كافية
    });
    proc.on('error', (e) => finish(false, e.message));
    proc.on('close', (code) => {
      const last = err.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      finish(bytes > 0, last || `exit ${code}`);
    });

    const timer = setTimeout(() => finish(bytes > 0, 'انتهت المدة'), timeoutMs);
  });
}

/** يفحص كل عملاء يوتيوب + ساوند كلاود من هذا السيرفر */
async function diagnose(opts = {}) {
  const ytUrl = process.env.YTDLP_PROBE_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const clients = [...new Set([...CLIENT_CANDIDATES, 'default'])];
  const q = opts.query || process.env.DIAG_QUERY || 'music';
  const vids = String(opts.vids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const youtube = await Promise.all(
    clients.map(async (c) => {
      const r = await probeDownload([...clientArgs(c), ytUrl], 15000);
      return { client: c, ok: r.ok, bytes: r.bytes, why: r.ok ? '' : r.why };
    }),
  );

  // نفس الأغاني اللي فشلت عند المستخدم (بالعميل الافتراضي)
  const userVideos = [];
  for (const v of vids) {
    const r = await probeDownload([`https://www.youtube.com/watch?v=${v}`], 20000);
    userVideos.push({ vid: v, ok: r.ok, bytes: r.bytes, why: r.ok ? '' : r.why });
  }

  // ساوند كلاود: بحث ثم تحميل
  let scTitle = null;
  let scUrl = null;
  let scSearchOk = false;
  let scSearchWhy = '';
  let scResult = { ok: false, why: 'ما فيه نتيجة' };

  try {
    const results = await searchSoundCloud(q, 3);
    scSearchOk = results.length > 0;
    if (results[0]) {
      scTitle = results[0].title;
      scUrl = results[0].url;
    } else {
      scSearchWhy = 'البحث رجّع صفر نتائج';
    }
  } catch (e) {
    scSearchWhy = String(e.message).slice(0, 250);
  }

  if (scUrl) {
    const r = await probeDownload([scUrl], 20000);
    scResult = { ok: r.ok, bytes: r.bytes, why: r.ok ? '' : r.why };
  }

  return {
    at: new Date().toISOString(),
    cookies: Boolean(cookieFilePath()),
    activeClient,
    userVideos,
    youtube,
    soundcloud: {
      searchQuery: q,
      searchOk: scSearchOk,
      searchWhy: scSearchWhy,
      firstTitle: scTitle,
      firstUrl: scUrl,
      download: scResult,
    },
  };
}

module.exports = {
  diagnose,
  buildCommands,
  handleInteraction,
  getQueue,
  hasQueue,
  attachPlayerToConnection,
  getOrCreateConnection,
  searchSongs,
  searchSoundCloud,
  resolveQuery,
  formatDuration,
  diagnostics,
  ensureWorkingClient,
  getActiveClient: () => activeClient,
  createAudioStream,
};
