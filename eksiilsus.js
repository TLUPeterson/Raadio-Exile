// main.js
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, Collection
} = require('discord.js');
const { getVoiceConnection, VoiceConnectionStatus, AudioPlayerStatus, entersState } = require('@discordjs/voice');
const radio = require('./radio');
const youtube = require('./yt');
const spotify = require('./spotify'); // Assuming spotify functions exist or are placeholders
require('dotenv').config();

const client = new Client({
  intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
  ],
});

const prefix = process.env.PREFIX || '!';
const token = process.env.TOKEN;

const guildStates = new Collection();

client.once(Events.ClientReady, c => {
  console.log(`Logged in as ${c.user.tag}!`);
  guildStates.clear(); // Clear state on restart
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/g);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  if (command === 'raadio' || command === 'radio') {
      await radio.showRadioInterface(message); // Send the initial interface
  } else if (command === 'yt' || command === 'youtube') {
      if (!args.length) return message.reply("Palun sisesta YouTube'i otsingufraas või link.");

      // --- Delete potential radio message when starting YouTube ---
      const stateForYt = guildStates.get(guildId);
      if (stateForYt && stateForYt.nowPlayingRadioMsgId && stateForYt.textChannel) {
           try {
              const radioMsg = await stateForYt.textChannel.messages.fetch(stateForYt.nowPlayingRadioMsgId);
              await radioMsg.delete();
              console.log(`[YouTube Cmd] Deleted radio message ${stateForYt.nowPlayingRadioMsgId}`);
              stateForYt.nowPlayingRadioMsgId = null;
           } catch (e) {
               if (e.code !== 10008) console.warn("Couldn't delete radio msg before YT:", e.message);
               if (stateForYt) stateForYt.nowPlayingRadioMsgId = null; // Clear ID anyway
           }
      }

      await youtube.playYouTube(message, args, guildStates); // Play YT
      const state = guildStates.get(guildId); // Re-fetch state
      if (state) { // Ensure state exists after playYouTube call
          // Setup listeners if not already attached
          if (state.connection && !state.connectionListenersAttached) {
              setupGuildConnectionListeners(guildId, guildStates);
              state.connectionListenersAttached = true;
          }
          if (state.player && !state.playerListenersAttached) {
              setupGuildPlayerListeners(guildId, guildStates);
              state.playerListenersAttached = true;
          }
      }
  } else if (command === 'spotify') {
      // await spotify.playSpotify(message, args, guildStates); // Placeholder
  } else if (command === 'skip') {
      await youtube.skipSong(message, guildStates);
  } else if (command === 'stop' || command === 'leave') {
      await stopPlayback(message.guildId, guildStates, message); // Pass message for context
  } else if (command === 'queue' || command === 'q') {
      await youtube.showQueue(message, guildStates);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guildId || !interaction.channel) return; // Ensure guild and channel context

  const guildId = interaction.guildId;

  // --- String Select Menu Handler (Radio Selection) ---
  if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'radio_select_menu') {
          const selectedChannelKey = interaction.values[0];
          if (radio.radioChannels[selectedChannelKey]) {

              // Call playRadioStream - It will defer and handle sending the new message
              // We don't need to await this directly if deferReply is used inside
              radio.playRadioStream(interaction, selectedChannelKey, guildStates);

              // Setup listeners after playRadioStream potentially creates connection/player
              // Need to re-fetch state as playRadioStream might create it
              const updatedState = guildStates.get(guildId);
              if (updatedState) {
                  if (updatedState.connection && !updatedState.connectionListenersAttached) {
                      setupGuildConnectionListeners(guildId, guildStates);
                      updatedState.connectionListenersAttached = true;
                  }
                  if (updatedState.player && !updatedState.playerListenersAttached) {
                      setupGuildPlayerListeners(guildId, guildStates);
                      updatedState.playerListenersAttached = true;
                  }
              }

              // Disable components on the ORIGINAL message where the select menu was clicked
              try {
                  // Check if the original message still exists
                  if (interaction.message) {
                       // No need to fetch, interaction.message is the message object
                      await interaction.message.edit({ components: radio.disableComponents(interaction.message.components) });
                  }
              } catch (e) {
                   if (e.code !== 10008) { // Ignore "Unknown Message"
                      console.error("Couldn't disable components after selection:", e);
                   }
              }
          } else {
               // Respond ephemerally to the interaction
              await interaction.reply({ content: 'Tundmatu valik.', ephemeral: true });
          }
      }
      return; // End processing for select menu
  }

  // --- Button Handler ---
  if (interaction.isButton()) {
      const customId = interaction.customId;

      // --- Radio Stop Button ---
      if (customId === 'radio_stop') {
          // Defer the interaction - stopPlayback will handle the final response
          // await interaction.deferReply({ ephemeral: false }); // Make it public if needed

          // Stop playback and delete the message - Pass interaction for context
          await stopPlayback(guildId, guildStates, interaction);

          // Disable components on the ORIGINAL message where the stop button was clicked
          try {
               if (interaction.message) {
                  await interaction.message.edit({ components: radio.disableComponents(interaction.message.components) });
               }
          } catch (e) {
               if (e.code !== 10008) {
                  console.error("Couldn't disable components after stop button:", e);
               }
          }
      }
      // --- Radio Random Button ---
      else if (customId === 'radio_random') {
          const radioKeys = Object.keys(radio.radioChannels).filter(key => key !== 'stop');
          if (radioKeys.length > 0) {
              const randomKey = radioKeys[Math.floor(Math.random() * radioKeys.length)];

              // Call playRadioStream - It will defer and send the new message
               // Don't await directly here
              radio.playRadioStream(interaction, randomKey, guildStates);

               // Setup listeners after playRadioStream potentially creates connection/player
              const updatedState = guildStates.get(guildId); // Re-fetch state
              if (updatedState) {
                  if (updatedState.connection && !updatedState.connectionListenersAttached) {
                      setupGuildConnectionListeners(guildId, guildStates);
                      updatedState.connectionListenersAttached = true;
                  }
                  if (updatedState.player && !updatedState.playerListenersAttached) {
                      setupGuildPlayerListeners(guildId, guildStates);
                      updatedState.playerListenersAttached = true;
                  }
              }

               // Disable components on the ORIGINAL message where the random button was clicked
              try {
                  if (interaction.message) {
                     await interaction.message.edit({ components: radio.disableComponents(interaction.message.components) });
                  }
              } catch (e) {
                  if (e.code !== 10008) {
                     console.error("Couldn't disable components after random play:", e);
                  }
              }
          } else {
              // Respond ephemerally
              await interaction.reply({ content: 'Pole ühtegi raadiojaama, mida juhuslikult valida.', ephemeral: true });
          }
      }
      return; // End processing for buttons
  }
});


