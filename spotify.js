const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const { Client } = require('spotify-api.js');

const playSpotify = async (message, args) => {

const spotifyClient = await Client.create({ token: { clientID: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET } });
console.log(await spotifyClient.tracks.get('id'));

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
  await playSpotifyTrack(query, connection, message, spotifyClient);
};

async function playSpotifyTrack(query, connection, message, spotifyClient) {
    try {
      // Use the Spotify client to search for and retrieve track information
      console.log('Search query:', query);
      const tracks = await spotifyClient.tracks.search(query);
  
      // Filter out tracks without a preview URL
      const playableTracks = tracks.filter(track => track.preview_url);
  
      if (!playableTracks || playableTracks.length === 0) {
        console.log('No playable track found:', tracks);
        return message.reply('Couldn\'t find a playable track.');
      }
  
      // Select the first playable track
      const selectedTrack = playableTracks[0];
      
      // Use the track information to get the playable stream URL
      const streamUrl = selectedTrack.preview_url;
  
      // Fetch the stream (you may need to use an appropriate method to fetch the stream)
      const stream = await fetch(streamUrl);
  
      if (!stream) {
        console.log('Failed to fetch Spotify track stream:', stream);
        return message.reply('Failed to fetch the Spotify track stream.');
      }
  
      const resource = createAudioResource(stream);
      const player = createAudioPlayer();
      player.play(resource);
      player.on(AudioPlayerStatus.Idle, () => {
        connection.destroy();
      });
  
      connection.subscribe(player);
      message.reply(`Now playing Spotify track: ${selectedTrack.name}`);
    } catch (err) {
      console.error('Error playing Spotify track:', err.message);
      message.reply(`Error playing Spotify track: ${err.message}`);
    }
  }
  
  
  
  // ...
  

module.exports = {
  playSpotify,
};
