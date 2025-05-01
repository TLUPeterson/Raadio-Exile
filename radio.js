// radio.js
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, getVoiceConnection,
  AudioPlayerStatus, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, TextChannel } = require('discord.js');
const https = require('https');

// --- radioChannels object remains the same ---
const radioChannels = {
  'raadio2': { name: 'Raadio 2', url: 'https://icecast.err.ee/raadio2madal.mp3' },
  'viker': { name: 'Vikerraadio', url: 'https://icecast.err.ee/vikerraadiomadal.mp3' },
  'kuku': { name: 'Raadio Kuku', url: 'https://le08.euddn.net/79b78be4e1816bef40e0908f8c2f9a90155ae56b748c3dee2332caf36204d6af17dafbf788e38cb194b274ef1ef30b1815488419930462f9f93e00cb86934efd0072e2bb0505b74ab2511be0f27b9f12799c1aa7fd6d95f6a3bb8d4aa6c275bb39807245e30e6e9747be619be448c339b1495016e93a3b26a4f5628f306d58b48a5785392db6862191c8cf94f3b45b5c8d0bf9463478531d7773a8530139623a7896af20acd286504dc8003ad43c5b58/kuku_low.mp3' },
  'skyplus': { name: 'SkyPlus', url: 'https://edge03.cdn.bitflip.ee:8888/SKYPLUS?_i=c1283824' },
  'elmar': { name: 'Raadio Elmar', url: 'https://le08.euddn.net/c1ea79029e3f6c126ea59b8e54d9eddec0b9a60e889060bffcfd373a5ee3afc81881f30782fd3d0580e7c0941c6a08d63dba1f5696e01048627e537db0661918a6103996b249df90ecae951f9341b2332893afe0dd1e1d62e12ac0e236276b1d593228e98f8e06dc91d712e9d490731010509ea4599b4fda7a86ea6d03c00a5d003f27b47c34ed2b075382cfd37c11621acd489749d4018c3db1d9fcb8b3e907c3dfe681832423d540786f3bd4173248/elmar_low.mp3' },
  'retro': { name: 'Retro FM', url: 'https://edge02.cdn.bitflip.ee:8888/RETRO' },
  'power': { name: 'Power Hit Radio', url: 'https://ice.leviracloud.eu/phr96-aac' },
  'rock': { name: 'Rock FM', url: 'https://edge03.cdn.bitflip.ee:8888/rck?_i=c1283824' },
  'starfm': { name: 'Star FM', url: 'https://ice.leviracloud.eu/star320-mp3' },
  'vomba': { name: 'Võmba FM', url: 'https://c4.radioboss.fm:18123/stream' },
};


