'use strict';

/**
 * 🎙️ رومات صوتية مؤقتة — نفس فكرة TempVoice
 * ------------------------------------------------------------
 * لوحة في روم «انـشـاء-فـويـس» فيها زر ➕ إنشاء روم:
 *   - ينشئ روم صوتي خاص باسم العضو داخل قسم الفويسات
 *   - العضو يدخله، ويقدر يغيّر اسمه/عدده/يقفله من أزرار داخل الروم
 *   - ينحذف تلقائياً لما يفضى
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
const CATEGORY_ID = (process.env.TEMPVOICE_CATEGORY_ID || '1562319970010931210').trim();
const DEFAULT_LIMIT = Number(process.env.TEMPVOICE_LIMIT || 0);
const BLUE = 0x2563eb;
const OWNER_TAG = 'tempvoice:';

function log(...a) {
  console.log(`[${new Date().toISOString()}] [tempvoice]`, ...a);
}

function ownerOf(channel) {
  const topic = String(channel?.topic || '');
  return topic.startsWith(OWNER_TAG) ? topic.slice(OWNER_TAG.length) : null;
}

function panelView() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🎙️ رومات صوتية خاصة')
        .setDescription(
          [
            '**اضغط زر «إنشاء روم»** ويتصنّع لك روم صوتي خاص باسمك.',
            '',
            '• تقدر تغيّر اسمه وتحدّد عدده وتقفله من أزرار داخل الروم.',
            '• ينحذف تلقائياً لما يفضى.',
          ].join('\n'),
        )
        .setFooter({ text: 'u7 — TempVoice' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('tv:create')
          .setLabel('إنشاء روم')
          .setEmoji('➕')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

function roomControls() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('🎛️ التحكم بالروم')
        .setDescription('هذي الأزرار لصاحب الروم فقط.')  
        .setFooter({ text: 'u7 — TempVoice' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tv:limit').setLabel('العدد').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:lock').setLabel('قفل').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:unlock').setLabel('فتح').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tv:rename').setLabel('تغيير الاسم').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tv:delete').setLabel('حذف').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

async function createRoom(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // عنده روم مسبقاً؟
  const existing = guild.channels.cache.find((c) => ownerOf(c) === member.id);
  if (existing) {
    await interaction.reply({ content: `عندك روم خاص: ${existing}`, ephemeral: true }).catch(() => {});
    return;
  }

  const channel = await guild.channels.create({
    name: `🎙️・${member.user.username}`.slice(0, 95),
    type: ChannelType.GuildVoice,
    parent: guild.channels.cache.get(CATEGORY_ID) ? CATEGORY_ID : undefined,
    userLimit: DEFAULT_LIMIT,
    topic: `${OWNER_TAG}${member.id}`,
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

  await channel.send(roomControls()).catch(() => {});
  await interaction
    .reply({ content: `✅ رومك جاهز: ${channel}\nادخله وبتصير أنت صاحبه.`, ephemeral: true })
    .catch(() => {});
  log(`created ${channel.name} for ${member.user.tag}`);
}

async function onVoiceState(oldState, newState) {
  // حذف أي روم مؤقت فضى
  const leftId = oldState.channelId;
  if (!leftId) return;
  const leftCh = oldState.channel;
  if (!leftCh || !ownerOf(leftCh)) return;
  if (leftCh.members.size > 0) return;
  await leftCh.delete().catch(() => {});
  log(`deleted empty ${leftCh.name}`);

  // ما نكمل إلا لو في روم جديد
  const joined = newState.channel;
  if (joined && ownerOf(joined) && joined.members.size === 1) {
    const owner = ownerOf(joined);
    if (owner === newState.member.id) {
      await joined
        .permissionOverwrites
        .edit(owner, { ManageChannels: true, MoveMembers: true })
        .catch(() => {});
    }
  }
}

async function onButton(interaction) {
  const id = String(interaction.customId || '');
  if (!id.startsWith('tv:')) return false;

  if (id === 'tv:create') {
    try {
      await createRoom(interaction);
    } catch (err) {
      log('create failed:', err.message);
      if (!interaction.replied) {
        await interaction.reply({ content: 'ما قدرت أنشئ الروم.', ephemeral: true }).catch(() => {});
      }
    }
    return true;
  }

  const vc = interaction.member?.voice?.channel;
  const owns = vc && ownerOf(vc) === interaction.member.id;
  if (!owns) {
    await interaction.reply({ content: 'هذا التحكم لصاحب الروم المؤقت فقط (وأنت داخل رومك).', ephemeral: true }).catch(() => {});
    return true;
  }

  try {
    if (id === 'tv:limit') {
      await interaction.showModal({
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
      return true;
    }
    if (id === 'tv:lock') {
      await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
      await interaction.reply({ content: '🔒 تقفل الروم.', ephemeral: true }).catch(() => {});
      return true;
    }
    if (id === 'tv:unlock') {
      await vc.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
      await interaction.reply({ content: '🔓 انفتح الروم.', ephemeral: true }).catch(() => {});
      return true;
    }
    if (id === 'tv:rename') {
      await interaction.showModal({
        title: 'اسم الروم',
        customId: 'tv:rename:modal',
        components: [
          { type: 1, components: [{ type: 4, customId: 'name', label: 'الاسم الجديد', style: 1, required: true, max_length: 60 }] },
        ],
      });
      return true;
    }
    if (id === 'tv:delete') {
      await interaction.reply({ content: '🗑️ ينحذف الروم الحين.', ephemeral: true }).catch(() => {});
      setTimeout(() => vc.delete().catch(() => {}), 1500).unref?.();
      return true;
    }
  } catch (err) {
    log('button error:', err.message);
    if (!interaction.replied) {
      await interaction.reply({ content: 'صار خطأ.', ephemeral: true }).catch(() => {});
    }
  }
  return true;
}

async function onModal(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc || ownerOf(vc) !== interaction.member.id) {
    await interaction.reply({ content: 'ما أنت داخل رومك.', ephemeral: true }).catch(() => {});
    return;
  }
  if (interaction.customId === 'tv:limit:modal') {
    const n = Math.max(0, Math.min(99, Number(interaction.fields.getTextInputValue('limit')) || 0));
    await vc.setUserLimit(n).catch(() => {});
    await interaction.reply({ content: `👥 الحد صار ${n === 0 ? 'بدون حد' : n}.`, ephemeral: true }).catch(() => {});
    return;
  }
  if (interaction.customId === 'tv:rename:modal') {
    const name = interaction.fields.getTextInputValue('name').slice(0, 90);
    await vc.setName(name).catch(() => {});
    await interaction.reply({ content: `✏️ الاسم صار ${name}.`, ephemeral: true }).catch(() => {});
  }
}

function init(client) {
  client.on('voiceStateUpdate', (o, n) => onVoiceState(o, n).catch(() => {}));

  client.on('interactionCreate', (i) => {
    if (i.isButton()) {
      if (!String(i.customId || '').startsWith('tv:')) return;
      onButton(i).catch(() => {});
      return;
    }
    if (i.isModalSubmit() && String(i.customId || '').startsWith('tv:')) {
      onModal(i).catch(() => {});
    }
  });

  // نشر/تحديث اللوحة عند التشغيل
  client.once('ready', async () => {
    const ch = await client.channels.fetch(TRIGGER_ID).catch(() => null);
    if (!ch) return log('trigger channel not found');

    const recent = await ch.messages.fetch({ limit: 20 }).catch(() => null);
    const mine = recent ? [...recent.values()].filter((m) => m.author.id === client.user.id) : [];
    for (const old of mine) {
      if (old.embeds[0]?.title?.includes('روم صوتي خاص')) await old.delete().catch(() => {});
    }
    await ch.send(panelView()).catch(() => {});
    log('panel published');
  });

  log('module ready');
}

module.exports = { init };
