// main.js
const {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, Collection
} = require('discord.js');
const {
  getVoiceConnection,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
  entersState
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const prism = require('prism-media');

const radio = require('./radio');
const youtube = require('./yt');
const spotify = require('./spotify');
const countries = require('./data/countries');
const { generateDependencyReport } = require('@discordjs/voice');
const { getAvailableStyleChoices } = require('./styleAvailability');

console.log("--- Dependency Report ---");
try { console.log(generateDependencyReport()); } catch (e) { console.log("Failed to generate report", e); }
console.log("-------------------------");

console.log("Attempting to require @snazzah/davey...");
try {
  require('@snazzah/davey');
  console.log("Success: @snazzah/davey loaded.");
} catch (e) {
  console.error("FAIL: Could not load @snazzah/davey:", e);
}

// Force pkg to include these:
try { require('sodium-native'); console.log("sodium-native loaded"); } catch (e) { console.error("sodium-native failed", e); }
const {
  showMainModeMenu,
  showCountryMenu,
  showStyleMenu
} = require('./ui');

const {
  showStationMenu,
  pickStation,
  playRandomWorld,
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
const announcementFolder = path.join(__dirname, 'audio', 'announcements');
const announcementIntervalMs = Number(process.env.ANNOUNCEMENT_INTERVAL_MS || 3_600_000);
const announcementExtensions = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
const MINUTE_MS = 60_000;
const GUILD_STATE_PRUNE_INTERVAL_MS = 10 * 60_000;

const guildStates = new Collection();
const radioSlashCommands = [
  {
    name: 'radio',
    description: 'Otsi raadiojaamu riigi ja stiili jargi',
    options: [
      {
        type: 3,
        name: 'country',
        description: 'Riik',
        required: true,
        autocomplete: true,
      },
      {
        type: 3,
        name: 'style',
        description: 'Stiil voi zhanr',
        required: true,
        autocomplete: true,
      },
    ],
  },
];

function filterAutocompleteChoices(options, focusedValue, toChoice) {
  const query = String(focusedValue || '').trim().toLowerCase();

  const choices = options
    .map((option) => toChoice(option))
    .filter((choice) => {
      if (!query) return true;
      return choice.name.toLowerCase().includes(query) || choice.value.toLowerCase().includes(query);
    });

  return choices.slice(0, 25);
}

async function registerGuildSlashCommands(clientInstance) {
  for (const guild of clientInstance.guilds.cache.values()) {
    try {
      const existingCommands = await guild.commands.fetch();

      for (const commandData of radioSlashCommands) {
        const existingCommand = existingCommands.find((command) => command.name === commandData.name);
        if (existingCommand) {
          await existingCommand.edit(commandData);
        } else {
          await guild.commands.create(commandData);
        }
      }
    } catch (error) {
      console.error(`[Slash Commands] Failed to register for guild ${guild.id}:`, error);
    }
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}!`);
  guildStates.clear();
  await registerGuildSlashCommands(c);
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    for (const commandData of radioSlashCommands) {
      await guild.commands.create(commandData);
    }
  } catch (error) {
    console.error(`[Slash Commands] Failed to register for new guild ${guild.id}:`, error);
  }
});

client.on(Events.Error, error => {
  console.error('[Client Error]', error);
});

process.on('unhandledRejection', error => {
  console.error('[Unhandled Rejection]', error);
});

process.on('uncaughtException', error => {
  console.error('[Uncaught Exception]', error);
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
      } catch (e) { }
      stateForYt.nowPlayingRadioMsgId = null;
    }

    await youtube.playYouTube(message, args, guildStates);
    attachListeners(guildId);
    return;
  }

  // ----- SPOTIFY (placeholder) -----
  if (command === 'spotify') {
    await spotify.playSpotify(message, args, guildStates);
    attachListeners(guildId);
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

  if (command === 'announce' || command === 'testannounce' || command === 'reklaam' ) {
    const state = guildStates.get(guildId);
    if (!state || state.currentSourceType !== 'radio') {
      await message.reply('Testteavitus tootab ainult siis, kui raadio juba mangib.');
      return;
    }

    const played = await playAnnouncementClip(guildId, guildStates, { force: true });
    if (played) {
    } else {
      const files = getAnnouncementFiles();
      if (files.length === 0) {
        await message.reply('Kaustas `audio/announcements` ei ole uhtegi toetatud helifaili.');
      } else {
        await message.reply('Teavitust ei saanud mangida. Kaivita raadio esmalt ja veendu, et bot on haalekanalis.');
      }
    }
    return;
  }
});

// ----------------------------------------------------------------------
// INTERACTION HANDLER
// ----------------------------------------------------------------------

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.guildId || !interaction.channel) return;

  const guildId = interaction.guildId;

  if (interaction.isAutocomplete() && interaction.commandName === 'radio') {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'country') {
      const choices = filterAutocompleteChoices(
        countries,
        focused.value,
        (country) => ({
          name: String(country.name),
          value: String(country.code),
        })
      );
      await interaction.respond(choices);
      return;
    }

    if (focused.name === 'style') {
      const country = interaction.options.getString('country');
      if (!country) {
        await interaction.respond([]);
        return;
      }

      const choices = await getAvailableStyleChoices(country, {
        limit: 25,
        query: focused.value,
        includeRandom: true,
        maxProbes: 8,
      });

      await interaction.respond(
        choices.map((choice) => ({
          name: choice.label,
          value: choice.value,
        }))
      );
      return;
    }
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'radio') {
    const country = interaction.options.getString('country', true);
    const style = interaction.options.getString('style', true);

    await showStationMenu(interaction, country, style, guildStates);
    return;
  }

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

      await showStationMenu(interaction, country, style, guildStates);
      return;
    }

    // --- STATION SELECT ---
    if (customId === 'radio_station_pick') {
      await pickStation(interaction, guildStates);
      attachListeners(guildId);

      // PERSISTENCE: Do NOT go back to main menu.
      // await showMainModeMenu(interaction.channel);
      return;
    }

    // --- ESTONIAN STATIC MENU ---
    if (customId === 'radio_select_menu') {
      const selectedChannelKey = interaction.values[0];

      if (radio.radioChannels[selectedChannelKey]) {
        // Immediate defer to prevent timeout
        await interaction.deferUpdate();

        radio.playRadioStream(interaction, selectedChannelKey, guildStates);
        attachListeners(guildId);

        // PERSISTENCE: keeping the menu active, so user can pick another one.
        // DO NOT call showMainModeMenu(interaction.channel);
        return;
      }
    }
  }

  // BUTTONS (STATIC INTERFACE)
  if (interaction.isButton()) {
    const id = interaction.customId;

    // --- BACK NAVIGATION ---
    if (id === 'radio_back_main') {
      // Pass interaction so it can update directly without deferring first if possible
      // or handle it if we passed it.
      await showMainModeMenu(interaction.channel, interaction);
      return;
    }

    if (id === 'radio_back_country') {
      // Back to Country request
      await showCountryMenu(interaction);
      return;
    }

    if (id.startsWith('radio_back_style:')) {
      const countryCode = id.split(':')[1];
      await showStyleMenu(interaction, countryCode);
      return;
    }


    if (id === 'radio_stop') {
      await stopPlayback(guildId, guildStates, interaction);
      // PERSISTENCE: Do NOT disable components. Let user play again.
      // try {
      //   await interaction.message.edit({
      //     components: radio.disableComponents(interaction.message.components)
      //   });
      // } catch (e) {}

      // Do NOT go back to main menu automatically
      // await showMainModeMenu(interaction.channel);
      return;
    }

    if (id === 'radio_random') {
      const radioKeys = Object.keys(radio.radioChannels).filter(k => k !== 'stop');

      if (radioKeys.length > 0) {
        const key = radioKeys[Math.floor(Math.random() * radioKeys.length)];
        await interaction.deferUpdate();
        radio.playRadioStream(interaction, key, guildStates);
        attachListeners(guildId);

        // PERSISTENCE: Keep menu active
        return;
      }
    }
  }
});

// ----------------------------------------------------------------------
// SHARED LISTENER ATTACHMENT
// ----------------------------------------------------------------------

function attachListeners(guildId) {
  pruneGuildStates(guildStates);
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

  ensureAnnouncementScheduler(guildId, guildStates);
}

function isConnectionActive(connection) {
  if (!connection) return false;
  return connection.state.status !== VoiceConnectionStatus.Destroyed;
}

function isPlayerActive(player, currentSourceType) {
  if (!player) return false;
  if (currentSourceType === 'radio' || currentSourceType === 'announcement') {
    return true;
  }

  return player.state.status !== AudioPlayerStatus.Idle;
}

function isGuildStateDisposable(state) {
  if (!state) return true;
  if (isConnectionActive(state.connection)) return false;
  if (isPlayerActive(state.player, state.currentSourceType)) return false;
  if (state.announcementIntervalId) return false;
  if (state.timeoutId) return false;
  if (state.isAnnouncementPlaying) return false;
  if (state.resumeRadioAfterAnnouncement) return false;
  if (state.queue?.length) return false;
  if (state.currentSourceType) return false;
  return true;
}

function pruneGuildStates(states) {
  for (const [guildId, state] of states.entries()) {
    if (isGuildStateDisposable(state)) {
      states.delete(guildId);
    }
  }
}

function getAnnouncementFiles() {
  try {
    return fs.readdirSync(announcementFolder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && announcementExtensions.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(announcementFolder, entry.name));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[Announcements] Failed to read announcement folder:', error.message);
    }
    return [];
  }
}

function clearAnnouncementScheduler(state) {
  if (state?.announcementIntervalId) {
    clearTimeout(state.announcementIntervalId);
    state.announcementIntervalId = null;
  }
}

function getAlignedAnnouncementDelayMs(intervalMs, now = new Date()) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  if (intervalMs % MINUTE_MS !== 0) {
    return intervalMs;
  }

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const elapsedTodayMs = now.getTime() - midnight.getTime();
  const remainder = elapsedTodayMs % intervalMs;
  let delayMs = remainder === 0 ? intervalMs : intervalMs - remainder;
  if (delayMs <= 0) {
    delayMs = intervalMs;
  }

  return delayMs;
}

function scheduleNextAnnouncement(guildId, states) {
  const state = states.get(guildId);
  if (!state) return;
  if (!Number.isFinite(announcementIntervalMs) || announcementIntervalMs <= 0) return;

  clearAnnouncementScheduler(state);

  const delayMs = getAlignedAnnouncementDelayMs(announcementIntervalMs);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;

  state.nextAnnouncementAt = Date.now() + delayMs;
  state.announcementIntervalId = setTimeout(() => {
    playAnnouncementClip(guildId, states).catch((error) => {
      console.error(`[Announcements] Failed for guild ${guildId}:`, error);
    }).finally(() => {
      scheduleNextAnnouncement(guildId, states);
    });
  }, delayMs);
}

function ensureAnnouncementScheduler(guildId, states) {
  const state = states.get(guildId);
  if (!state) return;
  if (!Number.isFinite(announcementIntervalMs) || announcementIntervalMs <= 0) return;
  if (state.announcementIntervalId) return;

  scheduleNextAnnouncement(guildId, states);
}

async function playAnnouncementClip(guildId, states, options = {}) {
  const { force = false } = options;
  const state = states.get(guildId);
  if (!state) return false;
  if (state.isAnnouncementPlaying) return false;
  if (!force && state.currentSourceType !== 'radio') return false;
  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) return false;
  if (!state.player) return false;

  const files = getAnnouncementFiles();
  if (files.length === 0) return false;

  const filePath = files[Math.floor(Math.random() * files.length)];
  const ffmpegStream = new prism.FFmpeg({
    args: [
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-i', filePath,
      '-map_metadata', '-1',
      '-c:a', 'libopus',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
    ],
  });
  const resource = createAudioResource(ffmpegStream, { inputType: StreamType.OggOpus });

  state.isAnnouncementPlaying = true;
  state.resumeRadioAfterAnnouncement = state.currentSourceType === 'radio' &&
    Boolean(state.lastPlayedRadioInfo || state.lastPlayedRadioKey);
  state.currentSourceType = 'announcement';
  clearTimeout(state.timeoutId);

  state.player.play(resource);
  return true;
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
    clearAnnouncementScheduler(state);
    clearTimeout(state.timeoutId);
    state.isAnnouncementPlaying = false;
    state.resumeRadioAfterAnnouncement = false;
    state.currentSourceType = null;
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
      if (currentState.currentSourceType === 'announcement') {
        currentState.isAnnouncementPlaying = false;

        if (currentState.resumeRadioAfterAnnouncement) {
          radio.resumeRadioStream(guildId, states)
            .then((resumed) => {
              if (!resumed) {
                setInactivityTimeout(guildId, states);
              }
            })
            .catch((error) => {
              console.error(`[Announcements] Could not resume radio for guild ${guildId}:`, error);
              setInactivityTimeout(guildId, states);
            });
          return;
        }
      }

      if (currentState.currentSourceType === 'youtube') {
        if (currentState.queue?.length > 0) {
          currentState.queue.shift();
        }

        if (currentState.queue?.length > 0) {
          youtube.playFromQueue(guildId, states);
        } else {
          currentState.currentSourceType = null;
          setInactivityTimeout(guildId, states);
        }
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

     if (currentState.currentSourceType === 'announcement') {
      currentState.isAnnouncementPlaying = false;
      if (currentState.resumeRadioAfterAnnouncement) {
        radio.resumeRadioStream(guildId, states).catch((resumeError) => {
          console.error(`[Announcements] Resume failed after player error for guild ${guildId}:`, resumeError);
          setInactivityTimeout(guildId, states);
        });
        return;
      }
    }

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
    clearAnnouncementScheduler(current);
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
    clearAnnouncementScheduler(state);
    if (state.connection && state.connection.state.status !== 'destroyed') {
      state.connection.destroy();
    }
  });
  client.destroy();
  console.log("Client destroyed. Exiting.");
  process.exit(0);
});

setInterval(() => {
  pruneGuildStates(guildStates);
}, GUILD_STATE_PRUNE_INTERVAL_MS);

process.on('exit', (code) => {
  console.log(`Process exited with code: ${code}`);
});

client.login(token);
