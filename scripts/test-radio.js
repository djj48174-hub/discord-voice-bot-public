require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const radio = require('../radio');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log('logged in', client.user.tag);
  console.log('starting radio...');
  radio.start(client);
  setTimeout(async () => {
    const ch = await client.channels.fetch('1562222163140939803').catch((e) => {
      console.log('fetch err', e.message);
      return null;
    });
    console.log('channel:', ch?.name, 'type:', ch?.type, 'isVoiceBased:', ch?.isVoiceBased?.());
    console.log('members:', [...(ch?.members?.values() || [])].map((m) => m.user.username).join(','));
    process.exit(0);
  }, 45000);
});

client.login(process.env.DISCORD_TOKEN).catch((e) => console.log('login err', e.message));