// --- Modified stopPlayback Function ---
async function stopPlayback(guildId, states, context) {
  const state = states.get(guildId);
  let replyContent = 'Midagi polnud mängimas.';
  let messageDeletedText = '';
  let useEphemeral = false; // Default to non-ephemeral reply

   // Determine context type (Interaction vs Message)
   const isInteraction = context?.type === ComponentType.Button || context?.isCommand?.() || context?.isContextMenuCommand?.() || context?.isStringSelectMenu?.();
   const replyChannel = context?.channel;

   // Defer interaction if it's one and not already deferred
   if (isInteraction && !context.deferred && !context.replied) {
       await context.deferReply({ ephemeral: false }).catch(console.error); // Defer publicly by default
       useEphemeral = false; // Match deferral
   } else if (isInteraction) {
       useEphemeral = context.ephemeral ?? false; // Respect existing ephemeral status if possible
   }


  // --- Delete the Now Playing Radio Message ---
  if (state && state.nowPlayingRadioMsgId && replyChannel) {
      try {
          const msgToDelete = await replyChannel.messages.fetch(state.nowPlayingRadioMsgId);
          await msgToDelete.delete();
          console.log(`[Stop] Deleted Now Playing radio message ${state.nowPlayingRadioMsgId}`);
          messageDeletedText = ' "Mängib nüüd (Raadio)" sõnum kustutatud.';
          state.nowPlayingRadioMsgId = null; // Clear the ID after successful deletion
      } catch (error) {
          if (error.code !== 10008) { // Ignore "Unknown Message"
              console.warn(`[Stop] Could not delete Now Playing radio message ${state.nowPlayingRadioMsgId}:`, error.message);
          }
          // Clear the ID even if deletion failed (message might be gone already)
          state.nowPlayingRadioMsgId = null;
      }
  }

  // --- Stop Player & Connection ---
  if (state) {
      clearTimeout(state.timeoutId); // Clear inactivity timeout
      let playerStopped = false;
      if (state.player) {
           if(state.player.state.status !== AudioPlayerStatus.Idle){
               state.player.stop(true); // Force stop
               console.log(`[Stop] Stopped player for guild ${guildId}`);
               playerStopped = true;
           }
           // Player listeners might automatically clean up on stop/idle,
           // but we ensure connection handling below.
      }

      let connectionDestroyed = false;
      if (state.connection) {
          if (state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              state.connection.destroy(); // Destroy the connection
              console.log(`[Stop] Destroyed connection for guild ${guildId}`);
              // The 'Destroyed' listener should handle deleting the state from `guildStates`
              connectionDestroyed = true;
          } else {
               // If connection already destroyed but state exists, remove state manually
               states.delete(guildId);
               console.log(`[Stop] Removed lingering state for already destroyed connection (Guild: ${guildId})`);
          }
      } else {
          // If no connection but state exists (should be rare), clean up state
          states.delete(guildId);
          console.log(`[Stop] Removed state without connection (Guild: ${guildId})`);
      }

       // Construct reply based on actions
       if (playerStopped && connectionDestroyed) {
          replyContent = 'Taasesitus peatatud ja ühendus katkestatud.';
       } else if (playerStopped) {
           replyContent = 'Taasesitus peatatud.';
       } else if (connectionDestroyed) {
           replyContent = 'Ühendus katkestatud.';
       } else {
           replyContent = 'Midagi aktiivset polnud, mida peatada (kuid state leiti ja puhastati).';
       }

  } else {
      // Attempt to destroy connection if no state exists (cleanup)
      const connection = getVoiceConnection(guildId);
      if (connection) {
          connection.destroy();
          replyContent = 'Ühendus katkestatud (state puudus).';
          console.log(`[Stop] Destroyed connection without state (Guild: ${guildId})`);
      } else {
           replyContent = 'Midagi polnud mängimas ega ühendatud.'; // Already default, but clearer
      }
  }

   replyContent; // Append message deletion info

  // --- Send Reply ---
  try {
      if (isInteraction) {
           // Edit the deferred reply or send a new one if not deferred
           if (context.deferred || context.replied) {
              await context.editReply({ content: replyContent, components: [] }); // Clear components if editing
           } else {
              await context.reply({ content: replyContent, ephemeral: useEphemeral });
           }
      } else if (replyChannel) {
          // If context was a Message, send to the channel
          await replyChannel.send(replyContent);
      }
  } catch (error) {
      console.error(`[Stop] Failed to send confirmation reply for guild ${guildId}:`, error);
      // Attempt secondary reply if initial failed (e.g., interaction expired)
      if (replyChannel && !isInteraction) {
           await replyChannel.send(replyContent + " (Vastus ebaõnnestus)").catch(console.error);
      }
  }
}


