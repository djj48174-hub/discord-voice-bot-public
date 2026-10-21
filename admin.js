/**
 * أوامر الإدارة 🛡️
 * بوت إداري: حظر، طرد، تايم أوت، تحذيرات، مسح رسائل، قفل/فتح، بطيء، رتب، إعلانات.
 * يشتغل بطريقتين:
 *  1) أوامر سلاش (/ban /kick /timeout ...)
 *  2) كتابة عربية عادية مع منشن البوت: «يا بوت ميوت @فلان 60»
 */

'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');

// ---------------------------------------------------------------------------
// إعدادات
// ---------------------------------------------------------------------------
const LOG_CHANNEL_ID = (process.env.HONEYPOT_LOG_CHANNEL_ID || '').trim();
const LOG_CHANNEL_NAME = (
  process.env.ADMIN_LOG_CHANNEL_NAME || '📋｜سجل-الحماية'
).trim();
const DEFAULT_TIMEOUT_MIN = 60;

const warnings = new Map(); // userId -> [{ reason, by, at }]

// ---------------------------------------------------------------------------
// أدوات مساعدة
// ---------------------------------------------------------------------------
function isStaff(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  return Boolean(member.permissions?.has(PermissionFlagsBits.Administrator));
}

function canModerate(actor, target, guild) {
  if (!actor || !target) return 'ما قدرت ألقى العضو.';
  if (target.id === actor.id) return 'ما تقدر تسويها على نفسك.';
  if (target.id === target.client.user.id) return 'ما أقدر أسويها على نفسي.';
  if (target.id === guild.ownerId) return 'ما ينفع على مالك السيرفر.';
  if (target.roles?.highest && actor.roles?.highest && target.roles.highest.position >= actor.roles.highest.position) {
    return 'رتبة هذا العضو أعلى منك أو تساوي رتبتك — ما أقدر أتحكم فيه.';
  }
  const me = guild.members.me;
  if (target.roles?.highest && me?.roles?.highest && target.roles.highest.position >= me.roles.highest.position) {
    return 'رتبتي تحت رتبة هذا العضو — ارفع رتبة البوت أول.';
  }
  return null;
}

function findLogChannel(guild) {
  if (!guild) return null;
  if (LOG_CHANNEL_ID) {
    const byId = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (byId?.isTextBased?.()) return byId;
  }
  return (
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && String(c.name).includes('سجل-الحماية'),
    ) ||
    guild.channels.cache.find(
      (c) => c.isTextBased?.() && String(c.name) === LOG_CHANNEL_NAME,
    ) ||
    null
  );
}

async function logAction(guild, { title, target, actor, action, reason, color = 0xe67e22 }) {
  const ch = findLogChannel(guild);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: 'العضو', value: target ? `<@${target.id}> (\`${target.user?.tag || target.id}\`)` : '—', inline: true },
      { name: 'بواسطة', value: actor ? `<@${actor.id}>` : '—', inline: true },
      { name: 'الإجراء', value: String(action || '—'), inline: true },
      { name: 'السبب', value: String(reason || '—').slice(0, 1024) },
    )
    .setTimestamp(new Date());
  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

function parseDuration(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d+)\s*(د|دقيقة|دقائق|m|min|س|ساعة|ساعات|h|يوم|أيام|d)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'دقيقة').toLowerCase();
  if (['س', 'ساعة', 'ساعات', 'h'].includes(unit)) return n * 60;
  if (['يوم', 'أيام', 'd'].includes(unit)) return n * 1440;
  return n;
}

function ephemeral(content) {
  return { content, ephemeral: true, allowedMentions: { parse: [] } };
}

