const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');

const queue = [];

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
  //await playYouTubeVideo(query, connection, message);
  await addToQueue(query, connection, message);

};

async function addToQueue(query, connection, message) {
  try {
    const videos = await play.search(query, { limit: 1 });
    if (!videos || videos.length === 0) {
      return message.reply('Videot ei leitud!');
    }
    
    const video = videos[0];
    const queueItem = { video, connection, message };
    queue.push(queueItem);

    if (queue.length === 1) {
      playFromQueue();
    } else {
      message.reply(`Lisatud järjekorda: ${video.title}`);
    }
  } catch (err) {
    console.error(err);
    message.reply('Something went wrong.');
  }
}

function skipSong(){
  if (queue.length === 0) {
    return message.reply('Järjekorda pole midagi, mida vahele jätta!');
  }
  
  const { connection, message } = queue[0];
  queue.shift(); // Remove the current song from the queue
  playFromQueue(); // Play the next song in the queue

}

function playFromQueue() {
  if (queue.length === 0) return;

  const { video, connection, message } = queue[0];
  const player = createAudioPlayer();
  player.on(AudioPlayerStatus.Idle, () => {
    queue.shift(); // Remove the current song from the queue
    playFromQueue(); // Play the next song in the queue
  });

  playVideo(video, connection, player, message);
}

async function playVideo(video, connection, player, message) {
  try {
    const stream = await play.stream(video.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    player.play(resource);
    connection.subscribe(player);
    message.reply(`Mängib: ${video.title}`);
  } catch (streamError) {
    console.error('Error streaming video:', streamError.message);
    message.reply(`Error streaming video: ${streamError.message}`);
  }
}


module.exports = {
  playYouTube,
  skipSong,
};
