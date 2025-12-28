// main.js
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, Collection
} = require('discord.js');
const {
  getVoiceConnection,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState
} = require('@discordjs/voice');

const radio = require('./radio');
const youtube = require('./yt');
const spotify = require('./spotify');

const {
  showMainModeMenu,
  showCountryMenu,
  showStyleMenu,
  showStationMenu
} = require('./ui');

const {
  pickStation,
  playRandomWorld
} = require('./radioDynamic');

require('dotenv').config();

// ----------------------------------------------------------------------

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
  guildStates.clear();
});

// ----------------------------------------------------------------------
// MESSAGE COMMANDS
// ----------------------------------------------------------------------

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/g);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;

  // ----- MAIN RADIO ENTRY -----
  if (command === 'raadio' || command === 'radio') {
    await showMainModeMenu(message.channel);
    return;
  }

  // ----- YOUTUBE -----
  if (command === 'yt' || command === 'youtube') {
    if (!args.length) {
      return message.reply("Palun sisesta YouTube'i otsingusõna või link.");
    }

    const stateForYt = guildStates.get(guildId);
    if (stateForYt && stateForYt.nowPlayingRadioMsgId && stateForYt.textChannel) {
      try {
        const msg = await stateForYt.textChannel.messages.fetch(stateForYt.nowPlayingRadioMsgId);
        await msg.delete();
      } catch (e) {}
      stateForYt.nowPlayingRadioMsgId = null;
    }

    await youtube.playYouTube(message, args, guildStates);
    attachListeners(guildId);
    return;
  }

  // ----- SPOTIFY (placeholder) -----
  if (command === 'spotify') {
    return;
  }

  // ----- SKIP -----
  if (command === 'skip') {
    await youtube.skipSong(message, guildStates);
    return;
  }

  // ----- STOP -----
  if (command === 'stop' || command === 'leave') {
    await stopPlayback(guildId, guildStates, message);
    return;
  }

  // ----- QUEUE -----
  if (command === 'queue' || command === 'q') {
    await youtube.showQueue(message, guildStates);
    return;
  }
});

// ----------------------------------------------------------------------
// INTERACTION HANDLER
// ----------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guildId || !interaction.channel) return;

  const guildId = interaction.guildId;

  // STRING SELECT MENUS
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;

    // --- MODE SELECT ---
    if (customId === 'radio_mode') {
      const mode = interaction.values[0];

      // RANDOM WORLD
      if (mode === 'random_world') {
        await playRandomWorld(interaction, guildStates);
        attachListeners(guildId);

        await showMainModeMenu(interaction.channel);
        return;
      }

      // COUNTRY + STYLE FLOW
      if (mode === 'country_style') {
        await showCountryMenu(interaction);
        return;
      }

      // ESTONIAN STATIC
      if (mode === 'estonian') {
        await interaction.update({
          content: 'Avan Eesti eelseatud jaamad…',
          components: []
        });
        await radio.showRadioInterface(interaction.message);
        return;
      }
    }

    // --- COUNTRY SELECT ---
    if (customId === 'radio_country') {
      const country = interaction.values[0];
      await showStyleMenu(interaction, country);
      return;
    }

    // --- STYLE SELECT ---
    if (customId.startsWith('radio_style:')) {
      const country = customId.split(':')[1];
      const style = interaction.values[0];

      await showStationMenu(interaction, country, style);
      return;
    }

    // --- STATION SELECT ---
    if (customId === 'radio_station_pick') {
      await pickStation(interaction, guildStates);
      attachListeners(guildId);

      await showMainModeMenu(interaction.channel);
      return;
    }

    // --- ESTONIAN STATIC MENU ---
    if (customId === 'radio_select_menu') {
      const selectedChannelKey = interaction.values[0];

      if (radio.radioChannels[selectedChannelKey]) {
        radio.playRadioStream(interaction, selectedChannelKey, guildStates);
        attachListeners(guildId);

        try {
          await interaction.message.edit({
            components: radio.disableComponents(interaction.message.components)
          });
        } catch (e) {}

        await showMainModeMenu(interaction.channel);
        return;
      }
    }
  }

  // BUTTONS (STATIC INTERFACE)
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === 'radio_stop') {
      await stopPlayback(guildId, guildStates, interaction);
      try {
        await interaction.message.edit({
          components: radio.disableComponents(interaction.message.components)
        });
      } catch (e) {}
      await showMainModeMenu(interaction.channel);
      return;
    }

    if (id === 'radio_random') {
      const radioKeys = Object.keys(radio.radioChannels).filter(k => k !== 'stop');

      if (radioKeys.length > 0) {
        const key = radioKeys[Math.floor(Math.random() * radioKeys.length)];
        radio.playRadioStream(interaction, key, guildStates);
        attachListeners(guildId);

        try {
          await interaction.message.edit({
            components: radio.disableComponents(interaction.message.components)
          });
        } catch (e) {}

        await showMainModeMenu(interaction.channel);
        return;
      }
    }
  }
});

// ----------------------------------------------------------------------
// SHARED LISTENER ATTACHMENT
// ----------------------------------------------------------------------

function attachListeners(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;

  if (state.connection && !state.connectionListenersAttached) {
    setupGuildConnectionListeners(guildId, guildStates);
    state.connectionListenersAttached = true;
  }

  if (state.player && !state.playerListenersAttached) {
    setupGuildPlayerListeners(guildId, guildStates);
    state.playerListenersAttached = true;
  }
}

// ----------------------------------------------------------------------
// STOP PLAYBACK  (unchanged from your original)
// ----------------------------------------------------------------------

