'use strict';

/**
 * 📻 لوحة تحكم راديو القرآن — نسخة مطابقة لفكرة بوت Quran Radio
 * ------------------------------------------------------------
 * رسالة ثابتة في روم الراديو فيها أزرار:
 *   ▶️ تشغيل التلاوة | ⏸️ إيقاف | ⏭️ السورة التالية | 🔊 دخول الروم | 🚪 خروج
 * والحالة تتحدّث تلقائياً كل دقيقة.
 */

const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const radio = require('./radio');

const GUILD_ID = (process.env.GUILD_ID || '1562207103786029077').trim();
const CHANNEL_ID = (process.env.RADIO_PANEL_CHANNEL_ID || '1562222163140939803').trim();
const VOICE_CHANNEL_ID = (process.env.QURAN_RADIO_CHANNEL_ID || '1562222163140939803').trim();
const STAFF_ROLE_ID = (process.env.STAFF_ROLE_ID || '1562213525563383880').trim();

const STATE_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(STATE_DIR, 'radio-panel.json');
const BLUE = 0x2563eb;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { messageId: null };
  }
}
function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch (err) {
    console.error('[radio-panel] save failed:', err.message);
  }
}

const state = loadState();

function view() {
  const st = radio.status(GUILD_ID);
  const connected = String(st.state || '').toLowerCase() === 'ready';
  const playing = Boolean(st.playing);
  return {
    st,
    embed: new EmbedBuilder()
      .setColor(BLUE)
      .setTitle('📻 راديو القرآن الكريم')
      .setDescription(
        playing
          ? '**التلاوة شغالة الآن — تلاوة مشاري راشد العفاسي**'
          : connected
            ? '**البوت موجود في الروم — اضغط ▶️ لتشغيل التلاوة**'
            : '**البوت مو في الروم — اضغط 🔊 دخول الروم**',
      )
      .addFields(
        { name: 'الحالة', value: connected ? '🟢 متصل' : '🔴 غير متصل', inline: true },
        { name: 'التلاوة', value: playing ? '▶️ تعمل' : '⏸️ متوقفة', inline: true },
        { name: 'السورة القادمة', value: `#${st.surah || 1}`, inline: true },
        { name: 'القارئ', value: 'مشاري راشد العفاسي', inline: true },
      )
      .setFooter({ text: 'u7 — راديو القرآن ٢٤/٧' }),
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rp:on').setLabel('تشغيل').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('rp:off').setLabel('إيقاف').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('rp:next').setLabel('السورة التالية').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rp:join').setLabel('دخول الروم').setEmoji('🔊').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('rp:leave').setLabel('خروج').setEmoji('🚪').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

async function publish(client) {
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) return console.error('[radio-panel] channel not found:', CHANNEL_ID);
  const payload = view();
  if (state.messageId) {
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [payload.embed], components: payload.components }).catch(() => {});
      return;
    }
  }
  const msg = await channel.send({ embeds: [payload.embed], components: payload.components });
  state.messageId = msg.id;
  saveState(state);
  console.log('[radio-panel] published', msg.id);
}

async function handler(interaction) {
  if (!interaction.isButton()) return;
  const id = interaction.customId || '';
  if (!id.startsWith('rp:')) return;

  const isStaff = interaction.member?.roles?.cache?.has(STAFF_ROLE_ID);
  try {
    if (id === 'rp:on') {
      radio.setAudioEnabled(true);
      if (!radio.status(GUILD_ID).channelId) await radio.join(interaction.client, VOICE_CHANNEL_ID, GUILD_ID);
      await interaction.reply({ content: '▶️ شغّلت التلاوة.', ephemeral: true });
    } else if (id === 'rp:off') {
      if (!isStaff) return interaction.reply({ content: 'الإيقاف للإدارة فقط.', ephemeral: true });
      radio.setAudioEnabled(false);
      await interaction.reply({ content: '⏸️ وقّفت التلاوة.', ephemeral: true });
    } else if (id === 'rp:next') {
      radio.next(GUILD_ID);
      await interaction.reply({ content: '⏭️ انتقلت للسورة التالية.', ephemeral: true });
    } else if (id === 'rp:join') {
      await radio.join(interaction.client, VOICE_CHANNEL_ID, GUILD_ID);
      await interaction.reply({ content: '🔊 دخلت الروم.', ephemeral: true });
    } else if (id === 'rp:leave') {
      if (!isStaff) return interaction.reply({ content: 'الخروج للإدارة فقط.', ephemeral: true });
      radio.leave(GUILD_ID);
      await interaction.reply({ content: '🚪 خرجت من الروم.', ephemeral: true });
    } else {
      return;
    }
    await publish(interaction.client).catch(() => {});
  } catch (err) {
    console.error('[radio-panel] error:', err.message);
    if (!interaction.replied) {
      await interaction.reply({ content: 'صار خطأ، جرب مرة ثانية.', ephemeral: true }).catch(() => {});
    }
  }
}

function init(client) {
  client.once('ready', async () => {
    await publish(client).catch((e) => console.error('[radio-panel] publish failed:', e.message));
    setInterval(() => publish(client).catch(() => {}), 60 * 1000).unref?.();
  });
  client.on('interactionCreate', handler);
  console.log('[radio-panel] module ready');
}

module.exports = { init };