// تنظيف الاسم للمقارنة (يشيل الإيموجي والفواصل والمسافات)
function normName(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

/** يلقى روم بالمنشن أو الاسم أو المعرف */
function resolveChannel(guild, ref) {
  if (!guild) return null;
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const idm = raw.match(/^<#(\d{15,25})>$/) || raw.match(/^(\d{15,25})$/);
  if (idm) return guild.channels.cache.get(idm[1]) || null;
  const want = normName(
    raw.replace(/^#/, '').replace(/^(?:ال)?(?:روم|قناة|تشانل)\s*/, ''),
  );
  if (!want) return null;
  const wants = [want];
  if (want.startsWith('ال')) wants.push(want.slice(2));
  const textChannels = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.());
  for (const w of wants) {
    // مطابقة تامة بعد التنظيف
    const exact = textChannels.find((c) => normName(c.name) === w);
    if (exact) return exact;
  }
  for (const w of wants) {
    // مطابقة جزئية
    const part = textChannels.find(
      (c) => normName(c.name).includes(w) || w.includes(normName(c.name)),
    );
    if (part) return part;
  }
  return null;
}

/** يلقى عضو بالمنشن أو المعرف أو الاسم */
async function resolveMember(guild, ref) {
  if (!guild) return null;
  const raw = String(ref || '').trim();
  if (!raw) return null;
  const idm = raw.match(/<@!?(\d{15,25})>/) || raw.match(/^(\d{15,25})$/);
  if (idm) return await guild.members.fetch(idm[1]).catch(() => null);
  const found = await guild.members.fetch({ query: raw, limit: 5 }).catch(() => null);
  if (!found || !found.size) return null;
  const want = normName(raw);
  return (
    found.find((m) => normName(m.displayName) === want) ||
    found.find((m) => normName(m.user.username) === want) ||
    found.first()
  );
}

/** يفهم طلب «ارسل اعلان [في روم X]: النص» */
function parseAnnounce(raw) {
  let m = String(raw || '').match(
    /^(?:ارسل|أرسل|ابعث|انشر)\s+(?:إعلان|اعلان|إعلانا|إعلاناً)\s*([\s\S]*)$/u,
  );
  if (!m) m = String(raw || '').match(/^(?:أعلن|اعلن)\s+([\s\S]*)$/u);
  if (!m) return null;
  let rest = m[1].trim();
  let channelRef = null;
  if (rest) {
    const cm = rest.match(/^(?:في|ب|على|إلى|الى)\s+(.+?)\s*[:：]\s*([\s\S]+)$/u);
    if (cm && !/^عن\s/u.test(cm[1])) {
      channelRef = cm[1].replace(/^(?:ال)?(?:روم|قناة|تشانل)\s*/u, '').trim();
      rest = cm[2].trim();
    } else {
      rest = rest.replace(/^[:：]\s*/u, '').trim();
    }
  }
  rest = rest.replace(/^عن\s+/u, '').trim();
  return { channelRef, body: rest };
}

/** إعلان بشكل فخم (إيمبد) — نفس الشكل للسلاش والكتابة */
function buildAnnouncementEmbed(body, { member, guild, part } = {}) {
  const icon = guild?.iconURL?.({ size: 256 }) || undefined;
  const authorName =
    member?.displayName || member?.user?.username || member?.username || guild?.name || 'الإدارة';
  const authorIcon = member?.displayAvatarURL?.({ size: 64 }) || icon;
  const embed = new EmbedBuilder()
    .setColor(0xd4af37)
    .setTitle(`📢 إعــلان${part ? ` (${part})` : ''}`)
    .setDescription(`\u200b\n${body}\n\u200b`)
    .setFooter({
      text: `u7 bot • ${authorName}`,
      ...(authorIcon ? { iconURL: authorIcon } : {}),
    })
    .setTimestamp(new Date());
  if (guild?.name) embed.setAuthor({ name: guild.name, ...(icon ? { iconURL: icon } : {}) });
  if (icon) embed.setThumbnail(icon);
  return embed;
}

/** يقسّم النص الطويل على أكثر من إيمبد عشان يوصل كامل */
function announcementEmbeds(body, ctx = {}) {
  const text = String(body || '');
  const parts = [];
  let rest = text;
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf('\n', 4000);
    if (cut < 500) cut = 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  const list = parts.length ? parts : [''];
  return list
    .slice(0, 10)
    .map((p, i) =>
      buildAnnouncementEmbed(p, {
        ...ctx,
        part: list.length > 1 ? `${i + 1}/${list.length}` : '',
      }),
    );
}

// ---------------------------------------------------------------------------
// أوامر السلاش
// ---------------------------------------------------------------------------
function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('حظر عضو من السيرفر')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addStringOption((o) => o.setName('السبب').setDescription('سبب الحظر'))
      .addIntegerOption((o) =>
        o.setName('حذف_الرسائل').setDescription('حذف رسائله آخر كم يوم (0-7)').setMinValue(0).setMaxValue(7),
      ),
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('طرد عضو من السيرفر')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addStringOption((o) => o.setName('السبب').setDescription('سبب الطرد')),
    new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('إعطاء عضو تايم أوت (ميوت)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addIntegerOption((o) =>
        o.setName('الدقائق').setDescription('المدة بالدقائق (افتراضي 60)').setMinValue(1).setMaxValue(40320),
      )
      .addStringOption((o) => o.setName('السبب').setDescription('سبب الميوت')),
    new SlashCommandBuilder()
      .setName('untimeout')
      .setDescription('فك التايم أوت عن عضو')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true)),
    new SlashCommandBuilder()
      .setName('warn')
      .setDescription('تحذير عضو (يُسجّل في سجل الحماية)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addStringOption((o) => o.setName('السبب').setDescription('سبب التحذير').setRequired(true)),
    new SlashCommandBuilder()
      .setName('warnings')
      .setDescription('عرض تحذيرات عضو')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true)),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('مسح عدد من الرسائل في الروم')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addIntegerOption((o) =>
        o.setName('العدد').setDescription('من 1 إلى 100').setRequired(true).setMinValue(1).setMaxValue(100),
      ),
    new SlashCommandBuilder()
      .setName('slowmode')
      .setDescription('تحديد البطء في الروم (ثواني)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addIntegerOption((o) =>
        o.setName('الثواني').setDescription('0 لإلغاء البطء').setRequired(true).setMinValue(0).setMaxValue(21600),
      ),
    new SlashCommandBuilder()
      .setName('lock')
      .setDescription('قفل الروم (منع الكتابة)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((o) =>
        o.setName('الروم').setDescription('الروم المطلوب (افتراضي: الحالي)').addChannelTypes(ChannelType.GuildText),
      ),
    new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('فتح الروم للكتابة')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((o) =>
        o.setName('الروم').setDescription('الروم المطلوب (افتراضي: الحالي)').addChannelTypes(ChannelType.GuildText),
      ),
    new SlashCommandBuilder()
      .setName('addrole')
      .setDescription('إعطاء رتبة لعضو')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addRoleOption((o) => o.setName('الرتبة').setDescription('الرتبة المطلوبة').setRequired(true)),
    new SlashCommandBuilder()
      .setName('removerole')
      .setDescription('سحب رتبة من عضو')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب').setRequired(true))
      .addRoleOption((o) => o.setName('الرتبة').setDescription('الرتبة المطلوبة').setRequired(true)),
    new SlashCommandBuilder()
      .setName('announce')
      .setDescription('إرسال إعلان بشكل مرتب')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((o) => o.setName('النص').setDescription('نص الإعلان').setRequired(true))
      .addChannelOption((o) =>
        o.setName('الروم').setDescription('روم الإعلانات').addChannelTypes(ChannelType.GuildText),
      ),
    new SlashCommandBuilder()
      .setName('userinfo')
      .setDescription('معلومات عضو')
      .addUserOption((o) => o.setName('العضو').setDescription('العضو المطلوب')),
    new SlashCommandBuilder().setName('serverinfo').setDescription('معلومات السيرفر'),
    new SlashCommandBuilder().setName('adminhelp').setDescription('قائمة أوامر الإدارة'),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
}

