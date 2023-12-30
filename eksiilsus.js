const { Client, GatewayIntentBits } = require('discord.js');
const { AudioPlayerStatus, createAudioPlayer, joinVoiceChannel, createAudioResource } = require('@discordjs/voice');
const play = require('play-dl');
const https = require('https');
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

  const radioChannels = {
    'raadio2': 'https://icecast.err.ee/raadio2madal.mp3',
    'viker': 'https://icecast.err.ee/vikerraadiomadal.mp3',
    'kuku': 'https://le08.euddn.net/79b78be4e1816bef40e0908f8c2f9a90155ae56b748c3dee2332caf36204d6af17dafbf788e38cb194b274ef1ef30b1815488419930462f9f93e00cb86934efd0072e2bb0505b74ab2511be0f27b9f12799c1aa7fd6d95f6a3bb8d4aa6c275bb39807245e30e6e9747be619be448c339b1495016e93a3b26a4f5628f306d58b48a5785392db6862191c8cf94f3b45b5c8d0bf9463478531d7773a8530139623a7896af20acd286504dc8003ad43c5b58/kuku_low.mp3',
    'skyplus': 'https://edge03.cdn.bitflip.ee:8888/SKYPLUS?_i=c1283824',
    'elmar': 'https://le08.euddn.net/c1ea79029e3f6c126ea59b8e54d9eddec0b9a60e889060bffcfd373a5ee3afc81881f30782fd3d0580e7c0941c6a08d63dba1f5696e01048627e537db0661918a6103996b249df90ecae951f9341b2332893afe0dd1e1d62e12ac0e236276b1d593228e98f8e06dc91d712e9d490731010509ea4599b4fda7a86ea6d03c00a5d003f27b47c34ed2b075382cfd37c11621acd489749d4018c3db1d9fcb8b3e907c3dfe681832423d540786f3bd4173248/elmar_low.mp3',
    'retro': 'https://edge02.cdn.bitflip.ee:8888/RETRO',
    'power': 'https://ice.leviracloud.eu/phr96-aac',
    'rock': 'https://edge03.cdn.bitflip.ee:8888/rck?_i=c1283824',
    'starfm': 'https://ice.leviracloud.eu/star320-mp3',
  };

  if (command === 'raadio') {
    const channelNames = Object.keys(radioChannels);
    const randomChannelName = channelNames[Math.floor(Math.random() * channelNames.length)];

    let playedChannel = args[0] in radioChannels ? radioChannels[args[0]] : radioChannels[randomChannelName];
    message.reply('Mängib: ' + (args[0] || randomChannelName));

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Mine häälekanalisse.');
    }

    try {
      const connection = await joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

        https.get(playedChannel, (res) => {
          const resource = createAudioResource(res);
          player.play(resource);
          player.on(AudioPlayerStatus.Idle, () => {
            connection.destroy();
          });
        }).on('error', (err) => {
          console.error(err);
          connection.destroy();
        });
    } catch (err) {
      console.error(err);
      message.reply('Player error');
    }
  } else if (command === 'youtube') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Mine häälekanalisse.');
    }

    const connection = await joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    const query = args.join(' ');
    await playYouTubeVideo(query, connection, message);
  }
});

async function playYouTubeVideo(query, connection, message) {
  try {
    const videos = await play.search(query, { limit: 1 });

    if (!videos || videos.length === 0) {
      return message.reply('Videot ei leitud.');
    }

    const video = videos[0];
    const stream = await play.stream(video.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    const player = createAudioPlayer();
    player.play(resource);
    player.on(AudioPlayerStatus.Idle, () => {
      connection.destroy();
    });

    connection.subscribe(player);
  } catch (err) {
    console.error(err);
    message.reply('Midägi on katki :(');
  }
}

client.login(token);
