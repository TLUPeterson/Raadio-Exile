// yt.js (replace your existing module)
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection,
  AudioPlayerStatus, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const { EmbedBuilder } = require('discord.js');
const play = require('play-dl');

async function playYouTube(message, args, guildStates) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
      return message.reply('Liitu esmalt häälekanaliga!');
  }

  const guildId = message.guild.id;
  const query = args.join(' ');

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
         nowPlayingRadioMsgId: null
      };
      guildStates.set(guildId, state);
  }

  state.textChannel = message.channel;
  clearTimeout(state.timeoutId);

  // Join / ensure connection
  try {
      // If there's an unusable connection, destroy it and create a new one
      if (!state.connection || state.connection.state?.status === VoiceConnectionStatus.Destroyed || state.connection.state?.status === VoiceConnectionStatus.Disconnected) {
          if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) {
              try { state.connection.destroy(); } catch (_) {}
          }

          state.connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guildId,
              adapterCreator: message.guild.voiceAdapterCreator,
          });
          state.connection.rejoinAttempts = 0;
          state.connectionListenersAttached = false; // main may attach listeners later
          console.log(`[YT] joinVoiceChannel called for guild ${guildId} (${voiceChannel.name})`);
      } else if (state.connection.joinConfig && state.connection.joinConfig.channelId !== voiceChannel.id) {
          return message.reply(`Olen juba teises kanalis (${message.guild.channels.cache.get(state.connection.joinConfig.channelId)?.name}). Liiguta mind või kasuta \`!stop\`.`);
      }

      // Wait until Ready
      await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
      console.error(`[YT] Error joining/connecting to voice channel for guild ${guildId}:`, err);
      try { if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) state.connection.destroy(); } catch (_) {}
      guildStates.delete(guildId);
      return message.reply('Ei saanud häälekanaliga ühendust luua.');
  }

  // Search YouTube
  try {
      await message.react('🔍').catch(()=>{});
      const searchResults = await play.search(query, { limit: 1, source: { youtube: 'video' } });
      await message.reactions.removeAll().catch(()=>{});

      if (!searchResults || searchResults.length === 0) {
          return message.reply('Ei leidnud selle päringuga YouTube videot.');
      }
      const video = searchResults[0];
      addToQueue(message, video, guildId, guildStates);

  } catch (searchErr) {
      console.error(`[YT] Error searching YouTube for guild ${guildId}:`, searchErr);
      await message.reactions.removeAll().catch(()=>{});
      return message.reply('YouTube otsingul tekkis viga.');
  }
}

