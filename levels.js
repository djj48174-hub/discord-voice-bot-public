'use strict';

/**
 * 📈 نظام المستويات — نفس فكرة ProBot
 * XP لكل رسالة + /rank + /top + /levelset + مكافآت رتب.
 * التخزين: data/levels.json
 */

const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const COOLDOWN_MS = Number(process.env.LEVEL_COOLDOWN_SECONDS || 20) * 1000;
const MIN_XP = Number(process.env.LEVEL_MIN_XP || 15);
const MAX_XP = Number(process.env.LEVEL_MAX_XP || 25);
const ANNOUNCE_CHANNEL_ID = (process.env.LEVEL_UP_CHANNEL_ID || '').trim();
const BLUE = 0x2563eb;

// {"5":"ROLE_ID","10":"ROLE_ID"}
let LEVEL_ROLES = {};
try {
  LEVEL_ROLES = JSON.parse(process.env.LEVEL_ROLES || '{}');
} catch {
  LEVEL_ROLES = {};
}

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'levels.json');

let db = {};
let dirty = false;

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch {
    db = {};
  }
}

function save() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db), 'utf8');
    dirty = false;
  } catch (err) {
    console.error('[levels] save failed:', err.message);
  }
}

function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelFromXp(xp) {
  let level = 0;
  let total = 0;
  while (xp >= total + xpForLevel(level) && level < 500) {
    total += xpForLevel(level);
    level += 1;
  }
  return { level, into: xp - total, need: xpForLevel(level) };
}

function get(userId) {
  if (!db[userId]) db[userId] = { xp: 0, level: 0, messages: 0 };
  return db[userId];
}

const cooldown = new Map();

async function onMessage(message) {
  if (!message.guild || message.author.bot) return;
  const now = Date.now();
  const last = cooldown.get(message.author.id) || 0;
  if (now - last < COOLDOWN_MS) return;
  cooldown.set(message.author.id, now);

  const row = get(message.author.id);
  const gain = MIN_XP + Math.floor(Math.random() * (MAX_XP - MIN_XP + 1));
  row.xp += gain;
  row.messages += 1;

  const info = levelFromXp(row.xp);
  const leveled = info.level > row.level;
  row.level = info.level;
  dirty = true;

  if (!leveled) return;

  const roleId = LEVEL_ROLES[String(info.level)];
  if (roleId && message.member) {
    await message.member.roles.add(roleId).catch(() => {});
  }
  if (ANNOUNCE_CHANNEL_ID) {
    const ch = await message.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (ch) {
      await ch
        .send(`🎉 ${message.author} وصل **المستوى ${info.level}**!`)
        .catch(() => {});
    }
  }
}

function rankEmbed(member) {
  const row = get(member.id);
  const info = levelFromXp(row.xp);
  const pct = Math.min(100, Math.round((info.into / info.need) * 100));
  const filled = Math.round(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setTitle('بطاقة المستوى')
    .addFields(
      { name: 'المستوى', value: `**${info.level}**`, inline: true },
      { name: 'XP', value: `${row.xp}`, inline: true },
      { name: 'الرسائل', value: `${row.messages}`, inline: true },
      { name: 'التقدّم', value: `${bar} ${pct}%\n${info.into} / ${info.need}`, inline: false },
    )
    .setFooter({ text: 'u7 — المستويات' });
}

function topEmbed(guild) {
  const rows = Object.entries(db)
    .map(([id, v]) => ({ id, xp: v.xp || 0, level: v.level || 0 }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 10);
  const lines = rows.map((r, i) => {
    const medal = ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
    return `${medal} <@${r.id}> — المستوى ${r.level} · ${r.xp} XP`;
  });
  return new EmbedBuilder()
    .setColor(BLUE)
    .setTitle(`🏆 أفضل ١٠ في ${guild.name}`)
    .setDescription(lines.join('\n') || 'لا يوجد بيانات بعد.');
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('عرض مستواك أو مستوى عضو')
      .addUserOption((o) => o.setName('user').setDescription('العضو')),
    new SlashCommandBuilder().setName('top').setDescription('أفضل ١٠ أعضاء بالمستويات'),
    new SlashCommandBuilder()
      .setName('levelset')
      .setDescription('ضبط XP عضو (الإدارة)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true))
      .addIntegerOption((o) => o.setName('xp').setDescription('قيمة XP').setRequired(true)),
  ];
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  const name = interaction.commandName;
  if (!['rank', 'top', 'levelset'].includes(name)) return false;

  try {
    if (name === 'rank') {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: 'ما لقيت العضو.', ephemeral: true });
        return true;
      }
      await interaction.reply({ embeds: [rankEmbed(member)] });
      return true;
    }
    if (name === 'top') {
      await interaction.reply({ embeds: [topEmbed(interaction.guild)] });
      return true;
    }
    const user = interaction.options.getUser('user');
    const xp = Math.max(0, interaction.options.getInteger('xp'));
    const row = get(user.id);
    row.xp = xp;
    row.level = levelFromXp(xp).level;
    dirty = true;
    save();
    await interaction.reply({
      content: `تم ضبط XP ${user.tag} إلى ${xp} (المستوى ${row.level}).`,
      ephemeral: true,
    });
    return true;
  } catch (err) {
    console.error('[levels] error:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'صار خطأ.', ephemeral: true }).catch(() => {});
    }
    return true;
  }
}

function init(client) {
  load();
  client.on('messageCreate', (m) => onMessage(m).catch(() => {}));
  setInterval(save, 30 * 1000).unref?.();
  client.once('shutdown', save);
  console.log('[levels] ready');
}

module.exports = { init, buildCommands, handleInteraction };
