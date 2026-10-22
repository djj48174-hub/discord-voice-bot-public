'use strict';

/**
 * 🎁 السحوبات — نفس فكرة ProBot
 * /giveaway start/end/reroll + زر دخول + اختيار فائز تلقائي.
 * التخزين: data/giveaways.json
 */

const fs = require('fs');
const path = require('path');
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const BLUE = 0x2563eb;
const GOLD = 0xf1c40f;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'giveaways.json');

let db = {};

function load() {
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch {
    db = {};
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('[giveaways] save failed:', err.message);
  }
}

function parseDuration(input) {
  const m = String(input || '').trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60e3 : unit === 'h' ? 3600e3 : 86400e3;
  return n * mult;
}

function human(ms) {
  const parts = [];
  const d = Math.floor(ms / 86400e3);
  const h = Math.floor((ms % 86400e3) / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  if (d) parts.push(`${d} يوم`);
  if (h) parts.push(`${h} ساعة`);
  if (m) parts.push(`${m} دقيقة`);
  return parts.join(' و ') || 'دقيقة';
}

function embedFor(gw, ended = false) {
  const e = new EmbedBuilder()
    .setColor(ended ? GOLD : BLUE)
    .setTitle(ended ? '🎉 انتهى السحب' : '🎁 سحب جديد')
    .setDescription(`**${gw.prize}**`)
    .addFields(
      { name: 'الفائزون', value: `${gw.winners}`, inline: true },
      { name: 'المشاركون', value: `${gw.entries.length}`, inline: true },
      {
        name: ended ? 'المنتهي' : 'ينتهي',
        value: ended ? `<t:${Math.floor(gw.endsAt / 1000)}:R>` : `<t:${Math.floor(gw.endsAt / 1000)}:R>`,
        inline: true,
      },
      { name: 'صاحب السحب', value: `<@${gw.hostId}>`, inline: true },
    )
    .setFooter({ text: ended ? 'انتهى السحب' : 'اضغط الزر للمشاركة' });

  if (ended && gw.winnerIds?.length) {
    e.addFields({ name: 'النتيجة', value: gw.winnerIds.map((id) => `<@${id}>`).join('، ') });
  }
  return e;
}

function buttonFor(gw, enabled = true) {
  if (!enabled) return [];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gw:join:${gw.id}`)
        .setLabel('مشاركة')
        .setEmoji('🎉')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function finish(client, id) {
  const gw = db[id];
  if (!gw || gw.ended) return;
  gw.ended = true;

  const pool = [...new Set(gw.entries)];
  const count = Math.min(gw.winners, pool.length);
  gw.winnerIds = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    gw.winnerIds.push(pool.splice(idx, 1)[0]);
  }
  save();

  const channel = await client.channels.fetch(gw.channelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(gw.messageId).catch(() => null);
  if (msg) {
    await msg
      .edit({ embeds: [embedFor(gw, true)], components: [] })
      .catch(() => {});
  }
  if (gw.winnerIds.length) {
    await channel
      .send(`🎉 مبروك ${gw.winnerIds.map((x) => `<@${x}>`).join('، ')} — فزتوا بـ **${gw.prize}**!`)
      .catch(() => {});
  } else {
    await channel.send(`😕 ما شارك أحد في سحب **${gw.prize}**، ما فيه فائز.`).catch(() => {});
  }
}

function schedule(client, gw) {
  const delay = Math.max(0, gw.endsAt - Date.now());
  setTimeout(() => finish(client, gw.id).catch((e) => console.error('[giveaways] finish:', e.message)), delay).unref?.();
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('إدارة السحوبات')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s
          .setName('start')
          .setDescription('بدء سحب')
          .addStringOption((o) => o.setName('prize').setDescription('الجائزة').setRequired(true))
          .addStringOption((o) =>
            o
              .setName('duration')
              .setDescription('المدة مثل 10m أو 2h أو 1d')
              .setRequired(true),
          )
          .addIntegerOption((o) =>
            o.setName('winners').setDescription('عدد الفائزين').setMinValue(1).setMaxValue(20),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('end')
          .setDescription('إنهاء سحب الآن')
          .addStringOption((o) => o.setName('id').setDescription('معرّف السحب').setRequired(true)),
      )
      .addSubcommand((s) =>
        s
          .setName('reroll')
          .setDescription('إعادة اختيار الفائز')
          .addStringOption((o) => o.setName('id').setDescription('معرّف السحب').setRequired(true)),
      ),
  ];
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'giveaway') return false;
  const sub = interaction.options.getSubcommand(true);

  try {
    if (sub === 'start') {
      const prize = interaction.options.getString('prize');
      const duration = parseDuration(interaction.options.getString('duration'));
      const winners = interaction.options.getInteger('winners') || 1;
      if (!duration) {
        await interaction.reply({ content: 'المدة غير صحيحة. مثال: `10m` أو `2h` أو `1d`.', ephemeral: true });
        return true;
      }
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const gw = {
        id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: null,
        prize,
        winners,
        hostId: interaction.user.id,
        endsAt: Date.now() + duration,
        ended: false,
        entries: [],
        winnerIds: [],
      };

      const msg = await interaction.channel.send({
        embeds: [embedFor(gw)],
        components: buttonFor(gw),
      });
      gw.messageId = msg.id;
      db[id] = gw;
      save();
      schedule(interaction.client, gw);

      await interaction.reply({
        content: `✅ بدأ السحب على **${prize}** لمدة ${human(duration)} — المعرّف \`${id}\`.`,
        ephemeral: true,
      });
      return true;
    }

    const id = interaction.options.getString('id').trim();
    const gw = db[id];
    if (!gw) {
      await interaction.reply({ content: 'ما لقيت سحب بهذا المعرّف.', ephemeral: true });
      return true;
    }

    if (sub === 'end') {
      await finish(interaction.client, id);
      await interaction.reply({ content: '⏹️ أنهيت السحب.', ephemeral: true });
      return true;
    }

    // reroll
    const pool = [...new Set(gw.entries)];
    if (!pool.length) {
      await interaction.reply({ content: 'ما فيه مشاركين.', ephemeral: true });
      return true;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    gw.winnerIds = [pick];
    save();
    await interaction.reply({ content: `🎲 الفائز الجديد: <@${pick}>`, allowedMentions: { users: [pick] } });
    return true;
  } catch (err) {
    console.error('[giveaways] error:', err.message);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'صار خطأ.', ephemeral: true }).catch(() => {});
    }
    return true;
  }
}