// ---------------------------------------------------------------------------
// تنفيذ أوامر السلاش
// ---------------------------------------------------------------------------
async function handleInteraction(interaction) {
  const name = interaction.commandName;
  if (!ADMIN_COMMANDS.has(name)) return false;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply(ephemeral('هذا الأمر للسيرفرات فقط.')).catch(() => {});
    return true;
  }

  await interaction.deferReply({ ephemeral: true }).catch(() => {});

  try {
    switch (name) {
      case 'ban': return await cmdBan(interaction);
      case 'kick': return await cmdKick(interaction);
      case 'timeout': return await cmdTimeout(interaction);
      case 'untimeout': return await cmdUntimeout(interaction);
      case 'warn': return await cmdWarn(interaction);
      case 'warnings': return await cmdWarnings(interaction);
      case 'clear': return await cmdClear(interaction);
      case 'slowmode': return await cmdSlowmode(interaction);
      case 'lock': return await cmdLock(interaction, true);
      case 'unlock': return await cmdLock(interaction, false);
      case 'addrole': return await cmdRole(interaction, true);
      case 'removerole': return await cmdRole(interaction, false);
      case 'announce': return await cmdAnnounce(interaction);
      case 'userinfo': return await cmdUserInfo(interaction);
      case 'serverinfo': return await cmdServerInfo(interaction);
      case 'adminhelp': return await cmdHelp(interaction);
      default: return false;
    }
  } catch (err) {
    await interaction
      .editReply({ content: `⚠️ صار خطأ: ${String(err.message).slice(0, 300)}` })
      .catch(() => {});
    return true;
  }
}

