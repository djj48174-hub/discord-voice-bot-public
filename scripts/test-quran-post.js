require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const quran = require('../quran');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log('logged in as', client.user.tag);
  await quran.post(client, { force: true });
  console.log('posted');
  setTimeout(() => process.exit(0), 1500);
});

client.login(process.env.DISCORD_TOKEN);