function addToQueue(message, video, guildId, guildStates) {
  const state = guildStates.get(guildId);
  if (!state) return;

  state.queue.push(video);

  const queueEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('Lisatud Järjekorda')
      .setDescription(`[${video.title}](${video.url})\nKestus: ${video.durationRaw || 'N/A'}`)
      .setThumbnail(video.thumbnails?.[0]?.url)
      .setFooter({ text: `Lisas: ${message.author.tag}`});

  message.channel.send({ embeds: [queueEmbed] }).catch(console.error);

  // If there's no active youtube playback, start playing
  if (!state.player || state.player.state.status === AudioPlayerStatus.Idle || state.currentSourceType !== 'youtube') {
      playFromQueue(guildId, guildStates);
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

  // Ensure connection is Ready
  try {
      if (state.connection.state.status !== VoiceConnectionStatus.Ready) {
          console.log(`[YT Playback] Waiting for connection to be Ready for guild ${guildId}`);
          await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
      }
  } catch (err) {
      console.error(`[YT Playback] Connection did not become Ready for guild ${guildId}:`, err);
      try { if (state.connection && state.connection.state?.status !== VoiceConnectionStatus.Destroyed) state.connection.destroy(); } catch(_) {}
      guildStates.delete(guildId);
      return;
  }

  if (!state.queue || state.queue.length === 0) {
      console.log(`[YT Playback] Queue empty for guild ${guildId}`);
      state.currentSourceType = null;

      // set inactivity timeout (fallback)
      state.timeoutId = setTimeout(() => {
          const latestState = guildStates.get(guildId);
          if (latestState && latestState.connection && latestState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              const playerIdle = !latestState.player || latestState.player.state.status === AudioPlayerStatus.Idle;
              const queueEmpty = !latestState.queue || latestState.queue.length === 0;
              if (playerIdle && queueEmpty) {
                  latestState.textChannel?.send("YouTube järjekord on tühi, lahkun kanalist passiivsuse tõttu.").catch(console.error);
                  try { latestState.connection.destroy(); } catch(_) {}
              }
              guildStates.delete(guildId);
          }
      }, 300_000);
      if (state.textChannel) state.textChannel.send("YouTube järjekord on tühi.").catch(console.error);
      return;
  }

  // Stop other source if necessary
  if (state.player && state.currentSourceType && state.currentSourceType !== 'youtube') {
      console.log(`[YT Playback] Stopping previous source (${state.currentSourceType}) for guild ${guildId}`);
      try { state.player.stop(true); } catch(_) {}
  }

  state.currentSourceType = 'youtube';
  const video = state.queue[0];

  // Create player if missing
  if (!state.player) {
      state.player = createAudioPlayer();
      state.playerListenersAttached = false;
      // local minimal listeners so playback won't stall if main listeners aren't attached yet
      attachLocalPlayerListeners(guildId, guildStates);
      state.connection.subscribe(state.player);
      console.log(`[YT Playback] Created and subscribed new player for guild ${guildId}`);
  } else {
      // ensure subscription
      if (!state.connection.subscription || state.connection.subscription.player !== state.player) {
          state.connection.subscribe(state.player);
          console.log(`[YT Playback] Resubscribed player for guild ${guildId}`);
      }
  }

  try {
      console.log(`[YT Playback] Streaming: ${video.title} (${video.url}) for guild ${guildId}`);
      const stream = await play.stream(video.url, { quality: 1 }).catch(e => { throw e; });
      const resource = createAudioResource(stream.stream, { inputType: stream.type });

      state.player.play(resource);

      // Wait up to 5s for player to enter Playing state (helps catch errors)
      try {
          await entersState(state.player, AudioPlayerStatus.Playing, 5_000);
          console.log(`[YT Playback] Player now Playing for guild ${guildId}`);
      } catch (err) {
          console.warn(`[YT Playback] Player did not enter Playing state in time for guild ${guildId}:`, err?.message || err);
      }

      const playingEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('Mängib Nüüd (YouTube)')
          .setDescription(`[${video.title}](${video.url})\nKestus: ${video.durationRaw || 'N/A'}`)
          .setThumbnail(video.thumbnails?.[0]?.url)
          .setTimestamp();

      if (state.textChannel) {
          state.textChannel.send({ embeds: [playingEmbed] }).catch(console.error);
      }

  } catch (error) {
      console.error(`[YT Playback] Error playing ${video?.title || 'unknown'} for guild ${guildId}:`, error);
      if (state.textChannel) state.textChannel.send(`Viga video mängimisel: ${error.message || error}`).catch(console.error);
      // remove failing item and try next
      state.queue.shift();
      playFromQueue(guildId, guildStates);
  }
}

// Local minimal player listeners (so queue advances even if main's setup hasn't executed)
function attachLocalPlayerListeners(guildId, guildStates) {
  const state = guildStates.get(guildId);
  if (!state || !state.player) return;

  // Prevent multiple attachments
  if (state._localPlayerListenersAttached) return;
  state._localPlayerListenersAttached = true;

  state.player.on(AudioPlayerStatus.Idle, (oldState) => {
      const currentState = guildStates.get(guildId);
      if (!currentState) return;
      // only advance if previous was Playing
      if (oldState?.status === AudioPlayerStatus.Playing) {
          // shift the finished track
          currentState.queue.shift();
          // play next if exists
          if (currentState.queue && currentState.queue.length > 0) {
              setImmediate(() => playFromQueue(guildId, guildStates));
          } else {
              // nothing left — set timeout and clear source
              currentState.currentSourceType = null;
              if (currentState.textChannel) currentState.textChannel.send("Järjekord lõppes.").catch(console.error);
              // inactivity cleanup
              clearTimeout(currentState.timeoutId);
              currentState.timeoutId = setTimeout(() => {
                  const latest = guildStates.get(guildId);
                  if (latest && latest.connection && latest.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                      try { latest.connection.destroy(); } catch(_) {}
                      guildStates.delete(guildId);
                  }
              }, 300_000);
          }
      } else {
          console.log(`[YT Local Listener] Idle but previous status not Playing for guild ${guildId} (was ${oldState?.status})`);
      }
  });

  state.player.on('error', (err) => {
      const currentState = guildStates.get(guildId);
      if (!currentState) return;
      console.error(`[YT Local Listener] Player error for guild ${guildId}:`, err);
      currentState.textChannel?.send(`Pleieril viga: ${err.message || err}`).catch(console.error);
      // try to continue with next track
      if (currentState.queue && currentState.queue.length > 0) {
          currentState.queue.shift();
          setImmediate(() => playFromQueue(guildId, guildStates));
      } else {
          // no queue left, cleanup
          try { currentState.connection?.destroy(); } catch(_) {}
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
      return message.reply("Praegu ei mängi midagi.");
  }
  if (state.currentSourceType !== 'youtube') {
      return message.reply("Praegu ei mängi YouTube järjekorda, ei saa vahele jätta.");
  }
  if (!state.queue || state.queue.length <= 1) {
       if (!state.queue || state.queue.length === 0){
           return message.reply("Järjekord on tühi, midagi pole vahele jätta.");
       } else {
            return message.reply("Järjekorras pole rohkem laule, mida mängida peale praeguse.");
       }
  }

  const skippedVideo = state.queue[0];
  message.reply(`Jätan vahele: ${skippedVideo.title}`).catch(console.error);
  try { state.player.stop(true); } catch(e) { console.error('[skipSong] player.stop error', e); }
}

async function showQueue(message, guildStates) {
  const guildId = message.guild.id;
  const state = guildStates.get(guildId);

  if (!state || !state.queue || state.queue.length === 0) {
      return message.reply("Järjekord on tühi.");
  }

  const nowPlaying = state.queue[0];
  const upcoming = state.queue.slice(1, 11);

  const embed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle("Muusika Järjekord")
      .setDescription(`**Praegu Mängib:**\n[${nowPlaying.title}](${nowPlaying.url}) - ${nowPlaying.durationRaw || 'N/A'}\n\n` +
                   (upcoming.length > 0
                       ? `**Järgmisena (${upcoming.length}/${state.queue.length -1}):**\n` +
                         upcoming.map((video, index) => `${index + 1}. [${video.title}](${video.url}) - ${video.durationRaw || 'N/A'}`).join('\n')
                       : 'Rohkem laule järjekorras pole.'
                   ) +
                   (state.queue.length > 11 ? `\n...ja veel ${state.queue.length - 11} laulu.` : '')
                  )
       .setTimestamp();

  message.channel.send({ embeds: [embed] }).catch(console.error);
}

module.exports = {
  playYouTube,
  playFromQueue,
  skipSong,
  showQueue,
};