async function onButton(interaction) {
  if (!interaction.isButton()) return false;
  const parts = String(interaction.customId || '').split(':');
  if (parts[0] !== 'gw' || parts[1] !== 'join') return false;

  const id = parts[2];
  const gw = db[id];
  if (!gw || gw.ended) {
    await interaction.reply({ content: 'هذا السحب انتهى.', ephemeral: true }).catch(() => {});
    return true;
  }

  const idx = gw.entries.indexOf(interaction.user.id);
  if (idx >= 0) {
    gw.entries.splice(idx, 1);
    save();
    await interaction.reply({ content: '❌ طلعت من السحب.', ephemeral: true }).catch(() => {});
  } else {
    gw.entries.push(interaction.user.id);
    save();
    await interaction.reply({ content: '✅ دخلت السحب، حظ موفق!', ephemeral: true }).catch(() => {});
  }

  const msg = await interaction.message.fetch().catch(() => null);
  if (msg) {
    await msg
      .edit({ embeds: [embedFor(gw)], components: buttonFor(gw) })
      .catch(() => {});
  }
  return true;
}

function init(client) {
  load();
  Object.values(db)
    .filter((gw) => !gw.ended)
    .forEach((gw) => schedule(client, gw));
  client.on('interactionCreate', (i) => {
    onButton(i).catch(() => {});
  });
  console.log('[giveaways] ready, restored:', Object.values(db).filter((g) => !g.ended).length);
}

module.exports = { init, buildCommands, handleInteraction };
