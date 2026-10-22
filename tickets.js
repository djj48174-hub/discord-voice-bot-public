'use strict';

/**
 * 🎫 التكتات (الدعم) — نفس فكرة بوتات التذاكر (Appy وغيرها)
 * /ticket panel → رسالة فيها زر «فتح تذكرة»
 * ينشئ روم خاص للعضو + الإدارة، وفيه زر إغلاق.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID || '1562213525563383880').trim();
const CATEGORY_ID = (process.env.TICKET_CATEGORY_ID || '1562222145948352513').trim();
const BLUE = 0x2563eb;

function panelView() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🎫 الدعم الفني')
        .setDescription(
          [
            '**تحتاج مساعدة؟**',
            '',
            'اضغط زر «فتح تذكرة» وينفتح لك روم خاص بينك وبين الإدارة.',
            '• اكتب مشكلتك بالتفصيل داخل التذكرة.',
            '• لا تفتح أكثر من تذكرة في نفس الوقت.',
          ].join('\n'),
        )
        .setFooter({ text: 'u7 — الدعم' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tk:open')
          .setLabel('فتح تذكرة')
          .setEmoji('🎫')
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function ticketView(member) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🎫 تذكرة جديدة')
        .setDescription(
          [
            `مرحباً ${member}،`,
            '',
            'اكتب مشكلتك أو طلبك بالتفصيل وبيوصلك رد الإدارة بأقرب وقت.',
          ].join('\n'),
        )
        .setFooter({ text: 'u7 — الدعم' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tk:close')
          .setLabel('إغلاق التذكرة')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

async function openTicket(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // منع التكرار: نبحث عن روم تذكرة مفتوح لنفس العضو (topic = ticket:<id>)
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.topic === `ticket:${member.id}`,
  );
  if (existing) {
    await interaction.reply({ content: `عندك تذكرة مفتوحة: ${existing}`, ephemeral: true }).catch(() => {});
    return;
  }

  const parent = guild.channels.cache.get(CATEGORY_ID) ? CATEGORY_ID : interaction.channel?.parentId || null;

  const channel = await guild.channels.create({
    name: `🎫・${member.user.username}`.slice(0, 95),
    type: ChannelType.GuildText,
    parent: parent || undefined,
    topic: `ticket:${member.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: STAFF_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ],
  });

  await channel.send(ticketView(member)).catch(() => {});
  await interaction
    .reply({ content: `✅ انفتحت تذكرتك: ${channel}`, ephemeral: true })
    .catch(() => {});
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText || !String(channel.topic || '').startsWith('ticket:')) {
    await interaction.reply({ content: 'هذا الزر يشتغل داخل التذكرة فقط.', ephemeral: true }).catch(() => {});
    return;
  }

  const ownerId = String(channel.topic).split(':')[1];
  const isOwner = interaction.user.id === ownerId;
  const isStaff =
    interaction.member?.roles?.cache?.has(STAFF_ROLE_ID) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);

  if (!isOwner && !isStaff) {
    await interaction.reply({ content: 'الإغلاق للإدارة أو صاحب التذكرة فقط.', ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.reply({ content: '🔒 تقفل التذكرة وتنحذف بعد ٥ ثواني.' }).catch(() => {});
  setTimeout(() => {
    channel.delete().catch(() => {});
  }, 5000).unref?.();
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('إدارة التذاكر')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('panel').setDescription('إرسال لوحة فتح التذاكر في هذا الروم')),
  ];
}

async function handleInteraction(interaction) {
  if (interaction.isButton()) {
    if (interaction.customId === 'tk:open') {
      try {
        await openTicket(interaction);
      } catch (err) {
        console.error('[tickets] open:', err.message);
        if (!interaction.replied) {
          await interaction.reply({ content: 'ما قدرت أفتح التذكرة.', ephemeral: true }).catch(() => {});
        }
      }
      return true;
    }
    if (interaction.customId === 'tk:close') {
      try {
        await closeTicket(interaction);
      } catch (err) {
        console.error('[tickets] close:', err.message);
      }
      return true;
    }
    return false;
  }

  if (!interaction.isChatInputCommand() || interaction.commandName !== 'ticket') return false;

  try {
    await interaction.channel.send(panelView());
    await interaction.reply({ content: '✅ أرسلت لوحة التذاكر.', ephemeral: true });
  } catch (err) {
    console.error('[tickets] panel:', err.message);
    await interaction.reply({ content: 'ما قدرت أرسل اللوحة.', ephemeral: true }).catch(() => {});
  }
  return true;
}

function init(client) {
  client.on('interactionCreate', (i) => {
    // الأزرار فقط؛ أوامر السلاش تمر من معالج bot.js
    if (!i.isButton()) return;
    if (!String(i.customId || '').startsWith('tk:')) return;
    handleInteraction(i).catch(() => {});
  });

  console.log('[tickets] ready');
}

module.exports = { init, buildCommands, handleInteraction };
