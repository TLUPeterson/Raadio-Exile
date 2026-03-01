const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const prism = require('prism-media');
const { Innertube, Platform, UniversalCache } = require('youtubei.js');

const execFileAsync = promisify(execFile);
let innertubePromise = null;
const pythonCommand = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');

if (typeof Platform?.shim?.eval !== 'function' || String(Platform.shim.eval).includes('throw')) {
  Platform.shim.eval = (code, env = {}) => {
    const exportedVars = {};
    const envAssignments = [];

    if (typeof env.sig === 'string') {
      envAssignments.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
    }

    if (typeof env.nsig === 'string') {
      envAssignments.push(`nsig: exportedVars.nsigFunction(${JSON.stringify(env.nsig)})`);
    }

    const wrappedCode = `${code}\nreturn { ${envAssignments.join(', ')} };`;
    const result = new Function('exportedVars', wrappedCode)(exportedVars);

    if (typeof env.sig === 'string') return result?.sig;
    if (typeof env.nsig === 'string') return result?.nsig;
    return result;
  };
}

function getOrCreateState(message, guildStates) {
  const guildId = message.guild.id;
  let state = guildStates.get(guildId);

  if (!state) {
    state = {
      connection: null,
      player: null,
      queue: [],
      currentSourceType: null,
      textChannel: null,
      timeoutId: null,
      connectionListenersAttached: false,
      playerListenersAttached: false,
      lastPlayedRadioKey: null,
      lastPlayedRadioInfo: null,
      nowPlayingRadioMsgId: null,
      announcementIntervalId: null,
      isAnnouncementPlaying: false,
      resumeRadioAfterAnnouncement: false,
      currentYtDlpProcess: null,
    };
    guildStates.set(guildId, state);
  }

  state.textChannel = message.channel;
  clearTimeout(state.timeoutId);
  return state;
}

function extractVideoId(input) {
  if (!input) return null;

  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    if (!/youtube\.com$|youtu\.be$/.test(url.hostname)) return null;

    if (url.hostname === 'youtu.be') {
      return url.pathname.split('/').filter(Boolean)[0] || null;
    }

    if (url.pathname === '/watch') {
      return url.searchParams.get('v');
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
      return parts[1] || null;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return [];
  return thumbnails
    .map((thumbnail) => {
      if (!thumbnail) return null;
      if (typeof thumbnail === 'string') return { url: thumbnail };
      return { url: thumbnail.url || thumbnail[0]?.url || null };
    })
    .filter((thumbnail) => thumbnail?.url);
}

function normalizeVideoFromInfo(info, fallbackUrl) {
  const basic = info?.basic_info || {};
  const videoId = basic.id || basic.video_id || extractVideoId(fallbackUrl);
  if (!videoId) return null;

  return {
    id: videoId,
    title: basic.title || 'Unknown title',
    url: fallbackUrl || `https://www.youtube.com/watch?v=${videoId}`,
    thumbnails: normalizeThumbnail(basic.thumbnail || basic.thumbnails),
    durationRaw: basic.duration || basic.duration_text || basic.duration_seconds?.toString() || 'N/A',
  };
}

function normalizeSearchVideo(video) {
  if (!video?.id) return null;

  const title =
    typeof video.title === 'string'
      ? video.title
      : video.title?.text || video.title?.toString?.() || 'Unknown title';

  const durationRaw =
    video.duration?.text ||
    video.duration?.toString?.() ||
    video.duration_text ||
    video.duration?.seconds?.toString?.() ||
    'N/A';

  return {
    id: video.id,
    title,
    url: `https://www.youtube.com/watch?v=${video.id}`,
    thumbnails: normalizeThumbnail(video.thumbnails || video.thumbnail),
    durationRaw,
  };
}

async function getInnertube() {
  if (!innertubePromise) {
    const config = {
      cache: new UniversalCache(false),
      retrieve_player: true,
    };

    if (process.env.YOUTUBE_COOKIE) {
      config.cookie = process.env.YOUTUBE_COOKIE;
    }

    innertubePromise = Innertube.create(config).catch((error) => {
      innertubePromise = null;
      throw error;
    });
  }

  return innertubePromise;
}

async function ensureVoiceConnection(message, guildStates) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('Liitu esmalt haale kanaliga!');
    return null;
  }

  const guildId = message.guild.id;
  const state = getOrCreateState(message, guildStates);

  try {
    if (
      !state.connection ||
      state.connection.state?.status === VoiceConnectionStatus.Destroyed ||
      state.connection.state?.status === VoiceConnectionStatus.Disconnected
    ) {
      if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
        try {
          state.connection.destroy();
        } catch (_) {}
      }

      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: message.guild.voiceAdapterCreator,
      });
      state.connection.rejoinAttempts = 0;
      state.connectionListenersAttached = false;
      console.log(`[YT] joinVoiceChannel called for guild ${guildId} (${voiceChannel.name})`);
    } else if (state.connection.joinConfig?.channelId !== voiceChannel.id) {
      await message.reply(
        `Olen juba teises kanalis (${message.guild.channels.cache.get(state.connection.joinConfig.channelId)?.name}). Liiguta mind voi kasuta \`!stop\`.`
      );
      return null;
    }

    await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
    return { guildId, state };
  } catch (error) {
    console.error(`[YT] Error joining/connecting to voice channel for guild ${guildId}:`, error);
    try {
      if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
        state.connection.destroy();
      }
    } catch (_) {}
    guildStates.delete(guildId);
    await message.reply('Ei saanud haale kanaliga ühendust luua.');
    return null;
  }
}

