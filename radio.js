const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const https = require('https');

const playRadio = async (message, args) => {
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

  const channelNames = Object.keys(radioChannels);
  const randomChannelName = channelNames[Math.floor(Math.random() * channelNames.length)];

  let playedChannel = args[0] in radioChannels ? radioChannels[args[0]] : radioChannels[randomChannelName];

  const voiceChannel = message.member.voice.channel;
  //Join voice channel
  if (!voiceChannel) {
    return message.reply('Liitu häälekanaliga!');
  }

  try {
    const connection = await joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);
    message.reply(`Naudi: ${randomChannelName}`);

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
    //Error with radio
    console.error(err);
    message.reply('Radio error');
  }
};

module.exports = {
  playRadio,
};