// --- Listener Setup Functions (remain the same) ---
function setupGuildPlayerListeners(guildId, states) {
  const state = states.get(guildId);
  if (!state || !state.player) {
      console.error(`[Listener Setup] No state or player found for guild ${guildId} during player listener setup.`);
      return;
  }

  // Remove existing listeners to prevent duplicates
  state.player.removeAllListeners(AudioPlayerStatus.Idle);
  state.player.removeAllListeners('error');
  state.player.removeAllListeners(AudioPlayerStatus.Playing);

  state.player.on(AudioPlayerStatus.Idle, (oldPlayerState) => {
      const currentState = states.get(guildId); // Get fresh state
      if (!currentState) return; // State might have been cleared

      console.log(`[Player] Idle transition detected for guild ${guildId}. Previous Status: ${oldPlayerState.status}, Current Source: ${currentState.currentSourceType}`);

      // Check if the player *was* actually playing before going idle
      // This prevents triggering queue logic if stop() was called manually
      if (oldPlayerState.status === AudioPlayerStatus.Playing) {
           if (currentState.currentSourceType === 'youtube' && currentState.queue?.length > 0) {
               console.log(`[Player] YouTube song finished or skipped (Idle from Playing). Playing next.`);
              // No need to shift here, playFromQueue handles it
               youtube.playFromQueue(guildId, states);
           } else if (currentState.currentSourceType === 'youtube' && (!currentState.queue || currentState.queue.length === 0)) {
               console.log(`[Player] YouTube queue finished (Idle from Playing). Setting inactivity timeout.`);
                currentState.currentSourceType = null; // Clear source type
                setInactivityTimeout(guildId, states); // Set timeout
           }
            else if (currentState.currentSourceType === 'radio') {
               console.log(`[Player] Radio stream went idle unexpectedly for guild ${guildId}. Setting inactivity timeout.`);
               currentState.currentSourceType = null; // Clear source type as stream ended
               // Delete the now playing message for radio since it stopped
               if(currentState.nowPlayingRadioMsgId && currentState.textChannel) {
                  currentState.textChannel.messages.delete(currentState.nowPlayingRadioMsgId)
                     .then(() => console.log(`[Player Idle] Deleted radio message ${currentState.nowPlayingRadioMsgId} as stream ended.`))
                     .catch(e => { if(e.code !== 10008) console.warn(`[Player Idle] Failed to delete radio message ${currentState?.nowPlayingRadioMsgId}:`, e.message)})
                     .finally(() => { if(currentState) currentState.nowPlayingRadioMsgId = null; });
               }
               setInactivityTimeout(guildId, states); // Set timeout
           } else {
               console.log(`[Player] Player went idle from playing state, but no known source or queue. Setting inactivity timeout.`);
                currentState.currentSourceType = null; // Clear source type
                setInactivityTimeout(guildId, states); // Set timeout
           }
      } else {
           // If player went idle from a state other than Playing (e.g., Buffering, Paused), just log it.
           // This can happen if stop(true) was called. The stopPlayback function handles cleanup.
           console.log(`[Player] Idle (was not Playing) for guild ${guildId}. Status: ${oldPlayerState.status}. No action needed from Idle listener.`);
      }
  });

  state.player.on('error', error => {
      const currentState = states.get(guildId);
      if (!currentState) return; // State might have been cleared

      console.error(`[Player] Error for guild ${guildId} (Source: ${currentState.currentSourceType}):`, error.message);

      if (currentState.currentSourceType === 'youtube') {
          currentState.textChannel?.send(`Mängimisel tekkis viga: ${error.message}. Proovin järgmist laulu.`).catch(console.error);
          // Don't shift here, playFromQueue handles it
          youtube.playFromQueue(guildId, states); // Try next song
      } else if (currentState.currentSourceType === 'radio') {
          currentState.textChannel?.send(`Raadio "${radio.radioChannels[currentState.lastPlayedRadioKey]?.name || 'jaama'}" mängimisel tekkis viga: ${error.message}. Peatan raadio.`).catch(console.error);
           // Delete the now playing message for radio since it errored
          if(currentState.nowPlayingRadioMsgId && currentState.textChannel) {
               currentState.textChannel.messages.delete(currentState.nowPlayingRadioMsgId)
                 .then(() => console.log(`[Player Error] Deleted radio message ${currentState.nowPlayingRadioMsgId} due to error.`))
                 .catch(e => {if(e.code !== 10008) console.warn(`[Player Error] Failed to delete radio msg ${currentState?.nowPlayingRadioMsgId}:`, e.message)})
                 .finally(() => { if(currentState) currentState.nowPlayingRadioMsgId = null; });
          }
          // Destroy connection on radio error
          if (currentState.connection && currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              currentState.connection.destroy(); // Let destroyed listener clean up state
          } else {
              states.delete(guildId); // Clean up state if no connection
          }
      } else {
           currentState.textChannel?.send(`Tekkis ootamatu viga pleieriga: ${error.message}. Peatan esituse.`).catch(console.error);
           if (currentState.connection && currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              currentState.connection.destroy();
           } else {
               states.delete(guildId);
           }
      }
  });

  state.player.on(AudioPlayerStatus.Playing, () => {
      const currentState = states.get(guildId);
      if (!currentState) return;
      console.log(`[Player] Started playing for guild ${guildId}. Source: ${currentState.currentSourceType}`);
      clearTimeout(currentState.timeoutId); // Clear inactivity timeout when playback starts/resumes
  });

  console.log(`[Listener Setup] Player listeners configured for guild ${guildId}`);
}

