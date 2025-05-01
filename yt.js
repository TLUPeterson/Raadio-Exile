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
      state = { connection: null, player: null, queue: [], currentSourceType: null, textChannel: null, timeoutId: null, connectionListenersAttached: false, playerListenersAttached: false };
      guildStates.set(guildId, state);
  }

  state.textChannel = message.channel;
  clearTimeout(state.timeoutId);

  try {
      if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed || state.connection.state.status === VoiceConnectionStatus.Disconnected) {
          console.log(`[YT] Joining/Rejoining voice channel: ${voiceChannel.name} (Guild: ${guildId})`);
          if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
               state.connection.destroy(); // Destroy old one before creating new
          }
          state.connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guildId,
              adapterCreator: message.guild.voiceAdapterCreator,
          });
          state.connectionListenersAttached = false; // Mark listeners as needing attachment
          state.connection.rejoinAttempts = 0; // Reset rejoin attempts
      } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
          return message.reply(`Olen juba teises kanalis (${message.guild.channels.cache.get(state.connection.joinConfig.channelId)?.name}). Liiguta mind või kasuta \`!stop\` ja proovi uuesti.`);
      }
      await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);

  } catch (err) {
      console.error(`[YT] Error joining/connecting to voice channel for guild ${guildId}:`, err);
      if (state.connection && state.connection.state.status !== 'destroyed') state.connection.destroy();
      guildStates.delete(guildId);
      return message.reply('Ei saanud häälekanaliga ühendust luua.');
  }

  try {
      await message.react('🔍');
      const searchResults = await play.search(query, { limit: 1, source : { youtube : 'video' } });
      await message.reactions.removeAll().catch(()=>{});

      if (!searchResults || searchResults.length === 0) {
          return message.reply('Ei leidnud selle päringuga YouTube videot.');
      }
      const video = searchResults[0];
      addToQueue(message, video, guildId, guildStates);

  } catch (searchErr) {
      console.error(`[YT] Error searching YouTube for guild ${guildId}:`, searchErr);
      await message.reactions.removeAll().catch(()=>{});
      message.reply('YouTube otsingul tekkis viga.');
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

  message.channel.send({ embeds: [queueEmbed] });

  if (!state.player || state.player.state.status === AudioPlayerStatus.Idle || state.currentSourceType !== 'youtube') {
      playFromQueue(guildId, guildStates);
  }
}

async function playFromQueue(guildId, guildStates) {
  const state = guildStates.get(guildId);
  if (!state || !state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
      console.log(`[YT Playback] No state or connection for guild ${guildId}, aborting playback.`);
      if(state) guildStates.delete(guildId);
      return;
  }

   // Ensure connection is ready before attempting to play
   try {
      if (state.connection.state.status !== VoiceConnectionStatus.Ready) {
          console.log(`[YT Playback] Connection not ready for guild ${guildId} (State: ${state.connection.state.status}). Waiting...`);
          await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
          console.log(`[YT Playback] Connection became ready for guild ${guildId}.`);
      }
   } catch (err) {
       console.error(`[YT Playback] Connection failed to become ready for guild ${guildId}:`, err);
       if (state.connection.state.status !== VoiceConnectionStatus.Destroyed) state.connection.destroy();
       guildStates.delete(guildId);
       return;
   }


  if (state.queue.length === 0) {
      console.log(`[YT Playback] Queue empty for guild ${guildId}.`);
      state.currentSourceType = null;
      state.timeoutId = setTimeout(() => {
          const currentState = guildStates.get(guildId);
          if (currentState && (!currentState.queue || currentState.queue.length === 0) && (!currentState.player || currentState.player.state.status === AudioPlayerStatus.Idle )) {
              if(currentState.connection && currentState.connection.state.status !== 'destroyed') {
                  currentState.connection.destroy();
                  console.log(`[YT Playback] Left voice channel due to inactivity (Guild: ${guildId})`);
              }
              guildStates.delete(guildId);
          }
      }, 300_000);

      if(state.textChannel) state.textChannel.send("YouTube järjekord on tühi.").catch(console.error);
      return;
  }

  if (state.player && state.currentSourceType && state.currentSourceType !== 'youtube') {
      console.log(`[YT Playback] Stopping previous source (${state.currentSourceType}) for guild ${guildId}`);
      state.player.stop(true);
  }

  state.currentSourceType = 'youtube';
  const video = state.queue[0];

  if (!state.player) {
      state.player = createAudioPlayer();
      state.playerListenersAttached = false; // Mark listeners as needing attachment
      state.connection.subscribe(state.player);
      console.log(`[YT Playback] Created new player for guild ${guildId}`);
  } else {
      if(!state.connection.subscription || state.connection.subscription.player !== state.player) {
           console.log(`[YT Playback] Resubscribing player for guild ${guildId}.`);
           state.connection.subscribe(state.player);
      }
  }

  try {
      console.log(`[YT Playback] Attempting to play: ${video.title} (Guild: ${guildId})`);
      const stream = await play.stream(video.url, { quality: 1 });
      const resource = createAudioResource(stream.stream, { inputType: stream.type });

      state.player.play(resource);

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
      console.error(`[YT Playback] Error playing ${video.title} for guild ${guildId}:`, error.message);
      if (state.textChannel) {
          state.textChannel.send(`Viga video '${video.title}' mängimisel: ${error.message}`).catch(console.error);
      }
      state.queue.shift();
      playFromQueue(guildId, guildStates);
  }
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
  message.reply(`Jätan vahele: ${skippedVideo.title}`);
  state.player.stop(true);
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

  message.channel.send({ embeds: [embed] });
}

module.exports = {
  playYouTube,
  playFromQueue,
  skipSong,
  showQueue,
};