async function searchFirstVideo(query) {
  const innertube = await getInnertube();
  const videoId = extractVideoId(query);

  if (videoId) {
    const info = await innertube.getBasicInfo(videoId);
    return normalizeVideoFromInfo(info, `https://www.youtube.com/watch?v=${videoId}`);
  }

  const search = await innertube.search(query, { type: 'video' });
  const video = search.videos?.[0] || search.results?.find((result) => result?.id);
  return normalizeSearchVideo(video);
}

async function resolveYtDlpStreamUrl(videoUrl) {
  const { stdout } = await execFileAsync(pythonCommand, [
    '-m',
    'yt_dlp',
    '--js-runtimes',
    'node',
    '-f',
    'bestaudio/best',
    '-g',
    '--no-playlist',
    videoUrl,
  ], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });

  const directUrl = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!directUrl) {
    throw new Error('yt-dlp did not return a stream URL');
  }

  return directUrl;
}

function addToQueue(message, video, guildId, guildStates, options = {}) {
  const { announce = true } = options;
  const state = guildStates.get(guildId);
  if (!state || !video) return false;

  state.queue.push(video);

  if (announce) {
    const queueEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Lisatud jarkorda')
      .setDescription(`[${video.title}](${video.url})\nKestus: ${video.durationRaw || 'N/A'}`)
      .setThumbnail(video.thumbnails?.[0]?.url || null)
      .setFooter({ text: `Lisas: ${message.author.tag}` });

    message.channel.send({ embeds: [queueEmbed] }).catch(console.error);
  }

  if (!state.player || state.player.state.status === AudioPlayerStatus.Idle || state.currentSourceType !== 'youtube') {
    playFromQueue(guildId, guildStates);
  }

  return true;
}

async function queueFromSearch(message, query, guildStates, options = {}) {
  const connectionInfo = await ensureVoiceConnection(message, guildStates);
  if (!connectionInfo) return { ok: false, reason: 'voice' };

  try {
    const video = await searchFirstVideo(query);
    if (!video) {
      return { ok: false, reason: 'not_found', query };
    }

    addToQueue(message, video, connectionInfo.guildId, guildStates, options);
    return { ok: true, video, query };
  } catch (error) {
    console.error(`[YT] Error resolving YouTube video for guild ${connectionInfo.guildId}:`, error);
    return { ok: false, reason: 'search_error', query, error };
  }
}

async function queueMultipleSearches(message, queries, guildStates) {
  const results = [];
  for (const query of queries) {
    const result = await queueFromSearch(message, query, guildStates, { announce: false });
    results.push(result);
  }
  return results;
}

async function playYouTube(message, args, guildStates) {
  if (!args.length) {
    return message.reply("Palun sisesta YouTube'i otsingusona voi link.");
  }

  try {
    await message.react('🔍').catch(() => {});
    const result = await queueFromSearch(message, args.join(' '), guildStates);
    await message.reactions.removeAll().catch(() => {});

    if (!result.ok) {
      if (result.reason === 'voice') return;
      if (result.reason === 'not_found') {
        return message.reply('Ei leidnud selle paringuga YouTube videot.');
      }
      return message.reply('YouTube otsingul tekkis viga.');
    }
  } catch (error) {
    console.error('[YT] Unexpected playYouTube error:', error);
    await message.reactions.removeAll().catch(() => {});
    return message.reply('YouTube otsingul tekkis viga.');
  }
}