function setupGuildConnectionListeners(guildId, states) {
   const state = states.get(guildId);
  if (!state || !state.connection) {
      console.error(`[Listener Setup] No state or connection found for guild ${guildId} during connection listener setup.`);
      return;
  }

   // Remove existing listeners to prevent duplicates
   state.connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
   state.connection.removeAllListeners(VoiceConnectionStatus.Destroyed);


  state.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
       const currentState = states.get(guildId); // Get fresh state
       if (!currentState || !currentState.connection || currentState.connection.state.status === VoiceConnectionStatus.Destroyed) {
            console.log(`[Connection] Disconnected detected, but state/connection is gone or destroyed for ${guildId}. Ignoring.`);
            return; // Already destroyed or state cleared, nothing to do
       }

       console.warn(`[Connection] Disconnected for guild ${guildId}. Current state: ${currentState.connection.state.status}. Rejoin attempts: ${currentState.connection.rejoinAttempts || 0}`);

      // Check if the disconnection is recoverable (e.g., network issue) vs. intentional (kicked, channel deleted)
      // WebSocket closed with code 4014 usually means kicked or channel deleted. Don't try to rejoin.
      if (newState.closeCode === 4014) {
           console.warn(`[Connection] Disconnected with code 4014 (likely kicked or channel deleted) for guild ${guildId}. Destroying connection.`);
           // No need to await destroy here, just trigger it. The Destroyed listener will clean up.
           if (currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
              currentState.connection.destroy();
           }
           return;
      }


      // Use entersState for robust waiting, but handle potential promise rejections
      try {
          // Wait for a short period to see if it reconnects automatically or enters Destroyed state
           await entersState(currentState.connection, VoiceConnectionStatus.Connecting, 5_000);
           // If it enters Connecting, great, it might recover. Wait longer for Ready.
           console.log(`[Connection] Entered 'Connecting' state for ${guildId}. Waiting for 'Ready'...`);
           await entersState(currentState.connection, VoiceConnectionStatus.Ready, 15_000); // Wait up to 15s more for Ready
           console.log(`[Connection] Reconnected successfully (via state changes) for guild ${guildId}.`);
           currentState.connection.rejoinAttempts = 0; // Reset attempts on successful reconnect
      } catch (error) {
          // Error means it didn't reach the target state in time (Connecting or Ready)
          console.warn(`[Connection] Failed to automatically reconnect or connection timed out for guild ${guildId}: ${error.message}. Current status: ${currentState.connection?.state?.status}`);

          // Check status again *after* the wait
          if (!currentState.connection || currentState.connection.state.status === VoiceConnectionStatus.Destroyed) {
               console.log(`[Connection] Connection was destroyed during disconnect/reconnect attempt for ${guildId}. No further action.`);
               return;
          }

          // If still disconnected after waiting, destroy the connection permanently.
           if (currentState.connection.state.status === VoiceConnectionStatus.Disconnected) {
              console.warn(`[Connection] Still disconnected after waiting for ${guildId}. Destroying connection.`);
               if (currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                   currentState.connection.destroy();
               }
          }
      }
  });

  state.connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log(`[Connection] Destroyed for guild ${guildId}. Cleaning up state.`);
      const currentState = states.get(guildId); // Get state one last time
      if (currentState) {
          if (currentState.player) {
               currentState.player.stop(true); // Stop the player fully
               currentState.player.removeAllListeners(); // Remove all player listeners
          }
          clearTimeout(currentState.timeoutId); // Clear any pending timeout

          // Delete the now playing radio message if it exists when connection is destroyed
           if(currentState.nowPlayingRadioMsgId && currentState.textChannel) {
              currentState.textChannel.messages.delete(currentState.nowPlayingRadioMsgId)
                 .then(() => console.log(`[Connection Destroyed] Deleted radio message ${currentState.nowPlayingRadioMsgId}.`))
                 .catch(e => { if(e.code !== 10008) console.warn(`[Connection Destroyed] Failed to delete radio message ${currentState?.nowPlayingRadioMsgId}:`, e.message)})
                 .finally(() => {
                     // Even if deletion fails, remove the state entry
                      states.delete(guildId);
                      console.log(`[Connection Destroyed] State deleted for guild ${guildId}.`);
                  });
           } else {
                // If no message ID or text channel, just delete the state
                states.delete(guildId);
                console.log(`[Connection Destroyed] State deleted for guild ${guildId}.`);
           }
      } else {
           console.log(`[Connection Destroyed] No state found for guild ${guildId} during cleanup.`);
      }
  });

  console.log(`[Listener Setup] Connection listeners configured for guild ${guildId}`);
}