const ADMIN_COMMANDS = new Set([
  'ban', 'kick', 'timeout', 'untimeout', 'warn', 'warnings', 'clear',
  'slowmode', 'lock', 'unlock', 'addrole', 'removerole', 'announce',
  'userinfo', 'serverinfo', 'adminhelp',
]);

async function deny(interaction, perm, label) {
  if (!interaction.memberPermissions?.has(perm)) {
    await interaction.editReply({ content: `⛔ تحتاج صلاحية **${label}** لهذا الأمر.` });
    return true;
  }
  return false;
}

async function cmdBan(interaction) {
  if (await deny(interaction, PermissionFlagsBits.BanMembers, 'حظر الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const reason = interaction.options.getString('السبب') || 'بدون سبب';
  const days = interaction.options.getInteger('حذف_الرسائل') ?? 0;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const problem = member ? canModerate(interaction.member, member, interaction.guild) : null;
  if (problem) {
    await interaction.editReply({ content: `⛔ ${problem}` });
    return true;
  }
  await interaction.guild.bans.create(user.id, { reason, deleteMessageSeconds: days * 86400 });
  await interaction.editReply({ content: `✅ تم حظر ${user.tag} — السبب: ${reason}` });
  await logAction(interaction.guild, {
    title: '🔨 حظر عضو', target: user, actor: interaction.user,
    action: 'حظر', reason, color: 0xed4245,
  });
  return true;
}

async function cmdKick(interaction) {
  if (await deny(interaction, PermissionFlagsBits.KickMembers, 'طرد الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const reason = interaction.options.getString('السبب') || 'بدون سبب';
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: 'ما لقيت العضو في السيرفر.' });
    return true;
  }
  const problem = canModerate(interaction.member, member, interaction.guild);
  if (problem) {
    await interaction.editReply({ content: `⛔ ${problem}` });
    return true;
  }
  await member.kick(reason);
  await interaction.editReply({ content: `✅ تم طرد ${user.tag} — السبب: ${reason}` });
  await logAction(interaction.guild, {
    title: '👢 طرد عضو', target: user, actor: interaction.user,
    action: 'طرد', reason, color: 0xe67e22,
  });
  return true;
}

async function cmdTimeout(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ModerateMembers, 'إسكات الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const minutes = interaction.options.getInteger('الدقائق') ?? DEFAULT_TIMEOUT_MIN;
  const reason = interaction.options.getString('السبب') || 'بدون سبب';
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: 'ما لقيت العضو في السيرفر.' });
    return true;
  }
  const problem = canModerate(interaction.member, member, interaction.guild);
  if (problem) {
    await interaction.editReply({ content: `⛔ ${problem}` });
    return true;
  }
  await member.timeout(minutes * 60 * 1000, reason);
  await interaction.editReply({ content: `🔇 تم إسكات ${user.tag} لمدة **${minutes}** دقيقة — السبب: ${reason}` });
  await logAction(interaction.guild, {
    title: '🔇 تايم أوت', target: user, actor: interaction.user,
    action: `إسكات ${minutes} دقيقة`, reason, color: 0xfee75c,
  });
  return true;
}

async function cmdUntimeout(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ModerateMembers, 'إسكات الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: 'ما لقيت العضو في السيرفر.' });
    return true;
  }
  await member.timeout(null, 'فك التايم أوت');
  await interaction.editReply({ content: `✅ فكيت التايم أوت عن ${user.tag}` });
  await logAction(interaction.guild, {
    title: '🔈 فك تايم أوت', target: user, actor: interaction.user,
    action: 'فك الإسكات', reason: '—', color: 0x57f287,
  });
  return true;
}

async function cmdWarn(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ModerateMembers, 'إسكات الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const reason = interaction.options.getString('السبب', true);
  const list = warnings.get(user.id) || [];
  list.push({ reason, by: interaction.user.id, at: Date.now() });
  warnings.set(user.id, list);
  await interaction.editReply({ content: `⚠️ تم تحذير ${user.tag} (${list.length} تحذير) — ${reason}` });
  await logAction(interaction.guild, {
    title: '⚠️ تحذير', target: user, actor: interaction.user,
    action: `تحذير رقم ${list.length}`, reason, color: 0xfee75c,
  });
  return true;
}

