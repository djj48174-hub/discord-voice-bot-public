// تشخيص 2 — يطبع معلومات سيرفر الصوت القادمة من الديسكورد
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinVoiceChannel } = require('@discordjs/voice');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log('READY:', client.user.tag);

  // نراقب راو باكتس القيتواي
  client.ws.on('VOICE_SERVER_UPDATE', (d) => {
    console.log('>>> VOICE_SERVER_UPDATE:', JSON.stringify(d));
  });
  client.ws.on('VOICE_STATE_UPDATE', (d) => {
    if (d.user_id === client.user.id) {
      console.log('>>> MY VOICE_STATE_UPDATE:', JSON.stringify(d));
    }
  });

  const ch = await client.channels.fetch(process.env.VOICE_CHANNEL_ID);
  console.log('CHANNEL:', ch.name, 'guild:', ch.guild.id);

  const conn = joinVoiceChannel({
    channelId: ch.id,
    guildId: ch.guild.id,
    adapterCreator: ch.guild.voiceAdapterCreator,
  });

  conn.on('stateChange', (o, n) =>
    console.log(`STATE: ${o.status} -> ${n.status}`),
  );
  conn.on('error', (e) => console.log('CONN ERROR:', e.message));

  setTimeout(() => {
    console.log('FINAL:', conn.state.status);
    process.exit(0);
  }, 15000);
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.log('LOGIN FAILED:', e.message);
  process.exit(1);
});
