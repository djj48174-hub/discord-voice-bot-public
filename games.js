'use strict';
/**
 * 🎮 ألعاب السيرفر — كل لعبة لها أمر تشغيل وأمر إيقاف
 *
 * اللعبة              | تشغيل        | إيقاف
 * --------------------|--------------|----------------
 * الروليت الروسي      | /roulette    | /roulette_off
 * خمّن أوست الأنمي    | /guess       | /guess_off
 * تحدي الضحك/الصمت    | /laugh       | /laugh_off
 * لوحة تسلّط ساخرة    | /roast       | /roast_off
 * تقليد الأعضاء       | /mimic       | /mimic_off
 * كازينو الصرامي      | /casino      | /casino_off
 *                     | /slot /dice /bet /rich
 * قائمة الألعاب       | /games       |
 *
 * ملاحظة: كل شي مزاح — العقوبات مؤقتة وترجع لحالها.
 */
const { SlashCommandBuilder } = require('discord.js');

// ---------------------------------------------------------------------------
// التبعيات (يجيها من bot.js)
// ---------------------------------------------------------------------------
let D = {
  music: null,
  log: () => {},
  speakLine: async () => {},
  botChannelOf: () => null,
};
function init(d = {}) {
  D = { ...D, ...d };
}

// ---------------------------------------------------------------------------
// أدوات عامة
// ---------------------------------------------------------------------------
const nowMs = () => Date.now();
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const SPLIT = /[\u064B-\u0652\u0670\u0640]/g;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(SPLIT, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    // «ناااروتو» → «ناروتو» (تمطيط الحروف)
    .replace(/(.)\1{2,}/gu, '$1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function coins(n) {
  return `${Math.round(n).toLocaleString('en-US')} 🪙`;
}

// ---------------------------------------------------------------------------
// حالة كل سيرفر
// ---------------------------------------------------------------------------
const S = new Map();
function st(gid) {
  const id = String(gid || '');
  let s = S.get(id);
  if (!s) {
    s = {
      guild: null,
      channel: null, // روم الكتابة اللي فيه اللعبة
      roulette: null,
      guess: null,
      laugh: null,
      mimic: null,
      roastOn: true,
      stats: new Map(), // userId -> {name, spoke, voiceMs, interrupts, lastAt}
      coins: new Map(), // userId -> {name, coins, lastEarn}
      bets: new Map(), // userId(target) -> {fromId, fromName, amount}
    };
    S.set(id, s);
  }
  return s;
}

function statOf(s, userId, name) {
  let x = s.stats.get(userId);
  if (!x) {
    x = { name: name || 'مجهول', spoke: 0, voiceMs: 0, interrupts: 0, lastAt: 0 };
    s.stats.set(userId, x);
  }
  if (name) x.name = name;
  return x;
}
function balOf(s, userId, name) {
  let x = s.coins.get(userId);
  if (!x) {
    x = { name: name || 'مجهول', coins: 500, lastEarn: 0 };
    s.coins.set(userId, x);
  }
  if (name) x.name = name;
  return x;
}
function clearTimer(o, k) {
  if (o && o[k]) {
    clearTimeout(o[k]);
    o[k] = null;
  }
}
async function send(channel, text) {
  if (!channel) return null;
  try {
    return await channel.send(text);
  } catch {
    return null;
  }
}
function speak(guild, line) {
  if (!guild) return;
  Promise.resolve(D.speakLine(guild, line)).catch(() => {});
}

// ---------------------------------------------------------------------------
// 🎵 1) خمّن أوست الأنمي
// ---------------------------------------------------------------------------
const ANIME = [
  { id: 'naruto-silhouette', anime: 'ناروتو شيبودن', animeEn: 'Naruto', title: 'Silhouette', artist: 'KANA-BOON', q: 'Naruto Shippuden Silhouette KANA-BOON', al: ['ناروتو', 'ناروتو شيبودن', 'naruto', 'silhouette', 'سيلويت'] },
  { id: 'naruto-guren', anime: 'ناروتو شيبودن', animeEn: 'Naruto', title: 'Guren', artist: 'Kenshi Yonezu', q: 'Naruto Shippuden Guren Kenshi Yonezu', al: ['ناروتو', 'naruto', 'guren', 'جورين'] },
  { id: 'naruto-sadness', anime: 'ناروتو', animeEn: 'Naruto', title: 'Sadness and Sorrow', artist: 'Toshio Masuda', q: 'Naruto Sadness and Sorrow', al: ['ناروتو', 'naruto', 'sadness and sorrow', 'sadness', 'حزن', 'موسيقى ناروتو'] },
  { id: 'naruto-haruka', anime: 'ناروتو', animeEn: 'Naruto', title: 'Haruka Kanata', artist: 'Asian Kung-Fu Generation', q: 'Naruto Haruka Kanata Asian Kung Fu Generation', al: ['ناروتو', 'naruto', 'haruka kanata', 'هاروكا'] },
  { id: 'aot-guren', anime: 'هجوم العملاق', animeEn: 'Attack on Titan', title: 'Guren no Yumiya', artist: 'Linked Horizon', q: 'Attack on Titan Guren no Yumiya Linked Horizon', al: ['هجوم العملاق', 'هجوم', 'اتاك اون تايتن', 'attack on titan', 'aot', 'guren no yumiya', 'العملاق'] },
  { id: 'aot-vogel', anime: 'هجوم العملاق', animeEn: 'Attack on Titan', title: 'Vogel im Kafig', artist: 'Hiroyuki Sawano', q: 'Attack on Titan Vogel im Kafig', al: ['هجوم العملاق', 'attack on titan', 'aot', 'vogel', 'فوجل'] },
  { id: 'aot-sasageyo', anime: 'هجوم العملاق', animeEn: 'Attack on Titan', title: 'Shinzou wo Sasageyo', artist: 'Linked Horizon', q: 'Attack on Titan Shinzou wo Sasageyo Linked Horizon', al: ['هجوم العملاق', 'attack on titan', 'aot', 'sasageyo', 'ساساجيو'] },
  { id: 'ds-gurenge', anime: 'قاتل الشياطين', animeEn: 'Demon Slayer', title: 'Gurenge', artist: 'LiSA', q: 'Gurenge Demon Slayer LiSA', al: ['قاتل الشياطين', 'ديمون سلاير', 'demon slayer', 'kimetsu', 'gurenge', 'جورينج'] },
  { id: 'ds-sanka', anime: 'قاتل الشياطين', animeEn: 'Demon Slayer', title: 'Zankyou Sanka', artist: 'Aimer', q: 'Demon Slayer Zankyou Sanka Aimer', al: ['قاتل الشياطين', 'demon slayer', 'kimetsu', 'zankyou', 'sanka'] },
  { id: 'jjk-kaikai', anime: 'جوجوتسو كايسن', animeEn: 'Jujutsu Kaisen', title: 'Kaikai Kitan', artist: 'Eve', q: 'Jujutsu Kaisen Kaikai Kitan Eve', al: ['جوجوتسو', 'جوجوتسو كايسن', 'jujutsu', 'jjk', 'kaikai', 'كايكاي'] },
  { id: 'jjk-paradise', anime: 'جوجوتسو كايسن', animeEn: 'Jujutsu Kaisen', title: 'Lost in Paradise', artist: 'ALI', q: 'Jujutsu Kaisen Lost in Paradise ALI', al: ['جوجوتسو', 'jujutsu', 'jjk', 'lost in paradise', 'بارادايس'] },
  { id: 'tg-unravel', anime: 'طوكيو غول', animeEn: 'Tokyo Ghoul', title: 'Unravel', artist: 'TK', q: 'Tokyo Ghoul Unravel TK', al: ['طوكيو غول', 'tokyo ghoul', 'unravel', 'انرافيل'] },
  { id: 'dn-world', anime: 'ديث نوت', animeEn: 'Death Note', title: 'The World', artist: 'Nightmare', q: 'Death Note The World Nightmare', al: ['ديث نوت', 'death note', 'the world', 'ذا وورلد'] },
  { id: 'dn-whatsup', anime: 'ديث نوت', animeEn: 'Death Note', title: "What's up people?!", artist: 'Maximum the Hormone', q: "Death Note What's up people Maximum the Hormone", al: ['ديث نوت', 'death note', 'whats up people', 'واتس اب'] },
  { id: 'bleach-asterisk', anime: 'بليتش', animeEn: 'Bleach', title: 'Asterisk', artist: 'Orange Range', q: 'Bleach Asterisk Orange Range', al: ['بليتش', 'bleach', 'asterisk', 'استريسك'] },
  { id: 'bleach-number1', anime: 'بليتش', animeEn: 'Bleach', title: 'Number One', artist: 'Shiro Sagisu', q: 'Bleach Number One OST', al: ['بليتش', 'bleach', 'number one', 'نمبر ون'] },
  { id: 'op-weare', anime: 'ون بيس', animeEn: 'One Piece', title: 'We Are!', artist: 'Hiroshi Kitadani', q: 'One Piece We Are', al: ['ون بيس', 'one piece', 'we are', 'وي آر'] },
  { id: 'op-binks', anime: 'ون بيس', animeEn: 'One Piece', title: "Binks' Sake", artist: 'One Piece', q: "One Piece Binks' Sake", al: ['ون بيس', 'one piece', 'binks', 'بنكس'] },
  { id: 'hxh-departure', anime: 'هانتر × هانتر', animeEn: 'Hunter x Hunter', title: 'Departure', artist: 'Masatoshi Ono', q: 'Hunter x Hunter Departure', al: ['هانتر', 'هانتر هانتر', 'hunter x hunter', 'hxh', 'departure', 'ديبارتشر'] },
  { id: 'hxh-hyori', anime: 'هانتر × هانتر', animeEn: 'Hunter x Hunter', title: 'Hyori Ittai', artist: 'Yuzu', q: 'Hunter x Hunter Hyori Ittai', al: ['هانتر', 'hunter x hunter', 'hxh', 'hyori ittai'] },
  { id: 'ft-snowfairy', anime: 'فايري تيل', animeEn: 'Fairy Tail', title: 'Snow Fairy', artist: 'FUNKIST', q: 'Fairy Tail Snow Fairy FUNKIST', al: ['فايري تيل', 'fairy tail', 'snow fairy', 'سنو فيري'] },
  { id: 'ft-masayume', anime: 'فايري تيل', animeEn: 'Fairy Tail', title: 'Masayume Chasing', artist: 'BoA', q: 'Fairy Tail Masayume Chasing BoA', al: ['فايري تيل', 'fairy tail', 'masayume'] },
  { id: 'mha-theday', anime: 'بطل الأكاديمية', animeEn: 'My Hero Academia', title: 'The Day', artist: 'Porno Graffitti', q: 'My Hero Academia The Day Porno Graffitti', al: ['بطل الاكاديميه', 'ماي هيرو', 'my hero academia', 'mha', 'the day'] },
  { id: 'mha-peacesign', anime: 'بطل الأكاديمية', animeEn: 'My Hero Academia', title: 'Peace Sign', artist: 'Kenshi Yonezu', q: 'My Hero Academia Peace Sign Kenshi Yonezu', al: ['بطل الاكاديميه', 'ماي هيرو', 'my hero academia', 'mha', 'peace sign'] },
  { id: 'csm-kickback', anime: 'تشينسو مان', animeEn: 'Chainsaw Man', title: 'Kick Back', artist: 'Kenshi Yonezu', q: 'Chainsaw Man Kick Back Kenshi Yonezu', al: ['تشينسو مان', 'تشاينسو مان', 'chainsaw man', 'kick back', 'كيك باك'] },
  { id: 'sao-crossing', anime: 'سورد آرت أونلاين', animeEn: 'Sword Art Online', title: 'Crossing Field', artist: 'LiSA', q: 'Sword Art Online Crossing Field LiSA', al: ['سورد ارت', 'سورد ارت اونلاين', 'sword art online', 'sao', 'crossing field'] },
  { id: 'sao-adamas', anime: 'سورد آرت أونلاين', animeEn: 'Sword Art Online', title: 'ADAMAS', artist: 'LiSA', q: 'Sword Art Online ADAMAS LiSA', al: ['سورد ارت', 'sword art online', 'sao', 'adamas', 'اداماس'] },
  { id: 'rz-redo', anime: 'ريزيرو', animeEn: 'Re:Zero', title: 'Redo', artist: 'Konomi Suzuki', q: 'Re Zero Redo Konomi Suzuki', al: ['ريزيرو', 're zero', 'redo', 'ريدو'] },
  { id: 'ov-clattanoia', anime: 'أوفرلورد', animeEn: 'Overlord', title: 'Clattanoia', artist: 'OxT', q: 'Overlord Clattanoia OxT', al: ['اوفرلورد', 'overlord', 'clattanoia', 'كلاتونيا'] },
  { id: 'mp-99', anime: 'موب سايكو', animeEn: 'Mob Psycho 100', title: '99', artist: 'MOB CHOIR', q: 'Mob Psycho 100 opening 99 MOB CHOIR', al: ['موب سايكو', 'mob psycho', '99'] },
  { id: 'hq-imagination', anime: 'هايكيو', animeEn: 'Haikyuu', title: 'Imagination', artist: 'SPYAIR', q: 'Haikyuu Imagination SPYAIR', al: ['هايكيو', 'haikyuu', 'imagination', 'ايماجينيشن'] },
  { id: 'spy-mixedn', anime: 'سباي × فاميلي', animeEn: 'Spy x Family', title: 'Mixed Nuts', artist: 'Official HIGE DANDism', q: 'Spy x Family Mixed Nuts', al: ['سباي', 'سباي فاميلي', 'spy x family', 'mixed nuts'] },
  { id: 'fma-again', anime: 'فولميتال الكيميائي', animeEn: 'Fullmetal Alchemist', title: 'Again', artist: 'YUI', q: 'Fullmetal Alchemist Brotherhood Again YUI', al: ['فولميتال', 'فولميتال الكيميائي', 'fullmetal alchemist', 'fma', 'again', 'اقين'] },
  { id: 'dbz-chala', anime: 'دراغون بول', animeEn: 'Dragon Ball Z', title: 'Cha-La Head-Cha-La', artist: 'Hironobu Kageyama', q: 'Dragon Ball Z Cha-La Head-Cha-La', al: ['دراغون بول', 'dragon ball', 'cha la', 'شالا'] },
  { id: 'tsubasa-ar', anime: 'الكابتن ماجد', animeEn: 'Captain Tsubasa', title: 'شارة الكابتن ماجد', artist: 'قديم', q: 'Captain Tsubasa الكابتن ماجد شارة', al: ['الكابتن ماجد', 'كابتن ماجد', 'captain tsubasa', 'tsubasa', 'ماجد'] },
  { id: 'adnan-ar', anime: 'عدنان ولينا', animeEn: 'Future Boy Conan', title: 'شارة عدنان ولينا', artist: 'قديم', q: 'عدنان ولينا شارة', al: ['عدنان ولينا', 'عدنان', 'لينا', 'adnan', 'كونان المستقبل'] },
  { id: 'grendizer-ar', anime: 'غرندايزر', animeEn: 'Grendizer', title: 'شارة غرندايزر', artist: 'قديم', q: 'غرندايزر شارة UFO Robot Grendizer', al: ['غرندايزر', 'جريندايزر', 'grendizer', 'النسر'] },
  { id: 'conan-ar', anime: 'المحقق كونان', animeEn: 'Detective Conan', title: 'شارة المحقق كونان', artist: 'قديم', q: 'المحقق كونان شارة Detective Conan', al: ['المحقق كونان', 'كونان', 'detective conan', 'conan'] },
];

const SNIPPET_SEC = Math.max(8, Number(process.env.ANIME_SNIPPET_SEC || 20));
const WINDOW_SEC = Math.max(SNIPPET_SEC + 5, Number(process.env.ANIME_WINDOW_SEC || 32));
const MAX_ROUNDS = Math.max(3, Number(process.env.ANIME_MAX_ROUNDS || 10));

function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** هل التخمين يطابق الأغنية؟ */
function isCorrect(guessText, song) {
  const g = norm(guessText);
  if (!g || g.length < 2 || g.length > 80) return false;
  const gw = g.split(' ').filter((w) => w.length >= 4);
  const cands = [song.anime, song.animeEn, song.title, song.artist, ...(song.al || [])]
    .map(norm)
    .filter(Boolean);
  for (const c of cands) {
    if (c.length < 2) continue;
    if (g === c) return true;
    if (g.includes(c)) return true;
    // اختصار: «ناروتو» لـ «ناروتو شيبودن»
    if (c.includes(g) && g.length >= Math.min(4, c.length)) return true;
    // خطأ حرف واحد بالأسماء الطويلة
    if (c.length >= 6 && Math.abs(c.length - g.length) <= 2 && lev(c, g) <= 1) return true;
    // كلمة مشتركة واضحة (٤ أحرف+)
    if (c.split(' ').some((w) => w.length >= 4 && gw.includes(w))) return true;
  }
  return false;
}

async function guessNext(guild, channel) {
  const s = st(guild.id);
  const g = s.guess;
  if (!g || !g.active) return;
  if (g.round >= MAX_ROUNDS) return guessFinish(guild, channel, 'خلصنا الجولات');

  let song = null;
  let resolved = null;
  for (let i = 0; i < 4; i++) {
    const pool = ANIME.filter((a) => !g.used.has(a.id));
    if (!pool.length) break;
    const cand = pick(pool);
    g.used.add(cand.id);
    try {
      const r = await D.music.resolveQuery(cand.q);
      if (r && Array.isArray(r.songs) && r.songs.length) {
        song = cand;
        resolved = r;
        break;
      }
    } catch (e) {
      D.log(`[ألعاب] خمن: ما لقيت "${cand.q}": ${String(e.message).slice(0, 80)}`);
    }
  }
  if (!song) {
    g.active = false;
    return send(channel, '❌ ما قدرت ألقى أوست أنمي يشتغل الحين — جرّب بعد شوي.');
  }
  const vch = D.botChannelOf(guild);
  if (!vch) {
    g.active = false;
    return send(channel, '⚠️ البوت مو في روم صوتي — اكتب /join أول.');
  }
  const m = D.music.getOrCreateConnection(guild, vch).music;
  try {
    m.stopAll();
  } catch {
    /* ignore */
  }
  if (typeof m.setTextChannel === 'function' && channel) m.setTextChannel(channel);
  m.songs.push(...resolved.songs);
  const started = await m.startAndWait(60000).catch(() => false);

  g.round++;
  g.current = { song, title: resolved.songs[0].title, by: null, guesses: 0 };
  clearTimer(g, 'stopTimer');
  clearTimer(g, 'hintTimer');
  clearTimer(g, 'windowTimer');

  if (!started) {
    g.fails = (g.fails || 0) + 1;
    if (g.fails >= 3) {
      g.active = false;
      return send(channel, '⚠️ الصوت ما وصل للروم — جرّب بعد شوي.');
    }
    return guessNext(guild, channel);
  }
  g.fails = 0;

  g.stopTimer = setTimeout(() => {
    try {
      D.music.getQueue(guild.id).stopAll();
    } catch {
      /* ignore */
    }
  }, SNIPPET_SEC * 1000);
  g.hintTimer = setTimeout(() => {
    if (g.current && !g.current.by) {
      const a = norm(song.anime) || 'aaa';
      send(channel, `💡 تلميح: اسم الأنمي يبدأ بـ «${a.slice(0, 3)}»`);
    }
  }, Math.floor(SNIPPET_SEC * 0.65) * 1000);
  g.windowTimer = setTimeout(() => guessTimeout(guild, channel), WINDOW_SEC * 1000);

  speak(guild, 'خمنوا الأغنية!');
  send(
    channel,
    `🎵 **الجولة ${g.round}** — خمّن أوست الأنمي!\n` +
      `▶️ شغّلت مقطع ${SNIPPET_SEC} ثانية — اكتبوا اسم الأنمي أو الأغنية في الشات.\n` +
      `⏳ عندكم ${WINDOW_SEC} ثانية.`,
  );
}

function guessTimes(g) {
  clearTimer(g, 'stopTimer');
  clearTimer(g, 'hintTimer');
  clearTimer(g, 'windowTimer');
}

function scoresText(s) {
  const arr = [...s.guess.scores.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.points - a.points);
  if (!arr.length) return 'ما فيه نقاط بعد.';
  return arr.map((x, i) => `${i + 1}. ${x.name} — ${x.points} نقطة`).join('\n');
}

function guessFinish(guild, channel, why) {
  const s = st(guild.id);
  const g = s.guess;
  if (!g) return;
  guessTimes(g);
  try {
    D.music.getQueue(guild.id).stopAll();
  } catch {
    /* ignore */
  }
  g.active = false;
  send(channel, `🏁 **انتهت لعبة خمّن الأوست** (${why}).\n${scoresText(s)}`);
}

function guessStart(guild, channel) {
  const s = st(guild.id);
  if (s.guess && s.guess.active) return '🎵 اللعبة شغالة أصلاً — اكتبوا تخميناتكم!';
  if (!D.music) return '⚠️ الموسيقى مو جاهزة.';
  s.guild = guild;
  s.channel = channel || s.channel;
  s.guess = { active: true, round: 0, current: null, used: new Set(), scores: new Map() };
  guessNext(guild, channel);
  return '🎮 **خمّن أوست الأنمي** — بدينا! أول واحد يكتب الاسم الصح ياخذ نقطة.';
}

async function guessGuess(message, text) {
  const guild = message.guild;
  const s = st(guild.id);
  const g = s.guess;
  if (!g || !g.active || !g.current || g.current.by) return null;
  const name = message.member?.displayName || message.author.username;
  if (!isCorrect(text, g.current.song)) {
    g.current.guesses++;
    if (norm(text).split(' ').filter(Boolean).length <= 4) message.react('❌').catch(() => {});
    return null;
  }
  // صح
  g.current.by = message.author.id;
  guessTimes(g);
  try {
    D.music.getQueue(guild.id).stopAll();
  } catch {
    /* ignore */
  }
  const sc = g.scores.get(message.author.id) || { name, points: 0 };
  sc.name = name;
  sc.points++;
  g.scores.set(message.author.id, sc);
  const song = g.current.song;
  speak(guild, `صح! ${song.anime}`);
  setTimeout(() => guessNext(guild, s.channel), 8000);
  return (
    `✅ **صح يا ${name}!** ${song.anime} — ${song.title} (${song.artist})\n` +
    `+1 نقطة — مجموعك: ${sc.points}\n` +
    `⏭️ الجولة الجاية بعد ٨ ثواني...`
  );
}

function guessTimeout(guild, channel) {
  const s = st(guild.id);
  const g = s.guess;
  if (!g || !g.active || !g.current || g.current.by) return;
  guessTimes(g);
  try {
    D.music.getQueue(guild.id).stopAll();
  } catch {
    /* ignore */
  }
  const song = g.current.song;
  send(
    channel,
    `⌛ ولا واحد جاوب! الجواب: **${song.anime} — ${song.title}**\n⏭️ الجولة الجاية بعد ٨ ثواني...`,
  );
  speak(guild, 'ولا واحد جاوب');
  setTimeout(() => guessNext(guild, s.channel), 8000);
}

// ---------------------------------------------------------------------------
// 🔫 2) الروليت الروسي (مزاح — كتم ٢٠ ثانية ويرجع)
// ---------------------------------------------------------------------------
const MUTE_SEC = Math.max(5, Number(process.env.ROULETTE_MUTE_SEC || 20));

function rouletteStart(guild, channel) {
  const s = st(guild.id);
  if (s.roulette?.active) return '🔫 الروليت شغال أصلاً — اكتبوا «اطلق»!';
  const vch = D.botChannelOf(guild);
  const players = [...(vch?.members?.values() || [])]
    .filter((m) => !m.user.bot)
    .map((m) => ({ id: m.id, name: m.displayName }));
  if (players.length < 1) {
    return '🔫 ما فيه أحد في الروم الصوتي! ادخلوا الروم واكتبوا /roulette';
  }
  s.guild = guild;
  s.channel = channel || s.channel;
  s.roulette = {
    active: true,
    players,
    alive: players.map((p) => p.id),
    names: new Map(players.map((p) => [p.id, p.name])),
    chamber: 6,
    bullet: rnd(6),
    shots: 0,
    muted: new Map(),
    lastShotAt: 0,
  };
  speak(guild, 'روليت روسي! ست خانات ووحدة فيها رصاصة.');
  return (
    `🔫 **الروليت الروسي** — ٦ خانات ووحدة فيها رصاصة 💥\n` +
    `اللاعبين: ${players.map((p) => p.name).join(' · ')}\n` +
    `كل واحد يكتب **اطلق** بالنَوْبة — اللي تطلع عليه الرصاصة ينكتم ${MUTE_SEC} ثانية ويطلع من اللعبة.`
  );
}

async function muteFor(guild, g, userId) {
  try {
    const m = await guild.members.fetch(userId);
    await m.voice?.setMute(true, 'روليت: طلعت عليه الرصاصة');
    const t = setTimeout(async () => {
      try {
        const m2 = await guild.members.fetch(userId);
        await m2.voice?.setMute(false, 'روليت: انتهت العقوبة');
      } catch {
        /* ignore */
      }
      g.muted.delete(userId);
    }, MUTE_SEC * 1000);
    g.muted.set(userId, t);
  } catch (e) {
    D.log(`[ألعاب] ما قدرت أكتم: ${String(e.message).slice(0, 80)}`);
  }
}

async function rouletteFire(guild, channel, member) {
  const s = st(guild.id);
  const g = s.roulette;
  if (!g || !g.active) return null;
  const name = member.displayName;
  if (!g.alive.includes(member.id)) return `💀 ${name} مو معنا — طلع من اللعبة.`;
  if (nowMs() - g.lastShotAt < 2500) return null;
  g.lastShotAt = nowMs();

  const hit = g.shots === g.bullet;
  g.shots++;
  if (!hit) {
    speak(guild, 'طق');
    return `🟢 **طقّ** — فاضية! (${g.shots}/${g.chamber})\nكمّلوا…`;
  }

  g.alive = g.alive.filter((id) => id !== member.id);
  await muteFor(guild, g, member.id);
  speak(guild, 'طاخ!');

  if (g.alive.length <= 1) {
    const winId = g.alive[0];
    const winName = winId ? g.names.get(winId) : 'ما فيه أحد';
    await rouletteStop(guild, channel, null, true);
    return `💥 **طاخ!** الرصاصة على **${name}** — ينكتم ${MUTE_SEC} ثانية.\n🏆 الفائز: **${winName}** — نجيت من الرصاصة!`;
  }
  // أسطوانة جديدة
  g.chamber = 6;
  g.bullet = rnd(6);
  g.shots = 0;
  const left = g.alive.map((id) => g.names.get(id) || id).join(' · ');
  return `💥 **طاخ!** الرصاصة طلعت على **${name}** — ينكتم ${MUTE_SEC} ثانية ويطلع من اللعبة.\n🔁 أسطوانة جديدة…\nالباقين: ${left}`;
}

async function rouletteStop(guild, channel, by, silent) {
  const s = st(guild.id);
  const g = s.roulette;
  if (!g) return;
  for (const [userId, t] of g.muted) {
    clearTimeout(t);
    try {
      const m = await guild.members.fetch(userId);
      await m.voice?.setMute(false, 'انتهت اللعبة');
    } catch {
      /* ignore */
    }
  }
  g.muted.clear();
  s.roulette = null;
  if (!silent) send(channel || s.channel, `⏹️ وقفت الروليت${by ? ` (${by})` : ''} — وكل المكتمين رجعوا.`);
}

// ---------------------------------------------------------------------------
// 😂 3) تحدي الضحك / الصمت
// ---------------------------------------------------------------------------
const LAUGH_HOLD_SEC = Math.max(15, Number(process.env.LAUGH_HOLD_SEC || 90));

function laughStart(guild, channel) {
  const s = st(guild.id);
  if (s.laugh?.active) return '😂 التحدي شغال أصلاً!';
  s.guild = guild;
  s.channel = channel || s.channel;
  s.laugh = {
    active: true,
    losses: s.laugh?.losses || new Map(),
    armedAt: nowMs() + 5500,
    timer: null,
  };
  speak(guild, 'تحدي الصمت! أول واحد يتكلم أو يضحك يخسر. ثلاثة اثنين واحد ابدأ.');
  clearTimer(s.laugh, 'timer');
  s.laugh.timer = setTimeout(() => {
    if (s.laugh && s.laugh.active) {
      send(s.channel, `😐 ما أحد تكلم ${LAUGH_HOLD_SEC} ثانية — كلكم صامدين! التحدي مستمر.`);
      laughStart2(s, guild);
    }
  }, (LAUGH_HOLD_SEC + 5) * 1000);
  return (
    `😂 **تحدي مين يضحك أول**\n` +
    `أول واحد يتكلم أو يضحك بالروم الصوتي يخسر!\n` +
    `🤐 عندكم ${LAUGH_HOLD_SEC} ثانية — الصمت يبدأ بعد ٥ ثواني...`
  );
}
function laughStart2(s, guild) {
  // يعيد التسليح بعد جولة صامدة
  if (!s.laugh) return;
  s.laugh.armedAt = nowMs() + 3000;
  clearTimer(s.laugh, 'timer');
  s.laugh.timer = setTimeout(() => {
    if (s.laugh && s.laugh.active) {
      send(s.channel, `😐 جولة صامدة ثانية! الصمت مستمر.`);
      laughStart2(s, guild);
    }
  }, (LAUGH_HOLD_SEC + 5) * 1000);
}

function laughCatch(guild, name, userId) {
  const s = st(guild.id);
  const g = s.laugh;
  if (!g || !g.active) return false;
  g.active = false;
  clearTimer(g, 'timer');
  const l = g.losses.get(userId) || { name, losses: 0 };
  l.name = name;
  l.losses++;
  g.losses.set(userId, l);
  speak(guild, `${name} خسر!`);
  send(
    s.channel,
    `😂 **كسر الصمت: ${name}!**\nخسائر ${name}: ${l.losses}\nاكتب /laugh لجولة جديدة.`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// 🔥 4) لوحة تسلّط ساخرة (إحصائيات حقيقية من الروم)
// ---------------------------------------------------------------------------
function roastBoard(guild) {
  const s = st(guild.id);
  if (!s.stats.size) return '🔥 ما فيه إحصائيات بعد — تكلموا في الروم الصوتي شوي.';
  const arr = [...s.stats.entries()].map(([id, v]) => ({ id, ...v }));
  const talker = [...arr].sort((a, b) => b.voiceMs - a.voiceMs)[0];
  const frequent = [...arr].sort((a, b) => b.spoke - a.spoke)[0];
  const cutter = [...arr].sort((a, b) => b.interrupts - a.interrupts)[0];
  const silent = arr
    .filter((x) => x.spoke <= 1)
    .sort((a, b) => a.lastAt - b.lastAt)[0];
  const mins = (ms) => (ms / 60000).toFixed(1);
  const lines = [
    `🔥 **لوحة التسلّط** — ${guild.name}`,
    `🗣️ أكثر واحد يسولف: **${talker.name}** (${mins(talker.voiceMs)} دقيقة كلام)`,
    `🎤 أكثر واحد يفتح مواضيع: **${frequent.name}** (${frequent.spoke} مرة)`,
    `✂️ أكثر واحد يقطع الكلام: **${cutter.name}** (${cutter.interrupts} مرة)`,
  ];
  if (silent) lines.push(`🤐 اللي ما سمعنا له صوت: **${silent.name}**`);
  const jokes = [
    'عاد لا تزعلون، الأرقام ما تجامل 😅',
    'واحد فيكم يسولف والباقي يسمعون بروقان 🍿',
    'اللي مكتوب اسمه فوق… الله يعينه 😂',
  ];
  lines.push(pick(jokes));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 🎙️ 5) تقليد الأعضاء
// ---------------------------------------------------------------------------
function mimicStart(guild, channel, targetMember, text) {
  const s = st(guild.id);
  s.guild = guild;
  s.channel = channel || s.channel;
  const name = targetMember?.displayName || 'فلان';
  if (text) {
    speak(guild, String(text).slice(0, 200));
    return `🎙️ قلدت **${name}**: «${String(text).slice(0, 120)}»`;
  }
  s.mimic = { userId: targetMember?.id, name, until: nowMs() + 5 * 60 * 1000, left: 8 };
  return (
    `🎙️ الحين أقلّد **${name}** — كل ما كتب شي قلت مثل قوله 😄\n` +
    `(٨ مرات أو ٥ دقايق — توقفني بأمر /mimic_off)`
  );
}

// ---------------------------------------------------------------------------
// 🎰 6) كازينو الصرامي
// ---------------------------------------------------------------------------
const REELS = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
const TRIPLE = { '🍒': 3, '🍋': 4, '🔔': 8, '💎': 12, '7️⃣': 20 };
const MIN_BET = 50;
const MAX_BET = 5000;

function casinoSpin(guild, member, bet) {
  const s = st(guild.id);
  if (s.casinoOpen === false) return '🔒 الكازينو مقفل — افتحه بأمر /casino';
  const name = member.displayName;
  const b = balOf(s, member.id, name);
  if (bet < MIN_BET) return `🎰 أقل رهان ${coins(MIN_BET)}`;
  if (bet > MAX_BET) return `🎰 أقصى رهان ${coins(MAX_BET)}`;
  if (bet > b.coins) return `❌ رصيدك ${coins(b.coins)} — ما يكفي.`;

  const r = [pick(REELS), pick(REELS), pick(REELS)];
  let mult = 0;
  if (r[0] === r[1] && r[1] === r[2]) mult = TRIPLE[r[0]] || 3;
  else if (r[0] === r[1] || r[1] === r[2] || r[0] === r[2]) mult = 1.5;
  const win = Math.round(bet * mult);
  b.coins = b.coins - bet + win;
  const head = `${r.join(' | ')}`;
  if (!mult) return `🎰 ${head}\n💸 خسرت ${coins(bet)} — رصيدك: ${coins(b.coins)}`;
  const net = win - bet;
  return (
    `🎰 ${head}\n${net >= 0 ? '🎉 ربحت' : '😅 رجعت لك'} ${coins(net >= 0 ? net : win)}\n` +
    `رصيدك: ${coins(b.coins)}`
  );
}

function casinoDice(guild, member, bet) {
  const s = st(guild.id);
  if (s.casinoOpen === false) return '🔒 الكازينو مقفل — افتحه بأمر /casino';
  const name = member.displayName;
  const b = balOf(s, member.id, name);
  if (bet < MIN_BET || bet > MAX_BET) return `🎲 الرهان من ${coins(MIN_BET)} إلى ${coins(MAX_BET)}`;
  if (bet > b.coins) return `❌ رصيدك ${coins(b.coins)} — ما يكفي.`;
  const mine = 1 + rnd(6);
  const bot = 1 + rnd(6);
  if (mine === bot) {
    return `🎲 أنت: ${mine} · أنا: ${bot}\n🤝 تعادل — رجع لك رهانك.`;
  }
  const win = mine > bot;
  b.coins += win ? bet : -bet;
  return `🎲 أنت: ${mine} · أنا: ${bot}\n${win ? '🎉 فزت' : '😅 خسرت'} ${coins(bet)} — رصيدك: ${coins(b.coins)}`;
}

function richBoard(guild) {
  const s = st(guild.id);
  const arr = [...s.coins.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 3);
  if (!arr.length) return '💰 ما فيه أحد عنده فلوس بعد — اكتبوا في الشات وكلموا بالروم وبتجمعون.';
  const medal = ['🥇', '🥈', '🥉'];
  return (
    `💰 **أغنى ٣ في ${guild.name}**\n` +
    arr.map((x, i) => `${medal[i]} ${x.name} — ${coins(x.coins)}`).join('\n')
  );
}

function casinoMenu(guild, member) {
  const s = st(guild.id);
  s.casinoOpen = true;
  const name = member.displayName;
  const b = balOf(s, member.id, name);
  return (
    `🎰 **كازينو الصرامي** (فلوس مزاح، مو حقيقية)\n` +
    `رصيدك: ${coins(b.coins)}\n\n` +
    `• /slot مبلغ — سلوت الحظ\n` +
    `• /dice مبلغ — نرد ضد البوت\n` +
    `• /bet شخص مبلغ — رهان بينك وبين أخوك\n` +
    `• /rich — أغنى ٣\n` +
    `• /casino_off — يقفل الكازينو\n\n` +
    `💡 تجمع فلوس بالكلام في الشات وفي الروم الصوتي.`
  );
}

// ---------------------------------------------------------------------------
// قائمة الألعاب
// ---------------------------------------------------------------------------
function gamesList() {
  return (
    `🎮 **ألعاب السيرفر**\n\n` +
    `🔫 روليت روسي — /roulette · يوقفها /roulette_off\n` +
    `🎵 خمّن أوست الأنمي — /guess · يوقفها /guess_off\n` +
    `😂 تحدي مين يضحك أول — /laugh · يوقفها /laugh_off\n` +
    `🔥 لوحة تسلّط ساخرة — /roast · يصفّرها /roast_off\n` +
    `🎙️ تقليد الأعضاء — /mimic · يوقفه /mimic_off\n` +
    `🎰 كازينو الصرامي — /casino · /slot /dice /bet /rich · يوقفه /casino_off\n\n` +
    `كلها مزاح داخل السيرفر ولا تضر أحد — وأي عقوبة مؤقتة ترجع لحالها.`
  );
}

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
const MY_COMMANDS = [
  'roulette', 'roulette_off', 'guess', 'guess_off', 'laugh', 'laugh_off',
  'roast', 'roast_off', 'mimic', 'mimic_off', 'casino', 'casino_off',
  'slot', 'dice', 'bet', 'rich', 'games',
];

function buildCommands() {
  return [
    new SlashCommandBuilder().setName('games').setDescription('🎮 قائمة الألعاب وأوامرها'),
    new SlashCommandBuilder().setName('roulette').setDescription('🔫 الروليت الروسي (مزاح داخل الروم)'),
    new SlashCommandBuilder().setName('roulette_off').setDescription('⏹️ إيقاف الروليت وفك الكتم عن الكل'),
    new SlashCommandBuilder().setName('guess').setDescription('🎵 خمّن أوست الأنمي — شغّل الجولة الأولى'),
    new SlashCommandBuilder().setName('guess_off').setDescription('⏹️ إيقاف لعبة خمّن الأوست وعرض النقاط'),
    new SlashCommandBuilder().setName('laugh').setDescription('😂 تحدي مين يضحك/يتكلم أول'),
    new SlashCommandBuilder().setName('laugh_off').setDescription('⏹️ إيقاف تحدي الضحك'),
    new SlashCommandBuilder().setName('roast').setDescription('🔥 لوحة تسلّط ساخرة (إحصائيات الروم)'),
    new SlashCommandBuilder().setName('roast_off').setDescription('🧹 تصفير إحصائيات التسلّط'),
    new SlashCommandBuilder()
      .setName('mimic')
      .setDescription('🎙️ خل البوت يقلد عضو')
      .addUserOption((o) => o.setName('شخص').setDescription('من نقلد').setRequired(true))
      .addStringOption((o) => o.setName('نص').setDescription('نص معين يقوله (اختياري)')),
    new SlashCommandBuilder().setName('mimic_off').setDescription('⏹️ إيقاف التقليد'),
    new SlashCommandBuilder().setName('casino').setDescription('🎰 كازينو الصرامي — رصيدك وقائمة اللعب'),
    new SlashCommandBuilder().setName('casino_off').setDescription('🔒 قفل الكازينو'),
    new SlashCommandBuilder()
      .setName('slot')
      .setDescription('🎰 جرب حظك بالسلوت')
      .addIntegerOption((o) => o.setName('مبلغ').setDescription('كم تراهن').setRequired(true)),
    new SlashCommandBuilder()
      .setName('dice')
      .setDescription('🎲 نرد ضد البوت')
      .addIntegerOption((o) => o.setName('مبلغ').setDescription('كم تراهن').setRequired(true)),
    new SlashCommandBuilder()
      .setName('bet')
      .setDescription('🤝 رهان بينك وبين عضو ثاني')
      .addUserOption((o) => o.setName('شخص').setDescription('من تراهن').setRequired(true))
      .addIntegerOption((o) => o.setName('مبلغ').setDescription('المبلغ').setRequired(true)),
    new SlashCommandBuilder().setName('rich').setDescription('💰 أغنى ٣ في السيرفر'),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
}

async function handleInteraction(interaction) {
  const name = interaction.commandName;
  if (!MY_COMMANDS.includes(name)) return false;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'الألعاب تشتغل داخل سيرفر فقط.', ephemeral: true });
    return true;
  }
  const s = st(guild.id);
  s.guild = guild;
  const channel = interaction.channel;
  if (channel) s.channel = channel;
  const member = interaction.member;

  const reply = async (text, ephemeral = false) => {
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(text);
      else await interaction.reply({ content: text, ephemeral });
    } catch (e) {
      D.log(`[ألعاب] فشل الرد: ${String(e.message).slice(0, 80)}`);
    }
  };

  try {
    switch (name) {
      case 'games':
        await reply(gamesList());
        return true;
      case 'roulette':
        await reply(rouletteStart(guild, channel));
        return true;
      case 'roulette_off':
        if (!s.roulette) {
          await reply('ما فيه روليت شغال الحين.');
          return true;
        }
        await rouletteStop(guild, channel, interaction.user.username, true);
        await reply('⏹️ وقفت الروليت وفكيت الكتم عن الكل.');
        return true;
      case 'guess':
        await reply(guessStart(guild, channel));
        return true;
      case 'guess_off':
        guessFinish(guild, channel, 'أمر إيقاف');
        await reply(`⏹️ وقفت لعبة خمّن الأوست.\n${s.guess ? scoresText(s) : ''}`);
        return true;
      case 'laugh':
        await reply(laughStart(guild, channel));
        return true;
      case 'laugh_off': {
        const g = s.laugh;
        if (!g) {
          await reply('ما فيه تحدّي شغال.');
          return true;
        }
        g.active = false;
        clearTimer(g, 'timer');
        const arr = [...g.losses.entries()].map(([id, v]) => v).sort((a, b) => b.losses - a.losses);
        await reply(
          `⏹️ وقفت التحدي.\nخسائر الضحك: ${arr.map((x) => `${x.name} (${x.losses})`).join(' · ') || 'ما أحد خسر 💪'}`,
        );
        return true;
      }
      case 'roast':
        await reply(roastBoard(guild));
        return true;
      case 'roast_off':
        s.stats.clear();
        await reply('🧹 صفّرت إحصائيات التسلّط — نبدأ نظيف.');
        return true;
      case 'mimic': {
        const target = interaction.options.getMember('شخص') || interaction.options.getUser('شخص');
        const text = interaction.options.getString('نص') || '';
        if (!target) {
          await reply('حدد الشخص اللي تبي أقلده.', true);
          return true;
        }
        await reply(mimicStart(guild, channel, target, text));
        return true;
      }
      case 'mimic_off':
        s.mimic = null;
        await reply('⏹️ وقفت التقليد.');
        return true;
      case 'casino':
        await reply(casinoMenu(guild, member));
        return true;
      case 'casino_off':
        s.casinoOpen = false;
        await reply('🔒 قفلت الكازينو — الرهانات موقفة. رجّعه بأمر /casino');
        return true;
      case 'slot':
        await reply(casinoSpin(guild, member, interaction.options.getInteger('مبلغ') || 0));
        return true;
      case 'dice':
        await reply(casinoDice(guild, member, interaction.options.getInteger('مبلغ') || 0));
        return true;
      case 'rich':
        await reply(richBoard(guild));
        return true;
      case 'bet': {
        const target = interaction.options.getMember('شخص');
        const amount = interaction.options.getInteger('مبلغ') || 0;
        if (!target || target.user.bot) {
          await reply('حدد عضو حقيقي تراهنه.', true);
          return true;
        }
        if (target.id === interaction.user.id) {
          await reply('ما تراهن نفسك 😅', true);
          return true;
        }
        if (amount < MIN_BET || amount > MAX_BET) {
          await reply(`المبلغ من ${coins(MIN_BET)} إلى ${coins(MAX_BET)}`, true);
          return true;
        }
        if (!s.casinoOpen) {
          await reply('🔒 الكازينو مقفل — افتحه بأمر /casino', true);
          return true;
        }
        const me = balOf(s, interaction.user.id, interaction.user.username);
        const you = balOf(s, target.id, target.displayName);
        if (me.coins < amount || you.coins < amount) {
          await reply(
            `الرصيد ما يكفي — أنت ${coins(me.coins)} · ${you.name} ${coins(you.coins)}`,
            true,
          );
          return true;
        }
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bet_yes').setLabel('أقبل الرهان').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('bet_no').setLabel('لا').setStyle(ButtonStyle.Danger),
        );
        await interaction.reply({
          content: `🤝 **${interaction.user.username}** عرض رهان على **${target.displayName}** بمقدار ${coins(amount)}\n${
            target.displayName
          }، تقبل؟`,
          components: [row],
          fetchReply: true,
        });
        const msg = await interaction.fetchReply().catch(() => null);
        if (!msg) return true;
        try {
          const click = await msg.awaitMessageComponent({
            filter: (i2) => i2.user.id === target.id,
            time: 60000,
          });
          if (click.customId === 'bet_no') {
            await click.update({ content: `🙅 ${target.displayName} رفض الرهان.`, components: [] });
            return true;
          }
          const flip = rnd(2) === 0;
          if (flip) {
            me.coins -= amount;
            you.coins += amount;
          } else {
            me.coins += amount;
            you.coins -= amount;
          }
          await click.update({
            content:
              `🪙 ${flip ? 'طلعت ملك' : 'طلعت كتاب'} — ${flip ? target.displayName : interaction.user.username} فاز!\n` +
              `${me.name}: ${coins(me.coins)} · ${you.name}: ${coins(you.coins)}`,
            components: [],
          });
        } catch {
          await interaction.editReply({ content: '⌛ محد رد على الرهان — انتهى.', components: [] });
        }
        return true;
      }
      default:
        await reply('ما أعرف هذا الأمر.');
        return true;
    }
  } catch (e) {
    D.log(`[ألعاب] خطأ في /${name}: ${String(e.message).slice(0, 140)}`);
    await reply('⚠️ صار خطأ في اللعبة — جرب مرة ثانية.', true);
    return true;
  }
}