async function playFromQueue(guildId, guildStates) {
  const state = guildStates.get(guildId);
  if (!state) {
    console.log(`[YT Playback] No state for guild ${guildId}`);
    return;
  }

  if (!state.connection || state.connection.state?.status === VoiceConnectionStatus.Destroyed) {
    console.log(`[YT Playback] No usable connection for guild ${guildId}`);
    guildStates.delete(guildId);
    return;
  }

  try {
    if (state.connection.state.status !== VoiceConnectionStatus.Ready) {
      console.log(`[YT Playback] Waiting for connection to be Ready for guild ${guildId}`);
      await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
    }
  } catch (error) {
    console.error(`[YT Playback] Connection did not become Ready for guild ${guildId}:`, error);
    try {
      if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
        state.connection.destroy();
      }
    } catch (_) {}
    guildStates.delete(guildId);
    return;
  }

  if (!state.queue || state.queue.length === 0) {
    console.log(`[YT Playback] Queue empty for guild ${guildId}`);
    state.currentSourceType = null;
    state.timeoutId = setTimeout(() => {
      const latestState = guildStates.get(guildId);
      if (latestState && latestState.connection && latestState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        const playerIdle = !latestState.player || latestState.player.state.status === AudioPlayerStatus.Idle;
        const queueEmpty = !latestState.queue || latestState.queue.length === 0;
        if (playerIdle && queueEmpty) {
          latestState.textChannel?.send('YouTube jarkord on tuhi, lahkun kanalist passiivsuse tottu.').catch(console.error);
          try {
            latestState.connection.destroy();
          } catch (_) {}
        }
        guildStates.delete(guildId);
      }
    }, 300_000);

    state.textChannel?.send('YouTube jarkord on tuhi.').catch(console.error);
    return;
  }

  if (state.player && state.currentSourceType && state.currentSourceType !== 'youtube') {
    console.log(`[YT Playback] Stopping previous source (${state.currentSourceType}) for guild ${guildId}`);
    try {
      state.player.stop(true);
    } catch (_) {}
  }

  state.currentSourceType = 'youtube';
  const video = state.queue[0];

  if (!state.player) {
    state.player = createAudioPlayer();
    state.playerListenersAttached = false;
    attachLocalPlayerListeners(guildId, guildStates);
    state.connection.subscribe(state.player);
    console.log(`[YT Playback] Created and subscribed new player for guild ${guildId}`);
  } else if (!state.connection.subscription || state.connection.subscription.player !== state.player) {
    state.connection.subscribe(state.player);
    console.log(`[YT Playback] Resubscribed player for guild ${guildId}`);
  }

  try {
    console.log(`[YT Playback] Streaming: ${video.title} (${video.url}) for guild ${guildId}`);
    const streamUrl = await resolveYtDlpStreamUrl(video.url);
    const ffmpegStream = new prism.FFmpeg({
      args: [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-analyzeduration', '0',
        '-loglevel', '0',
        '-i', streamUrl,
        '-map_metadata', '-1',
        '-c:a', 'libopus',
        '-ar', '48000',
        '-ac', '2',
        '-f', 'ogg',
      ],
    });
    state.currentYtDlpProcess = ffmpegStream;

    const resource = createAudioResource(ffmpegStream, { inputType: StreamType.OggOpus });
    state.player.play(resource);

    try {
      await entersState(state.player, AudioPlayerStatus.Playing, 5_000);
      console.log(`[YT Playback] Player now Playing for guild ${guildId}`);
    } catch (error) {
      console.warn(`[YT Playback] Player did not enter Playing state in time for guild ${guildId}:`, error?.message || error);
    }

    const playingEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Mangib nuud (YouTube)')
      .setDescription(`[${video.title}](${video.url})\nKestus: ${video.durationRaw || 'N/A'}`)
      .setThumbnail(video.thumbnails?.[0]?.url || null)
      .setTimestamp();

    state.textChannel?.send({ embeds: [playingEmbed] }).catch(console.error);
  } catch (error) {
    console.error(`[YT Playback] Error playing ${video?.title || 'unknown'} for guild ${guildId}:`, error);
    state.textChannel?.send(`Viga video mangimisel: ${error.message || error}`).catch(console.error);
    state.queue.shift();
    playFromQueue(guildId, guildStates);
  }
}