async function playRadioStream(interaction, channelKey, guildStates) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
      // Use followUp because we will defer the interaction
      await interaction.followUp({ content: 'Liitu esmalt häälekanaliga!', ephemeral: true });
      return;
  }

  const guildId = interaction.guildId;
  const channelInfo = radioChannels[channelKey];

  if (!channelInfo || !channelInfo.url) {
      console.error(`[Radio] Invalid channel key or missing URL for key: ${channelKey}`);
      await interaction.followUp({ content: 'Vigane raadiokanali valik.', ephemeral: true });
      return;
  }

  // --- Defer the interaction ---
  // Acknowledge the interaction quickly to avoid timeout
  await interaction.deferReply({ ephemeral: true }); // Ephemeral so "Bot is thinking..." isn't public

  let state = guildStates.get(guildId);
  if (!state) {
      state = { connection: null, player: null, queue: [], currentSourceType: null, textChannel: null, timeoutId: null, connectionListenersAttached: false, playerListenersAttached: false, nowPlayingRadioMsgId: null };
      guildStates.set(guildId, state);
  }

  state.textChannel = interaction.channel; // Keep track of the channel
  clearTimeout(state.timeoutId);

  // --- Delete Previous Now Playing Message ---
  if (state.nowPlayingRadioMsgId && state.textChannel) {
      try {
          const previousMessage = await state.textChannel.messages.fetch(state.nowPlayingRadioMsgId);
          if (previousMessage) {
              await previousMessage.delete();
              console.log(`[Radio] Deleted previous Now Playing message ${state.nowPlayingRadioMsgId} for guild ${guildId}`);
          }
      } catch (error) {
          if (error.code !== 10008) { // Ignore "Unknown Message" errors
              console.warn(`[Radio] Could not delete previous Now Playing message ${state.nowPlayingRadioMsgId} for guild ${guildId}:`, error.message);
          }
      } finally {
          state.nowPlayingRadioMsgId = null; // Ensure it's cleared
      }
  }

  // --- Manage Voice Connection ---
  try {
      if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed || state.connection.state.status === VoiceConnectionStatus.Disconnected) {
          console.log(`[Radio] Joining/Rejoining voice channel: ${voiceChannel.name} (Guild: ${guildId})`);
          if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              state.connection.destroy(); // Clean up old connection before creating new
          }
          state.connection = joinVoiceChannel({
              channelId: voiceChannel.id,
              guildId: guildId,
              adapterCreator: interaction.guild.voiceAdapterCreator,
              selfDeaf: true // Good practice to deafen the bot
          });
          state.connectionListenersAttached = false; // Reset flag for new connection
          state.connection.rejoinAttempts = 0; // Reset rejoin attempts
          // Listener setup should happen in main.js after this function confirms connection/player creation
      } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
          await interaction.editReply({ content: `Olen juba teises kanalis (${interaction.guild.channels.cache.get(state.connection.joinConfig.channelId)?.name}). Kasuta \`${process.env.PREFIX || '!'}stop\` ja proovi uuesti.`, ephemeral: true });
           // Do not clear nowPlayingRadioMsgId here, let stop handle it if needed
          return; // Stop execution if in another channel
      }
      await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000); // Wait for connection readiness

  } catch (err) {
      console.error(`[Radio] Error joining/connecting to voice channel for guild ${guildId}:`, err);
      if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          state.connection.destroy(); // Destroy connection on failure
      }
      guildStates.delete(guildId); // Clean up state on failure
      await interaction.editReply({ content: 'Ei saanud häälekanaliga ühendust luua.', ephemeral: true });
      return;
  }

  // --- Manage Player ---
  if (state.player && state.currentSourceType && state.currentSourceType !== 'radio') {
      console.log(`[Radio] Stopping previous source (${state.currentSourceType}) for guild ${guildId}`);
      state.player.stop(true); // Stop other sources like YouTube
      state.queue = []; // Clear queue if switching from YouTube
  }

  state.currentSourceType = 'radio'; // Set source type

  if (!state.player) {
      state.player = createAudioPlayer();
      state.playerListenersAttached = false; // Reset flag for new player
      console.log(`[Radio] Created new player for guild ${guildId}`);
      // Listener setup should happen in main.js
  }

  // Ensure subscription exists
  if (!state.connection.subscription || state.connection.subscription.player !== state.player) {
       console.log(`[Radio] Subscribing player for guild ${guildId}.`);
      state.connection.subscribe(state.player);
  }


  // --- Send New "Now Playing" Message and Start Stream ---
  const streamUrl = channelInfo.url;
  console.log(`[Radio] Attempting to play stream: ${streamUrl} for channel: ${channelInfo.name} (Guild: ${guildId})`);

  let sentMessage; // To store the message object
  try {
      // Create initial embed
      const playEmbed = new EmbedBuilder()
          .setColor(Math.floor(Math.random() * 0xFFFFFF))
          .setTitle('Häälestun Raadiole...')
          .setDescription(`**${channelInfo.name}**`)
          .setFooter({ text: `Häälekanal: ${voiceChannel.name}` });

      // Send the new message
      sentMessage = await state.textChannel.send({ embeds: [playEmbed] });
      state.nowPlayingRadioMsgId = sentMessage.id; // Store the new message ID

      // Edit the deferred interaction reply (optional confirmation)
      await interaction.editReply({ content: `Häälestan kanalile **${channelInfo.name}**. Uus sõnum saadetud: ${sentMessage.url}`, ephemeral: true });

      // --- Start fetching and playing the stream ---
      https.get(streamUrl, (res) => {
           const currentState = guildStates.get(guildId); // Get potentially updated state
           if (!currentState || !currentState.player || currentState.currentSourceType !== 'radio') {
               console.log(`[Radio] State changed or player stopped before stream could start for ${guildId}. Aborting play.`);
               res.destroy(); // Stop fetching data
               // Delete the 'Häälestun...' message if it still exists and belongs to this attempt
               if (currentState && currentState.nowPlayingRadioMsgId === sentMessage.id && sentMessage) {
                   sentMessage.delete().catch(e => console.warn("Failed to delete 'Häälestun...' message after abort:", e.message));
                   currentState.nowPlayingRadioMsgId = null;
               } else if (!currentState && sentMessage){
                    sentMessage.delete().catch(e => console.warn("Failed to delete 'Häälestun...' message after abort (no state):", e.message));
               }
               return;
           }

          if (res.statusCode < 200 || res.statusCode >= 300) {
              console.error(`[Radio] Error fetching stream: Status Code ${res.statusCode} for ${streamUrl} (Guild: ${guildId})`);
               // Edit the sent message to show the error
               playEmbed.setTitle('Viga Raadio Striimiga')
                        .setDescription(`Ei saanud ühendust kanaliga **${channelInfo.name}** (HTTP ${res.statusCode}). Proovi teist jaama.`);
               sentMessage.edit({ embeds: [playEmbed] }).catch(console.error);
               // Keep the error message, but clear the ID so it's not deleted on next play/stop
               currentState.nowPlayingRadioMsgId = null;
               currentState.currentSourceType = null; // Indicate failure
              return;
          }

          const resource = createAudioResource(res, { inputType: 'arbitrary' });
          currentState.player.play(resource);
          console.log(`[Radio] Player started playing ${channelInfo.name} in guild ${guildId}`);

          // Update the message embed now that playing has started
          playEmbed.setTitle('Mängib Nüüd (Raadio)')
                   .setDescription(`**${channelInfo.name}**`);
          sentMessage.edit({ embeds: [playEmbed] }).catch(console.error); // Edit the message to confirm playback

      }).on('error', (err) => {
          console.error(`[Radio] HTTPS stream error for ${streamUrl} (Guild: ${guildId}):`, err);
           const currentState = guildStates.get(guildId);
          // Edit the sent message to show the error
          playEmbed.setTitle('Viga Raadio Striimiga')
                   .setDescription(`Tekkis viga ühendumisel kanaliga **${channelInfo.name}**: ${err.message}`);
          sentMessage.edit({ embeds: [playEmbed] }).catch(console.error);
           // Keep the error message, but clear the ID
           if(currentState) currentState.nowPlayingRadioMsgId = null;
           if(currentState) currentState.currentSourceType = null; // Indicate failure
          // Player error listener in main.js might also trigger and handle cleanup
      });

  } catch (err) {
      console.error(`[Radio] Error sending message or during stream setup for guild ${guildId}:`, err);
       await interaction.editReply({ content: 'Tekkis ootamatu viga raadio mängimisel.', ephemeral: true }).catch(console.error);
      // Clean up potentially sent message if error occurred after sending it
      if (state.nowPlayingRadioMsgId && sentMessage) {
           try { await sentMessage.delete(); } catch {}
           state.nowPlayingRadioMsgId = null;
      }
      // Clean up connection/state on major failure
      if (state.connection && state.connection.state.status !== 'destroyed') state.connection.destroy(); else guildStates.delete(guildId);
  }
}