// --- Inactivity Timeout Function ---
function setInactivityTimeout(guildId, states) {
  const state = states.get(guildId);
  if (!state) return;

  clearTimeout(state.timeoutId); // Clear previous timeout just in case

  console.log(`[Timeout] Setting inactivity timer (5 minutes) for guild ${guildId}`);
  state.timeoutId = setTimeout(() => {
      const latestState = states.get(guildId);
      // Check if still idle/empty and connection exists
      if (latestState && latestState.connection && latestState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          // Verify player is idle or stopped, and queue is empty (for YT) or source is not radio
          const playerIdle = !latestState.player || latestState.player.state.status === AudioPlayerStatus.Idle;
          const queueEmpty = !latestState.queue || latestState.queue.length === 0;
          const notPlayingRadio = latestState.currentSourceType !== 'radio'; // Ensure radio didn't restart

           if (playerIdle && (queueEmpty || notPlayingRadio)) {
              console.log(`[Timeout] Leaving voice channel due to inactivity (Guild: ${guildId})`);
              latestState.textChannel?.send("Lahkusin häälekanalist passiivsuse tõttu.").catch(console.error);
              if (latestState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                   latestState.connection.destroy(); // Destroy connection, listener will clean up state
              } else {
                   states.delete(guildId); // If already destroyed, clean up state
              }
           } else {
               console.log(`[Timeout] Inactivity timer expired for ${guildId}, but bot is now active. Timeout cancelled.`);
           }
      } else {
           console.log(`[Timeout] Inactivity timer expired for ${guildId}, but state or connection is already gone. No action needed.`);
      }
  }, 300_000); // 5 minutes (300,000 ms)
}


// --- Process Signal Handling (remains the same) ---
process.on('SIGINT', () => {
  console.log("Shutting down: Cleaning up connections...");
  guildStates.forEach((state, guildId) => {
      if (state.connection && state.connection.state.status !== 'destroyed') {
          state.connection.destroy();
      }
  });
  client.destroy();
  console.log("Client destroyed. Exiting.");
  process.exit(0); // Ensure clean exit
});
process.on('exit', (code) => {
console.log(`Process exited with code: ${code}`);
});


client.login(token); // Login at the end