function attachLocalPlayerListeners(guildId, guildStates) {
  const state = guildStates.get(guildId);
  if (!state || !state.player || state._localPlayerListenersAttached) return;

  state._localPlayerListenersAttached = true;

  state.player.on(AudioPlayerStatus.Idle, (oldState) => {
    const currentState = guildStates.get(guildId);
    if (!currentState) return;

    currentState.currentYtDlpProcess = null;

    if (oldState?.status === AudioPlayerStatus.Playing) {
      currentState.queue.shift();
      if (currentState.queue && currentState.queue.length > 0) {
        setImmediate(() => playFromQueue(guildId, guildStates));
      } else {
        currentState.currentSourceType = null;
        currentState.textChannel?.send('Jarkord loppes.').catch(console.error);
        clearTimeout(currentState.timeoutId);
        currentState.timeoutId = setTimeout(() => {
          const latest = guildStates.get(guildId);
          if (latest && latest.connection && latest.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try {
              latest.connection.destroy();
            } catch (_) {}
            guildStates.delete(guildId);
          }
        }, 300_000);
      }
    } else {
      console.log(`[YT Local Listener] Idle but previous status not Playing for guild ${guildId} (was ${oldState?.status})`);
    }
  });

  state.player.on('error', (error) => {
    const currentState = guildStates.get(guildId);
    if (!currentState) return;

    currentState.currentYtDlpProcess = null;
    console.error(`[YT Local Listener] Player error for guild ${guildId}:`, error);
    currentState.textChannel?.send(`Pleieril viga: ${error.message || error}`).catch(console.error);

    if (currentState.queue && currentState.queue.length > 0) {
      currentState.queue.shift();
      setImmediate(() => playFromQueue(guildId, guildStates));
    } else {
      try {
        currentState.connection?.destroy();
      } catch (_) {}
      guildStates.delete(guildId);
    }
  });

  state.player.on(AudioPlayerStatus.Playing, () => {
    const currentState = guildStates.get(guildId);
    if (!currentState) return;
    clearTimeout(currentState.timeoutId);
    console.log(`[YT Local Listener] Player started playing (guild ${guildId}).`);
  });
}

async function skipSong(message, guildStates) {
  const guildId = message.guild.id;
  const state = guildStates.get(guildId);

  if (!state || !state.player) {
    return message.reply('Praegu ei mangi midagi.');
  }
  if (state.currentSourceType !== 'youtube') {
    return message.reply('Praegu ei mangi YouTube jarkorda, ei saa vahele jatta.');
  }
  if (!state.queue || state.queue.length <= 1) {
    if (!state.queue || state.queue.length === 0) {
      return message.reply('Jarkord on tuhi, midagi pole vahele jatta.');
    }
    return message.reply('Jarkorras pole rohkem laule peale praeguse.');
  }

  const skippedVideo = state.queue[0];
  message.reply(`Jatan vahele: ${skippedVideo.title}`).catch(console.error);
  try {
    state.player.stop(true);
  } catch (error) {
    console.error('[skipSong] player.stop error', error);
  }
}

async function showQueue(message, guildStates) {
  const guildId = message.guild.id;
  const state = guildStates.get(guildId);

  if (!state || !state.queue || state.queue.length === 0) {
    return message.reply('Jarkord on tuhi.');
  }

  const nowPlaying = state.queue[0];
  const upcoming = state.queue.slice(1, 11);

  const embed = new EmbedBuilder()
    .setColor('#FF0000')
    .setTitle('Muusika jarkord')
    .setDescription(
      `**Praegu mangib:**\n[${nowPlaying.title}](${nowPlaying.url}) - ${nowPlaying.durationRaw || 'N/A'}\n\n` +
      (upcoming.length > 0
        ? `**Jargmisena (${upcoming.length}/${state.queue.length - 1}):**\n` +
          upcoming.map((video, index) => `${index + 1}. [${video.title}](${video.url}) - ${video.durationRaw || 'N/A'}`).join('\n')
        : 'Rohkem laule jarkorras pole.') +
      (state.queue.length > 11 ? `\n...ja veel ${state.queue.length - 11} laulu.` : '')
    )
    .setTimestamp();

  message.channel.send({ embeds: [embed] }).catch(console.error);
}

module.exports = {
  playYouTube,
  playFromQueue,
  queueFromSearch,
  queueMultipleSearches,
  skipSong,
  showQueue,
};
