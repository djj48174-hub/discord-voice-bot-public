'use strict';

/**
 * 📜 القوانين والتفعيل
 * ------------------------------------------------------------
 * /rules panel (الإدارة) → رسالة القوانين + زر «أوافق على القوانين»
 * الضغط على الزر: يشيل «غير مفعل» ويعطي «عضو مفعل».
 * العضو الجديد ياخذ «غير مفعل» تلقائياً عند الدخول.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const UNVERIFIED_ROLE_ID = (process.env.UNVERIFIED_ROLE_ID || '1562301170603655218').trim();
const MEMBER_ROLE_ID = (process.env.MEMBER_ROLE_ID || '1562302309919359067').trim();
const WELCOME_CHANNEL_ID = (process.env.WELCOME_CHANNEL_ID || '1562213580529475675').trim();
const RULES_CHANNEL_ID = (process.env.RULES_CHANNEL_ID || '1562213576368726178').trim();
const BLUE = 0x2563eb;

const RULES = [
  '**١. الاحترام أولاً** — بلا سب، قذف، تحقير، أو تنمّر على أحد.',
  '**٢. بلا محتوى إباحي** أو روابط مخلة — السيرفر فيه أعضاء أقل من ١٨.',
  '**٣. بلا سبام** أو منشن جماعي أو إزعاج متكرر.',
  '**٤. بلا إعلانات** أو دعوات لسيرفرات ثانية بدون إذن الإدارة.',
  '**٥. بلا نشر معلومات خاصة** عن أي شخص (اسم، رقم، صور) بدون إذنه.',
  '**٦. بلا انتحال شخصية** الإدارة أو الأعضاء.',
  '**٧. التزم بتوجيهات الإدارة** — والقرار النهائي لها.',
  '**٨. المخالفة** = تحذير، ثم تايم أوت، ثم طرد أو حظر حسب الحالة.',
  '',
  'دخولك للسيرفر يعني موافقتك على هذي القوانين.',
];

function panelView() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(BLUE)
        .setTitle('📜 قوانين سيرفر u7')
        .setDescription(RULES.join('\n'))
        .setFooter({ text: 'u7 — اضغط الزر بالأسفل للموافقة' }),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('rl:agree')
          .setLabel('أوافق على القوانين')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('rules')
      .setDescription('إدارة القوانين')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) =>
        s.setName('panel').setDescription('إرسال رسالة القوانين وزر الموافقة في هذا الروم'),
      ),
    new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('إرسال ترحيب لعضو (يدوي)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  ];
}

async function onButton(interaction) {
  if (interaction.customId !== 'rl:agree') return false;

  const member = interaction.member;
  if (!member) return true;

  if (MEMBER_ROLE_ID && member.roles.cache.has(MEMBER_ROLE_ID)) {
    await interaction.reply({ content: 'أنت موافق على القوانين من قبل ✅', ephemeral: true }).catch(() => {});
    return true;
  }

  try {
    if (UNVERIFIED_ROLE_ID && member.roles.cache.has(UNVERIFIED_ROLE_ID)) {
      await member.roles.remove(UNVERIFIED_ROLE_ID, 'وافق على القوانين').catch(() => {});
    }
    if (MEMBER_ROLE_ID) await member.roles.add(MEMBER_ROLE_ID, 'وافق على القوانين');
    await interaction.reply({ content: '✅ تم تفعيلك، حيّاك الله!', ephemeral: true }).catch(() => {});
  } catch (err) {
    console.error('[rules] agree failed:', err.message);
    await interaction.reply({ content: 'ما قدرت أفعّلك، كلم الإدارة.', ephemeral: true }).catch(() => {});
  }
  return true;
}

async function handleInteraction(interaction) {
  if (interaction.isButton()) return onButton(interaction);
  if (!interaction.isChatInputCommand()) return false;

  if (interaction.commandName === 'welcome') {
    try {
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const channel = await interaction.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
      if (!channel || !member) {
        await interaction.reply({ content: 'ما لقيت العضو أو روم الترحيب.', ephemeral: true });
        return true;
      }
      await channel.send({
        content: `<@${member.id}>`,
        allowedMentions: { users: [member.id] },
        embeds: [
          new EmbedBuilder()
            .setColor(BLUE)
            .setTitle(`🎉 حيّاك الله ${member.displayName || member.user.username}`)
            .setDescription(
              [
                'نوّرت السيرفر!',
                '',
                `اقرأ القوانين ووافق عليها من <#${RULES_CHANNEL_ID}>،`,
                'وأول ما تضغط «أوافق» بتنفتح لك كل الأقسام.',
              ].join('\n'),
            )
            .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'u7 — الترحيب' }),
        ],
      });
      await interaction.reply({ content: '✅ أرسلت الترحيب.', ephemeral: true });
    } catch (err) {
      console.error('[rules] welcome failed:', err.message);
      await interaction.reply({ content: 'ما قدرت أرسل الترحيب.', ephemeral: true }).catch(() => {});
    }
    return true;
  }

  if (interaction.commandName !== 'rules') return false;

  try {
    await interaction.channel.send(panelView());
    await interaction.reply({ content: '✅ أرسلت القوانين.', ephemeral: true });
  } catch (err) {
    console.error('[rules] panel failed:', err.message);
    await interaction.reply({ content: 'ما قدرت أرسل القوانين.', ephemeral: true }).catch(() => {});
  }
  return true;
}

function init(client) {
  client.on('interactionCreate', (i) => {
    if (!i.isButton()) return;
    if (i.customId !== 'rl:agree') return;
    onButton(i).catch(() => {});
  });

  // العضو الجديد ياخذ «غير مفعل» لين يوافق على القوانين
  client.on('guildMemberAdd', async (member) => {
    if (!member.guild || member.user.bot) return;
    if (member.guild.id !== (process.env.GUILD_ID || '1562207103786029077')) return;
    if (!UNVERIFIED_ROLE_ID) return;
    await member.roles.add(UNVERIFIED_ROLE_ID, 'عضو جديد — بانتظار الموافقة على القوانين').catch(() => {});
  });

  console.log('[rules] ready');
}

module.exports = { init, buildCommands, handleInteraction };