// showRadioInterface remains the same as in your original code
async function showRadioInterface(message) {
  const radioKeys = Object.keys(radioChannels).filter(key => key !== 'stop');

  if (radioKeys.length === 0) {
      return message.reply("Raadiojaamu pole konfigureeritud.");
  }
   if (radioKeys.length > 25) {
      console.warn("[Radio] Warning: More than 25 radio channels defined. Only the first 25 will be shown.");
   }

  const selectOptions = radioKeys.slice(0, 25).map(key => {
      const channel = radioChannels[key];
      return new StringSelectMenuOptionBuilder()
          .setLabel(channel.name)
          .setValue(key);
  });

  const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('radio_select_menu')
      .setPlaceholder('Vali raadiojaam siit...')
      .addOptions(selectOptions);

  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  const randomButton = new ButtonBuilder()
      .setCustomId('radio_random')
      .setLabel('Juhuslik Jaam')
      .setStyle(ButtonStyle.Primary);

  const stopButton = new ButtonBuilder()
      .setCustomId('radio_stop')
      .setLabel('Peata Esitus')
      .setStyle(ButtonStyle.Danger);

  const buttonRow = new ActionRowBuilder().addComponents(randomButton, stopButton);

  try {
      await message.reply({
          content: 'Vali raadiojaam menüüst või kasuta nuppe:',
          components: [selectRow, buttonRow],
      });
  } catch (error) {
      console.error("[Radio] Failed to send radio interface:", error);
      message.reply("Vabandust, raadio liidese kuvamisel tekkis viga.");
  }
}

// disableComponents remains the same
function disableComponents(components) {
  if (!components) return [];
  return components.map(row => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components.forEach(component => {
          if (component.type === ComponentType.StringSelect || component.type === ComponentType.Button) {
              component.setDisabled(true);
          }
      });
      return newRow;
  });
}

module.exports = {
  radioChannels,
  playRadioStream,
  showRadioInterface,
  disableComponents,
};