require('dotenv').config();
const { SlashCommandBuilder, Routes, REST } = require('discord.js');
const admin = require('../admin');
const chat = require('../chat');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const GUILD = '1562207103786029077';

(async () => {
  const commands = [
    new SlashCommandBuilder().setName('status').setDescription('يعرض حالة البوت'),
    ...admin.buildCommands(),
    ...chat.buildCommands(),
  ].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands('1523559041262026823', GUILD), { body: commands });
  const list = await rest.get(Routes.applicationGuildCommands('1523559041262026823', GUILD));
  console.log('Registered in guild:', list.map((c) => '/' + c.name).join(' '));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