// ---------------------------------------------------------------------------
// الرسائل (تشغيل/إيقاف/تفاعل اللعبة)
// ---------------------------------------------------------------------------
const RX = {
  roulette: /^(?:ال)?روليت$/,
  rouletteFire: /^(?:اطلق|افجر|اكبس)$/,
  guessOn: /^(?:خمن|خمنوا|ابدأ الخمن|خمن الاوست|خمن اوست|خمن الانمي|خمن الاغنيه|خمن الاغاني)$/,
  laughOn: /^(?:تحدي الضحك|تحدي الصمت|من يضحك اول|تحدي السكوت)$/,
  roastOn: /^(?:تسلط|لوحه التسلط|لوحه التسلط الساخره|مين يتكلم اكثر)$/,
  casinoOn: /^(?:كازينو|الكازينو|رصيدي|فلوسي)$/,
  // إيقاف كل الألعاب مرة وحدة
  allOff: /^وقف (?:اللعبه|الالعاب|كل الالعاب|كل شي)$/,
  offEach: {
    roulette: /^وقف الروليت$/,
    guess: /^وقف (?:الخمن|التخمين|خمن)$/,
    laugh: /^وقف (?:الضحك|التحدي)$/,
    roast: /^(?:صفر (?:الاحصائيات|الاحصاييات)|وقف التسلط)$/,
    mimic: /^وقف التقليد$/,
    casino: /^(?:قفل الكازينو|وقف الكازينو)$/,
  },
};