async function cmdWarnings(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ModerateMembers, 'إسكات الأعضاء')) return true;
  const user = interaction.options.getUser('العضو', true);
  const list = warnings.get(user.id) || [];
  if (!list.length) {
    await interaction.editReply({ content: `✅ ${user.tag} ما عليه تحذيرات.` });
    return true;
  }
  const lines = list
    .slice(-10)
    .map((w, i) => `${i + 1}. ${w.reason} — <@${w.by}> — <t:${Math.floor(w.at / 1000)}:R>`);
  await interaction.editReply({ content: `⚠️ تحذيرات ${user.tag} (${list.length}):\n${lines.join('\n')}` });
  return true;
}

async function cmdClear(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ManageMessages, 'إدارة الرسائل')) return true;
  const count = interaction.options.getInteger('العدد', true);
  const deleted = await interaction.channel.bulkDelete(count, true).catch(() => null);
  await interaction.editReply({ content: `🧹 تم مسح **${deleted?.size ?? 0}** رسالة.` });
  await logAction(interaction.guild, {
    title: '🧹 مسح رسائل', target: null, actor: interaction.user,
    action: `مسح ${deleted?.size ?? 0} رسالة في <#${interaction.channelId}>`, reason: '—', color: 0x5865f2,
  });
  return true;
}

async function cmdSlowmode(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ManageChannels, 'إدارة الرومات')) return true;
  const seconds = interaction.options.getInteger('الثواني', true);
  await interaction.channel.setRateLimitPerUser(seconds, 'أمر إداري');
  await interaction.editReply({ content: seconds ? `🐢 البطء صار **${seconds}** ثانية.` : '✅ ألغيت البطء.' });
  return true;
}

async function cmdLock(interaction, lock) {
  if (await deny(interaction, PermissionFlagsBits.ManageChannels, 'إدارة الرومات')) return true;
  const channel = interaction.options.getChannel('الروم') || interaction.channel;
  await channel.permissionOverwrites.edit(
    interaction.guild.roles.everyone,
    { SendMessages: lock ? false : null },
    { reason: lock ? 'قفل الروم' : 'فتح الروم' },
  );
  await interaction.editReply({ content: lock ? `🔒 تم قفل <#${channel.id}>` : `🔓 تم فتح <#${channel.id}>` });
  return true;
}

async function cmdRole(interaction, add) {
  if (await deny(interaction, PermissionFlagsBits.ManageRoles, 'إدارة الرتب')) return true;
  const user = interaction.options.getUser('العضو', true);
  const role = interaction.options.getRole('الرتبة', true);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: 'ما لقيت العضو في السيرفر.' });
    return true;
  }
  if (role.managed) {
    await interaction.editReply({ content: 'هذه رتبة بوت/تكامل — ما تنعطى يدوياً.' });
    return true;
  }
  if (role.position >= interaction.guild.members.me.roles.highest.position) {
    await interaction.editReply({ content: '⛔ رتبتي تحت هذي الرتبة — ارفع رتبة البوت أول.' });
    return true;
  }
  if (add) await member.roles.add(role, `بواسطة ${interaction.user.tag}`);
  else await member.roles.remove(role, `بواسطة ${interaction.user.tag}`);
  await interaction.editReply({
    content: add ? `✅ أعطيت ${user.tag} رتبة ${role.name}` : `✅ سحبت من ${user.tag} رتبة ${role.name}`,
  });
  await logAction(interaction.guild, {
    title: add ? '➕ إعطاء رتبة' : '➖ سحب رتبة', target: user, actor: interaction.user,
    action: `${add ? 'إعطاء' : 'سحب'} رتبة ${role.name}`, reason: '—', color: 0x5865f2,
  });
  return true;
}

async function cmdAnnounce(interaction) {
  if (await deny(interaction, PermissionFlagsBits.ManageGuild, 'إدارة السيرفر')) return true;
  const channel = interaction.options.getChannel('الروم') || interaction.channel;
  const text = interaction.options.getString('النص', true);
  await channel.send({
    embeds: announcementEmbeds(text, {
      member: interaction.member,
      guild: interaction.guild,
    }),
    allowedMentions: { parse: ['everyone', 'roles', 'users'] },
  });
  await interaction.editReply({ content: `✅ نُشر الإعلان في <#${channel.id}>` });
  return true;
}

