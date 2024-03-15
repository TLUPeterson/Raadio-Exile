const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');

const playYouTube = async (message, args) => {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.reply('Liitu häälekanaliga!');
  }

  const connection = await joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
  });

  const query = args.join(' ');
  await playYouTubeVideo(query, connection, message);
};

async function playYouTubeVideo(query, connection, message) {
  try {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return message.reply('Mine häälekanalisse.');
    }

    const connection = await joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
    
      const videos = await play.search(query, { limit: 1 });
    
      if (!videos || videos.length === 0) {
        //No video found
        return message.reply('Videot ei leitud!');
      }

      const video = videos[0];
      try {
        const stream = await play.stream(video.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        const player = createAudioPlayer();
        player.play(resource);
        player.on(AudioPlayerStatus.Idle, () => {
          connection.destroy();
        });

        connection.subscribe(player);
        message.reply(`Mängib: ${video.title}`);
      } catch (streamError) {
        console.error('Error streaming video:', streamError.message);
        message.reply(`Error streaming video: ${streamError.message}`);
      }

  } catch (err) {
    console.error(err);
    message.reply('Something went wrong.');
  }
}

module.exports = {
  playYouTube,
};