/** يرجّع نص رد أو null */
async function handleMessage(message, text) {
  const guild = message.guild;
  if (!guild) return null;
  const t = norm(text);
  if (!t) return null;
  const s = st(guild.id);
  const channel = message.channel;
  const name = message.member?.displayName || message.author.username;

  // --- فلوس الكازينو من الكلام (مرة كل ٢٠ ثانية)
  const b = balOf(s, message.author.id, name);
  if (nowMs() - b.lastEarn > 20000) {
    b.lastEarn = nowMs();
    b.coins += 20;
  }

  // --- تقليد
  if (s.mimic && s.mimic.userId === message.author.id && nowMs() < s.mimic.until) {
    s.mimic.left--;
    if (s.mimic.left <= 0) s.mimic = null;
    return `🎙️ اسمعوا هذي: «${String(text).slice(0, 100)}» — ${name} يقولها كل يوم 😂`;
  }

  // --- إيقاف كل الألعاب مرة وحدة
  if (RX.allOff.test(t)) {
    const done = [];
    if (s.roulette) {
      await rouletteStop(guild, channel, name, true);
      done.push('الروليت');
    }
    if (s.guess?.active) {
      guessFinish(guild, channel, 'أمر إيقاف');
      done.push('خمّن الأوست');
    }
    if (s.laugh?.active) {
      s.laugh.active = false;
      clearTimer(s.laugh, 'timer');
      done.push('تحدي الضحك');
    }
    if (s.mimic) {
      s.mimic = null;
      done.push('التقليد');
    }
    return done.length ? `⏹️ وقفت: ${done.join(' · ')}` : 'ما فيه لعبة شغالة الحين.';
  }

  // --- إيقافات كل لعبة
  if (RX.offEach.roulette.test(t) && s.roulette) {
    await rouletteStop(guild, channel, name, true);
    return '⏹️ وقفت الروليت وفكيت الكتم عن الكل.';
  }
  if (RX.offEach.guess.test(t) && s.guess?.active) {
    guessFinish(guild, channel, 'أمر إيقاف');
    return `⏹️ وقفت لعبة خمن الأوست.\n${scoresText(s)}`;
  }
  if (RX.offEach.laugh.test(t) && s.laugh?.active) {
    s.laugh.active = false;
    clearTimer(s.laugh, 'timer');
    return '⏹️ وقفت تحدي الضحك.';
  }
  if (RX.offEach.roast.test(t)) {
    s.stats.clear();
    return '🧹 صفّرت إحصائيات التسلّط.';
  }
  if (RX.offEach.mimic.test(t) && s.mimic) {
    s.mimic = null;
    return '⏹️ وقفت التقليد.';
  }
  if (RX.offEach.casino.test(t)) {
    s.casinoOpen = false;
    return '🔒 قفلت الكازينو.';
  }

  // --- الروليت: إطلاق
  if (RX.rouletteFire.test(t) && s.roulette?.active) {
    return rouletteFire(guild, channel, message.member);
  }
  // --- تشغيل الألعاب
  if (RX.roulette.test(t)) return rouletteStart(guild, channel);
  if (RX.guessOn.test(t)) return guessStart(guild, channel);
  if (RX.laughOn.test(t)) return laughStart(guild, channel);
  if (RX.roastOn.test(t)) return roastBoard(guild);
  if (RX.casinoOn.test(t)) return casinoMenu(guild, message.member);

  // --- تخمين أثناء الجولة
  if (s.guess?.active) {
    const r = await guessGuess(message, text);
    if (r) return r;
  }
  return null;
}

