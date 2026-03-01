require('dotenv').config();

const SpotifyWebApi = require('spotify-web-api-node');
const youtube = require('./yt');

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

let tokenExpiresAt = 0;

function parseSpotifyInput(input) {
  if (!input) return null;

  const trimmed = input.trim();
  const uriMatch = trimmed.match(/^spotify:(track|playlist):([A-Za-z0-9]+)$/);
  if (uriMatch) {
    return { type: uriMatch[1], id: uriMatch[2] };
  }

  try {
    const url = new URL(trimmed);
    if (!url.hostname.includes('spotify.com')) return null;

    const pathParts = url.pathname.split('/').filter(Boolean);
    const type = pathParts[0];
    const id = pathParts[1];
    if (!id || (type !== 'track' && type !== 'playlist')) return null;
    return { type, id };
  } catch {
    return null;
  }
}

async function ensureAccessToken() {
  if (Date.now() < tokenExpiresAt) return;

  const response = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(response.body.access_token);
  tokenExpiresAt = Date.now() + Math.max(0, (response.body.expires_in - 60) * 1000);
}

function buildYouTubeQuery(track) {
  const artistNames = (track.artists || []).map((artist) => artist.name).join(' ');
  return `${artistNames} ${track.name}`.trim();
}

async function resolveSpotifyTrack(input) {
  await ensureAccessToken();

  const parsed = parseSpotifyInput(input);
  if (parsed?.type === 'track') {
    const response = await spotifyApi.getTrack(parsed.id);
    return response.body;
  }

  const searchResponse = await spotifyApi.searchTracks(input, { limit: 1 });
  return searchResponse.body?.tracks?.items?.[0] || null;
}

async function resolveSpotifyPlaylist(input) {
  await ensureAccessToken();

  const parsed = parseSpotifyInput(input);
  if (parsed?.type !== 'playlist') {
    return null;
  }

  const playlistResponse = await spotifyApi.getPlaylist(parsed.id);
  const playlist = playlistResponse.body;
  const tracks = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const tracksResponse = await spotifyApi.getPlaylistTracks(parsed.id, { limit, offset });
    const items = tracksResponse.body?.items || [];
    tracks.push(
      ...items
        .map((item) => item.track)
        .filter((track) => track && track.type === 'track')
    );

    if (items.length < limit) break;
    offset += limit;
  }

  return { playlist, tracks };
}

async function playSpotify(message, args, guildStates) {
  if (!args.length) {
    return message.reply('Sisesta Spotify loo nimi, Spotify track link voi Spotify playlist link.');
  }

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return message.reply('Spotify kasutamiseks lisa `.env` faili `SPOTIFY_CLIENT_ID` ja `SPOTIFY_CLIENT_SECRET`.');
  }

  const input = args.join(' ');

  try {
    const playlistResult = await resolveSpotifyPlaylist(input);
    if (playlistResult) {
      const queries = playlistResult.tracks
        .map(buildYouTubeQuery)
        .filter(Boolean);

      if (queries.length === 0) {
        return message.reply('Selles Spotify playlistis ei ole mangitavaid lugusid.');
      }

      await message.channel.send(
        `Spotify playlist: **${playlistResult.playlist.name}**\nLisan YouTube jarkorda ${queries.length} lugu.`
      );

      const queueResults = await youtube.queueMultipleSearches(message, queries, guildStates);
      const successCount = queueResults.filter((result) => result.ok).length;
      const failedCount = queueResults.length - successCount;

      await message.channel.send(
        `Spotify playlist lisatud. Leidsin YouTube'ist ${successCount}/${queueResults.length} lugu.` +
        (failedCount > 0 ? ` ${failedCount} lugu jai leidmata.` : '')
      );
      return;
    }

    const track = await resolveSpotifyTrack(input);
    if (!track) {
      return message.reply('Spotifyst lugu ei leitud.');
    }

    const searchQuery = buildYouTubeQuery(track);
    const result = await youtube.queueFromSearch(message, searchQuery, guildStates);

    if (!result.ok) {
      if (result.reason === 'voice') return;
      if (result.reason === 'not_found') {
        return message.reply('Leidsin Spotify loo, aga ei leidnud sellele YouTube vastet.');
      }
      return message.reply('Spotify loo YouTube otsing ebaonnestus.');
    }

    await message.channel.send(
      `Spotify vaste: **${track.name}** - **${track.artists.map((artist) => artist.name).join(', ')}**\nLisatud YouTube jarkorda.`
    );
  } catch (error) {
    console.error('[Spotify] Playback resolution failed:', error);
    return message.reply(`Spotify loo toomisel tekkis viga: ${error.message}`);
  }
}

module.exports = {
  playSpotify,
};
