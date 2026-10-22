'use strict';

/**
 * 🎙️ رومات صوتية مؤقتة — نفس فكرة TempVoice
 * العضو يدخل روم "انشـاء-فـويـس" → يتصنّع له روم خاص باسمه، وينحذف لما يفضى.
 */

const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const TRIGGER_ID = (process.env.TEMPVOICE_TRIGGER_ID || '1562320675367293018').trim();
const DEFAULT_LIMIT = Number(process.env.TEMPVOICE_LIMIT || 0);
const BLUE = 0x2563eb;

// channelId -> ownerId
const active = new Map();

function log(...a) {
  console.log(`[${new Date().toISOString()}] [tempvoice]`, ...a);
}

function panel() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🎙️ روم صوتي خاص فيك')
        .setDescription(
          [
            '**ادخل روم «انشـاء-فـويـس»** ويتصنّع لك روم خاص باسمك تلقائياً.',
            '',
            '• ينحذف تلقائياً لما يفضى.',
            '• تقدر تغيّر اسمه، تحدّد عدده، وتقفل/تفتح.',
          ].join('\n'),
        )
        .setFooter({ text: 'u7 — TempVoice' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tv:limit').setLabel('تحديد العدد').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:lock').setLabel('قفل').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:unlock').setLabel('فتح').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:rename').setLabel('تغيير الاسم').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

async function createRoom(member, trigger) {
  const guild = trigger.guild;
  const parent = trigger.parentId || trigger.parent;
  const channel = await guild.channels.create({
    name: `🎙️・${member.user.username}`.slice(0, 95),
    type: ChannelType.GuildVoice,
    parent,
    userLimit: DEFAULT_LIMIT,
    permissionOverwrites: [
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      },
    ],
  });
  active.set(channel.id, member.id);
  await member.voice.setChannel(channel).catch(() => {});
  log(`created ${channel.name} for ${member.user.tag}`);
  const text = await channel.send(panel()).catch(() => null);
  if (text) setTimeout(() => text.delete().catch(() => {}), 15000);
  return channel;
}

async function onVoiceState(oldState, newState) {
  const member = newState.member;
  if (!member || member.user.bot) return;

  if (newState.channelId === TRIGGER_ID && oldState.channelId !== TRIGGER_ID) {
    await createRoom(member, newState.channel).catch((e) => log('create failed:', e.message));
    return;
  }

  if (oldState.channelId && active.has(oldState.channelId)) {
    const ch =
      oldState.guild.channels.cache.get(oldState.channelId) ||
      (await oldState.guild.channels.fetch(oldState.channelId).catch(() => null));
    if (ch && ch.members.size === 0) {
      active.delete(ch.id);
      await ch.delete().catch(() => {});
      log(`deleted empty ${ch.name}`);
    }
  }
}

async function onInteraction(interaction) {
  if (!interaction.isButton()) return;
  const id = interaction.customId || '';
  if (!id.startsWith('tv:')) return;
  const vc = interaction.member?.voice?.channel;
  if (!vc || active.get(vc.id) !== interaction.member.id) {
    return interaction.reply({ content: 'هذا التحكم يخص رومك المؤقت فقط.', ephemeral: true });
  }
  try {
    if (id === 'tv:limit') {
      return interaction.showModal({
        title: 'تحديد عدد الأعضاء',
        customId: 'tv:limit:modal',
        components: [
          {
            type: 1,
            components: [
              { type: 4, customId: 'limit', label: 'العدد (0 = بدون حد)', style: 1, min_length: 1, max_length: 2, required: true },
            ],
          },
        ],
      });
    }
    if (id === 'tv:lock') {
      await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
      return interaction.reply({ content: '🔒 تقفل الروم.', ephemeral: true });
    }
    if (id === 'tv:unlock') {
      await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
      return interaction.reply({ content: '🔓 انفتح الروم.', ephemeral: true });
    }
    if (id === 'tv:rename') {
      return interaction.showModal({
        title: 'اسم الروم',
        customId: 'tv:rename:modal',
        components: [
          { type: 1, components: [{ type: 4, customId: 'name', label: 'الاسم الجديد', style: 1, required: true, max_length: 60 }] },
        ],
      });
    }
  } catch (e) {
    log('interaction error:', e.message);
    if (!interaction.replied) interaction.reply({ content: 'صار خطأ.', ephemeral: true }).catch(() => {});
  }
}

async function onModal(interaction) {
  if (!interaction.isModalSubmit()) return;
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: 'ما أنت في روم.', ephemeral: true });
  if (interaction.customId === 'tv:limit:modal') {
    const n = Math.max(0, Math.min(99, Number(interaction.fields.getTextInputValue('limit')) || 0));
    await vc.setUserLimit(n).catch(() => {});
    return interaction.reply({ content: `👥 الحد صار ${n === 0 ? 'بدون حد' : n}.`, ephemeral: true });
  }
  if (interaction.customId === 'tv:rename:modal') {
    const name = interaction.fields.getTextInputValue('name').slice(0, 90);
    await vc.setName(name).catch(() => {});
    return interaction.reply({ content: `✏️ الاسم صار ${name}.`, ephemeral: true });
  }
}

function init(client) {
  client.on('voiceStateUpdate', (o, n) => onVoiceState(o, n).catch(() => {}));
  client.on('interactionCreate', (i) => {
    if (i.isModalSubmit()) onModal(i).catch(() => {});
    else onInteraction(i).catch(() => {});
  });
  client.once('ready', async () => {
    const ch = await client.channels.fetch(TRIGGER_ID).catch(() => null);
    if (!ch) return log('trigger channel not found');
    const msgs = await ch.messages.fetch({ limit: 5 }).catch(() => null);
    if (msgs && msgs.some((m) => m.author.id === client.user.id && m.embeds[0]?.title?.includes('روم صوتي خاص'))) return;
    await ch.send(panel()).catch(() => {});
    log('panel published');
  });
  log('module ready');
}

module.exports = { init };