/** هل النص يشبه أمر لعبة؟ (نستعمله للسماح بالرسائل بدون منشن) */
function isGameText(text) {
  const t = norm(text);
  if (!t) return false;
  return (
    RX.roulette.test(t) ||
    RX.rouletteFire.test(t) ||
    RX.guessOn.test(t) ||
    RX.laughOn.test(t) ||
    RX.roastOn.test(t) ||
    RX.casinoOn.test(t) ||
    RX.allOff.test(t) ||
    RX.offEach.roulette.test(t) ||
    RX.offEach.guess.test(t) ||
    RX.offEach.laugh.test(t) ||
    RX.offEach.roast.test(t) ||
    RX.offEach.mimic.test(t) ||
    RX.offEach.casino.test(t)
  );
}

// ---------------------------------------------------------------------------
// الروم الصوتي: إحصائيات التسلّط + تحدي الضحك
// ---------------------------------------------------------------------------
function onVoice({ guild, userId, name, seconds, duringSpeech }) {
  if (!guild) return { handled: false };
  const s = st(guild.id);
  s.guild = guild;

  // إحصائيات لوحة التسلّط
  if (s.roastOn) {
    const x = statOf(s, userId, name);
    x.spoke++;
    x.voiceMs += Math.max(0, Math.round((seconds || 0) * 1000));
    if (duringSpeech) x.interrupts++;
    x.lastAt = nowMs();
  }
  // فلوس من الكلام الصوتي
  const b = balOf(s, userId, name);
  b.coins += 5;

  // تحدي الضحك
  const g = s.laugh;
  if (g && g.active && nowMs() >= g.armedAt) {
    const handled = laughCatch(guild, name, userId);
    return { handled };
  }
  return { handled: false };
}

// ---------------------------------------------------------------------------
// للفحص
// ---------------------------------------------------------------------------
function status() {
  const out = {};
  for (const [gid, s] of S) {
    out[gid] = {
      roulette: s.roulette ? { alive: s.roulette.alive.length, shots: s.roulette.shots } : null,
      guess: s.guess ? { round: s.guess.round, active: s.guess.active } : null,
      laugh: Boolean(s.laugh?.active),
      mimic: s.mimic ? s.mimic.name : null,
      casinoOpen: Boolean(s.casinoOpen),
      statsUsers: s.stats.size,
      coinsUsers: s.coins.size,
    };
  }
  return out;
}

module.exports = {
  init,
  buildCommands,
  handleInteraction,
  handleMessage,
  isGameText,
  onVoice,
  status,
  // للاختبار
  _internals: { isCorrect, norm, casinoSpin, casinoDice, ANIME, guessStart, rouletteStart },
};