async function cmdUserInfo(interaction) {
  const user = interaction.options.getUser('العضو') || interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: 'ما لقيت العضو في السيرفر.' });
    return true;
  }
  const roles = member.roles.cache
    .filter((r) => r.id !== interaction.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`)
    .slice(0, 15)
    .join(' ') || '—';
  const embed = new EmbedBuilder()
    .setTitle(`👤 ${user.tag}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .setColor(member.displayColor || 0x5865f2)
    .addFields(
      { name: 'الاسم', value: member.displayName || '—', inline: true },
      { name: 'المعرّف', value: `\`${user.id}\``, inline: true },
      { name: 'انضم', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`, inline: true },
      { name: 'الحساب', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: true },
      { name: 'التحذيرات', value: String((warnings.get(user.id) || []).length), inline: true },
      { name: 'الرتب', value: roles },
    )
    .setTimestamp(new Date());
  await interaction.editReply({ embeds: [embed] });
  return true;
}

async function cmdServerInfo(interaction) {
  const g = interaction.guild;
  await g.members.fetch().catch(() => {});
  const bots = g.members.cache.filter((m) => m.user.bot).size;
  const embed = new EmbedBuilder()
    .setTitle(`🏰 ${g.name}`)
    .setThumbnail(g.iconURL({ size: 256 }))
    .setColor(0x5865f2)
    .addFields(
      { name: 'الأعضاء', value: `${g.memberCount} (${bots} بوت)`, inline: true },
      { name: 'الرومات', value: String(g.channels.cache.size), inline: true },
      { name: 'الرتب', value: String(g.roles.cache.size), inline: true },
      { name: 'المالك', value: `<@${g.ownerId}>`, inline: true },
      { name: 'تاريخ الإنشاء', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:F>`, inline: true },
      { name: 'مستوى التحقق', value: String(g.verificationLevel), inline: true },
    )
    .setTimestamp(new Date());
  await interaction.editReply({ embeds: [embed] });
  return true;
}

async function cmdHelp(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('🛡️ أوامر الإدارة')
    .setColor(0x5865f2)
    .setDescription(
      '**الحظر والطرد**\n' +
        '`/ban` حظر عضو\n`/kick` طرد عضو\n\n' +
        '**الإسكات**\n' +
        '`/timeout` تايم أوت (افتراضي 60 دقيقة)\n`/untimeout` فك التايم أوت\n\n' +
        '**التحذيرات**\n' +
        '`/warn` تحذير\n`/warnings` عرض التحذيرات\n\n' +
        '**الرومات**\n' +
        '`/clear` مسح رسائل\n`/slowmode` بطء الروم\n`/lock` قفل\n`/unlock` فتح\n\n' +
        '**الرتب**\n' +
        '`/addrole` إعطاء رتبة\n`/removerole` سحب رتبة\n\n' +
        '**عام**\n' +
        '`/announce` إعلان\n`/userinfo` معلومات عضو\n`/serverinfo` معلومات السيرفر\n\n' +
        '**إرسال لروم معيّن**\n' +
        '`ارسل في #اسم-الروم: النص` — أو عبر `/chat` اكتب نفس الطلب\n' +
        '`ارسل اعلان: النص` — إعلان فخم في روم الإعلانات\n\n' +
        '**بالكتابة:** منشن البوت + طلبك، مثال: `@Bot ميوت @فلان 60` أو `@Bot امسح 20`.\n' +
        'ونفس الأوامر تشتغل من `/chat` بدون منشن.',
    );
  await interaction.editReply({ embeds: [embed] });
  return true;
}

