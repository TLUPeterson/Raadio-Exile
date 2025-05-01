const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

async function playSpotify(message, args) {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.reply('Liitu häälekanaliga!');
  }

  const connection = await joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: message.guild.id,
    adapterCreator: message.guild.voiceAdapterCreator,
  });

  try {
    const accessToken = await getAccessToken(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET);
    spotifyApi.setAccessToken(accessToken);

    const query = args.join(' ');
    const searchResult = await spotifyApi.searchTracks(query, { limit: 1 });
    if (searchResult.body.tracks.total === 0) {
      return message.reply('Lugu ei leitud Spotifyst!');
    }

    const track = searchResult.body.tracks.items[0];
    playTrack(track, connection, message);
  } catch (err) {
    console.error(err);
    message.reply('Midagi läks valesti Spotify loo mängimisel.');
  }
}

async function playTrack(track, connection, message) {
  try {
    const stream = await spotifyApi.getTrack(track.id);
    if (!stream.body.preview_url) {
      throw new Error('No preview URL available for this track.');
    }
    
    const audioResource = createAudioResource(stream.body.preview_url, { inlineVolume: true });
    const player = createAudioPlayer();

    player.play(audioResource);
    connection.subscribe(player);
    
    player.on(AudioPlayerStatus.Idle, () => {
      connection.destroy();
    });

    message.reply(`Mängib: ${track.name}`);
  } catch (error) {
    console.error('Error playing track from Spotify:', error);
    message.reply(`Viga Spotify loo mängimisel: ${error.message}`);
  }
}


async function getAccessToken(clientId, clientSecret) {
    const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${authString}`
        },
        body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenResponse.json();
    return tokenData.access_token;
}

module.exports = {
  playSpotify,
};
