const { Client, GatewayIntentBits } = require('discord.js');
const { playRadio } = require('./radio');
const { playYouTube } = require('./yt');
const { playSpotify } = require('./spotify');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const prefix = process.env.PREFIX;
const token = process.env.TOKEN;

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.toLowerCase().slice(prefix.length).trim().split(/ +/g);
  const command = args.shift().toLowerCase();

  if (command === 'raadio') {
    playRadio(message, args);
  } else if (command === 'yt') {
    playYouTube(message, args);
  } else if (command === 'spotify') {
    playSpotify(message, args);
  }
});

client.login(token);