// ---------------------------------------------------------------------------
// أوامر بالكتابة العربية (مع منشن البوت)
// ---------------------------------------------------------------------------
async function handleText(message, rawText) {
  if (!message.guild || !message.member) return null;
  const raw = String(rawText || '').trim();
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  let target = message.mentions?.members?.first?.() || null;
  if (!target) {
    const idm = text.match(/<@!?(\d{15,25})>/);
    if (idm) target = await message.guild.members.fetch(idm[1]).catch(() => null);
  }
  const rest = text
    .replace(new RegExp(`<@!?${target?.id || '0'}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  try {
    // إعلان فخم: «ارسل اعلان [في روم X]: النص»
    const ann = parseAnnounce(raw);
    if (ann) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return '⛔ تحتاج صلاحية إدارة الرسائل عشان ترسل إعلان.';
      }
      if (!ann.body) return 'اكتب نص الإعلان بعد «ارسل اعلان:».';
      let ch = null;
      if (ann.channelRef) {
        ch = resolveChannel(message.guild, ann.channelRef);
        if (!ch) return `ما لقيت روم باسم «${ann.channelRef}».`;
      } else {
        ch = resolveChannel(message.guild, 'الإعلانات') || message.channel;
      }
      if (!ch?.isTextBased?.() || typeof ch.send !== 'function') {
        return '⛔ ما لقيت روم مناسب للإعلان.';
      }
      await ch.send({
        embeds: announcementEmbeds(ann.body, {
          member: message.member,
          guild: message.guild,
        }),
        allowedMentions: { parse: [] },
      });
      return `✅ نُشر الإعلان في <#${ch.id}>.`;
    }

    // إرسال رسالة/شيء إلى روم معيّن: «ارسل في روم الشكاوى: النص»
    const sendMatch = text.match(
      /^(?:ارسل|أرسل|ابعث|ابعت|انشر|اكتب|قل)\s+(?:رسالة|رساله|شي|شيء)?\s*(?:في|ب|على|إلى|الى|لـ|ل)?\s*(?:روم|قناة|تشانل|channel)?\s*(.+?)\s*[:：]\s*([\s\S]+)$/,
    );
    if (sendMatch) {
      const refRaw = sendMatch[1].trim();
      const body = sendMatch[2].trim();
      const explicit = /(?:روم|قناة|تشانل)\s+\S/.test(text.slice(0, 40));
      let ch = resolveChannel(message.guild, refRaw);
      if (!ch && /^(?:هنا|هذا الروم|الروم|الشات|هذا الشات)$/.test(refRaw)) ch = message.channel;
      if (ch) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
          return '⛔ تحتاج صلاحية إدارة الرسائل عشان ترسل باسم البوت.';
        }
        if (!ch.isTextBased?.() || typeof ch.send !== 'function') {
          return `⛔ <#${ch.id}> مو روم كتابي.`;
        }
        await ch.send({
          content: body,
          allowedMentions: { parse: ['users', 'roles'] },
        });
        return `✅ أرسلت في <#${ch.id}>.`;
      }
      if (explicit) return `ما لقيت روم باسم «${refRaw}». جرّب اسم الروم أو منشنه.`;
    }
    // ميوت / تايم أوت
    if (/^(ميوت|كتم|اسكت|تايم ?اوت|تايم)\b/.test(text) && target) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return '⛔ تحتاج صلاحية إسكات الأعضاء.';
      const problem = canModerate(message.member, target, message.guild);
      if (problem) return `⛔ ${problem}`;
      const mins = parseDuration(rest.replace(/^(ميوت|كتم|اسكت|تايم ?اوت|تايم)\s*/,'')) ?? DEFAULT_TIMEOUT_MIN;
      if (!mins || mins < 1) return '⛔ حدد المدة بشكل صحيح، مثال: «ميوت @فلان 60».';
      await target.timeout(Math.min(mins, 40320) * 60 * 1000, `بالكتابة من ${message.author.tag}`);
      await logAction(message.guild, {
        title: '🔇 تايم أوت', target: target.user, actor: message.author,
        action: `إسكات ${mins} دقيقة`, reason: 'أمر بالكتابة', color: 0xfee75c,
      });
      return `🔇 تم إسكات ${target.user.tag} لمدة ${mins} دقيقة.`;
    }

    // فك الميوت
    if (/^(فك الميوت|فك ميوت|تكلم|شيل الميوت)\b/.test(text) && target) {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return '⛔ تحتاج صلاحية إسكات الأعضاء.';
      const problem = canModerate(message.member, target, message.guild);
      if (problem) return `⛔ ${problem}`;
      await target.timeout(null, `فك الميوت بواسطة ${message.author.tag}`);
      await logAction(message.guild, {
        title: '🔈 فك تايم أوت', target: target.user, actor: message.author,
        action: 'فك الإسكات', reason: 'أمر بالكتابة', color: 0x57f287,
      });
      return `🔈 فكيت الميوت عن ${target.user.tag}.`;
    }

    // طرد
    if (/^(اطرد|طرد|كك)\b/.test(text) && target) {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return '⛔ تحتاج صلاحية طرد الأعضاء.';
      const problem = canModerate(message.member, target, message.guild);
      if (problem) return `⛔ ${problem}`;
      await target.kick(`بالكتابة من ${message.author.tag}`);
      await logAction(message.guild, {
        title: '👢 طرد عضو', target: target.user, actor: message.author,
        action: 'طرد', reason: 'أمر بالكتابة', color: 0xe67e22,
      });
      return `👢 تم طرد ${target.user.tag}.`;
    }

    // حظر
    if (/^(بند|احظر|حظر|بان)\b/.test(text) && target) {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return '⛔ تحتاج صلاحية حظر الأعضاء.';
      const problem = canModerate(message.member, target, message.guild);
      if (problem) return `⛔ ${problem}`;
      await message.guild.bans.create(target.id, { reason: `بالكتابة من ${message.author.tag}` });
      await logAction(message.guild, {
        title: '🔨 حظر عضو', target: target.user, actor: message.author,
        action: 'حظر', reason: 'أمر بالكتابة', color: 0xed4245,
      });
      return `🔨 تم حظر ${target.user.tag}.`;
    }

    // مسح رسائل
    const clearMatch = text.match(/^(?:امسح|مسح|نظف|احذف)\s+(\d{1,3})$/);
    if (clearMatch) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return '⛔ تحتاج صلاحية إدارة الرسائل.';
      const n = Math.min(Number(clearMatch[1]), 100);
      const deleted = await message.channel.bulkDelete(n, true).catch(() => null);
      return `🧹 مسحت ${deleted?.size ?? 0} رسالة.`;
    }

    // قفل / فتح
    if (/^(قفل الروم|قفل|اقفل)$/.test(text)) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return '⛔ تحتاج صلاحية إدارة الرومات.';
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
      return `🔒 قفلت <#${message.channelId}>.`;
    }
    if (/^(افتح الروم|افتح|فتح)$/.test(text)) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return '⛔ تحتاج صلاحية إدارة الرومات.';
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
      return `🔓 فتحت <#${message.channelId}>.`;
    }

    // بطيء
    const slow = text.match(/^(?:بطيء|بطئ|سلو ?مود|slowmode)\s+(\d{1,5})$/);
    if (slow) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return '⛔ تحتاج صلاحية إدارة الرومات.';
      await message.channel.setRateLimitPerUser(Math.min(Number(slow[1]), 21600));
      return `🐢 البطء صار ${slow[1]} ثانية.`;
    }

    // إعطاء رتبة
    const roleGive = text.match(/^(?:اعط|أعط|عطي|اعطي|انطي)\s+<@!?(\d+)>\s+(?:رتبة|رتبه|رتب)\s+(.+)$/);
    if (roleGive) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return '⛔ تحتاج صلاحية إدارة الرتب.';
      const member = await message.guild.members.fetch(roleGive[1]).catch(() => null);
      if (!member) return 'ما لقيت العضو.';
      const roleName = roleGive[2].trim();
      const role =
        message.guild.roles.cache.find((r) => r.name === roleName) ||
        message.guild.roles.cache.find((r) => r.name.includes(roleName)) ||
        message.mentions.roles.first();
      if (!role) return `ما لقيت رتبة باسم «${roleName}».`;
      if (role.position >= message.guild.members.me.roles.highest.position) return '⛔ رتبتي تحت هذي الرتبة.';
      await member.roles.add(role, `بواسطة ${message.author.tag}`);
      return `✅ أعطيت ${member.user.tag} رتبة ${role.name}.`;
    }

    // سحب رتبة
    const roleTake = text.match(/^(?:اسحب|اسحب|شل|انزع)\s+<@!?(\d+)>\s+(?:رتبة|رتبه|رتب)\s+(.+)$/);
    if (roleTake) {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return '⛔ تحتاج صلاحية إدارة الرتب.';
      const member = await message.guild.members.fetch(roleTake[1]).catch(() => null);
      if (!member) return 'ما لقيت العضو.';
      const roleName = roleTake[2].trim();
      const role =
        message.guild.roles.cache.find((r) => r.name === roleName) ||
        message.guild.roles.cache.find((r) => r.name.includes(roleName));
      if (!role) return `ما لقيت رتبة باسم «${roleName}».`;
      await member.roles.remove(role, `بواسطة ${message.author.tag}`);
      return `✅ سحبت من ${member.user.tag} رتبة ${role.name}.`;
    }

    return null;
  } catch (err) {
    return `⚠️ صار خطأ: ${String(err.message).slice(0, 200)}`;
  }
}

module.exports = { buildCommands, handleInteraction, handleText, ADMIN_COMMANDS };