async function stopPlayback(guildId, states, context) {
  const state = states.get(guildId);
  let replyContent = 'Midagi polnud mängimas.';
  let useEphemeral = false;

  const isInteraction = context?.type === ComponentType.Button ||
    context?.isCommand?.() ||
    context?.isContextMenuCommand?.() ||
    context?.isStringSelectMenu?.();

  const replyChannel = context?.channel;

  if (isInteraction && !context.deferred && !context.replied) {
    await context.deferReply({ ephemeral: false }).catch(console.error);
    useEphemeral = false;
  } else if (isInteraction) {
    useEphemeral = context.ephemeral ?? false;
  }

  if (state && state.nowPlayingRadioMsgId && replyChannel) {
    try {
      const msgToDelete = await replyChannel.messages.fetch(state.nowPlayingRadioMsgId);
      await msgToDelete.delete();
      console.log(`[Stop] Deleted Now Playing radio message ${state.nowPlayingRadioMsgId}`);
      state.nowPlayingRadioMsgId = null;
    } catch (error) {
      if (error.code !== 10008) {
        console.warn(`[Stop] Could not delete Now Playing radio message ${state.nowPlayingRadioMsgId}:`, error.message);
      }
      state.nowPlayingRadioMsgId = null;
    }
  }

  if (state) {
    clearTimeout(state.timeoutId);
    let playerStopped = false;
    if (state.player) {
      if (state.player.state.status !== AudioPlayerStatus.Idle) {
        state.player.stop(true);
        console.log(`[Stop] Stopped player for guild ${guildId}`);
        playerStopped = true;
      }
    }

    let connectionDestroyed = false;
    if (state.connection) {
      if (state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        state.connection.destroy();
        console.log(`[Stop] Destroyed connection for guild ${guildId}`);
        connectionDestroyed = true;
      } else {
        states.delete(guildId);
        console.log(`[Stop] Removed lingering state for already destroyed connection (Guild: ${guildId})`);
      }
    } else {
      states.delete(guildId);
      console.log(`[Stop] Removed state without connection (Guild: ${guildId})`);
    }

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
    const connection = getVoiceConnection(guildId);
    if (connection) {
      connection.destroy();
      replyContent = 'Ühendus katkestatud (state puudus).';
      console.log(`[Stop] Destroyed connection without state (Guild: ${guildId})`);
    } else {
      replyContent = 'Midagi polnud mängimas ega ühendatud.';
    }
  }

  try {
    if (isInteraction) {
      if (context.deferred || context.replied) {
        await context.editReply({ content: replyContent, components: [] });
      } else {
        await context.reply({ content: replyContent, ephemeral: useEphemeral });
      }
    } else if (replyChannel) {
      await replyChannel.send(replyContent);
    }
  } catch (error) {
    console.error(`[Stop] Failed to send confirmation reply for guild ${guildId}:`, error);
    if (replyChannel && !isInteraction) {
      await replyChannel.send(replyContent + " (Vastus ebaõnnestus)").catch(console.error);
    }
  }
}


function setupGuildPlayerListeners(guildId, states) {
  const state = states.get(guildId);
  if (!state || !state.player) return;

  state.player.removeAllListeners(AudioPlayerStatus.Idle);
  state.player.removeAllListeners('error');
  state.player.removeAllListeners(AudioPlayerStatus.Playing);

  state.player.on(AudioPlayerStatus.Idle, (oldState) => {
    const currentState = states.get(guildId);
    if (!currentState) return;

    if (oldState.status === AudioPlayerStatus.Playing) {
      if (currentState.currentSourceType === 'youtube' && currentState.queue?.length > 0) {
        youtube.playFromQueue(guildId, states);
      } else {
        currentState.currentSourceType = null;
        setInactivityTimeout(guildId, states);
      }
    }
  });

  state.player.on('error', (err) => {
    const currentState = states.get(guildId);
    if (!currentState) return;

    console.error(`[Player Error] Guild ${guildId}:`, err.message);

    if (currentState.connection && currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      currentState.connection.destroy();
    }
    states.delete(guildId);
  });

  state.player.on(AudioPlayerStatus.Playing, () => {
    const currentState = states.get(guildId);
    if (currentState) clearTimeout(currentState.timeoutId);
  });
}

function setupGuildConnectionListeners(guildId, states) {
  const state = states.get(guildId);
  if (!state || !state.connection) return;

  state.connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  state.connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

  state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    const current = states.get(guildId);
    if (!current) return;

    try {
      await entersState(current.connection, VoiceConnectionStatus.Connecting, 5000);
      await entersState(current.connection, VoiceConnectionStatus.Ready, 15000);
    } catch {
      if (current.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        current.connection.destroy();
      }
    }
  });

  state.connection.on(VoiceConnectionStatus.Destroyed, () => {
    const current = states.get(guildId);
    if (!current) return;

    if (current.player) current.player.stop(true);
    clearTimeout(current.timeoutId);

    states.delete(guildId);
  });
}

function setInactivityTimeout(guildId, states) {
  const state = states.get(guildId);
  if (!state) return;

  clearTimeout(state.timeoutId);

  state.timeoutId = setTimeout(() => {
    const currentState = states.get(guildId);
    if (!currentState) return;

    if (currentState.connection && currentState.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      currentState.textChannel?.send("Lahkusin häälekanalist passiivsuse tõttu.");
      currentState.connection.destroy();
    }

    states.delete(guildId);
  }, 300_000); // 5 min
}

process.on('SIGINT', () => {
  console.log("Shutting down: Cleaning up connections...");
  guildStates.forEach((state, guildId) => {
    if (state.connection && state.connection.state.status !== 'destroyed') {
      state.connection.destroy();
    }
  });
  client.destroy();
  console.log("Client destroyed. Exiting.");
  process.exit(0);
});

process.on('exit', (code) => {
  console.log(`Process exited with code: ${code}`);
});

client.login(token);
