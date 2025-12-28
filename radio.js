// radio.js
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState
} = require('@discordjs/voice');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType
} = require('discord.js');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Static Estonian stations
const radioChannels = {
  'raadio2': { name: 'Raadio 2', url: 'https://icecast.err.ee/raadio2madal.mp3' },
  'viker':   { name: 'Vikerraadio', url: 'https://icecast.err.ee/vikerraadiomadal.mp3' },
  'kuku':    { name: 'Raadio Kuku', url: 'https://le08.euddn.net/79b78be4e1816bef40e0908f8c2f9a90155ae56b748c3dee2332caf36204d6af17dafbf788e38cb194b274ef1ef30b1815488419930462f9f93e00cb86934efd0072e2bb0505b74ab2511be0f27b9f12799c1aa7fd6d95f6a3bb8d4aa6c275bb39807245e30e6e9747be619be448c339b1495016e93a3b26a4f5628f306d58b48a5785392db6862191c8cf94f3b45b5c8d0bf9463478531d7773a8530139623a7896af20acd286504dc8003ad43c5b58/kuku_low.mp3' },
  'skyplus': { name: 'SkyPlus', url: 'https://edge03.cdn.bitflip.ee:8888/SKYPLUS?_i=c1283824' },
  'elmar':   { name: 'Raadio Elmar', url: 'https://le08.euddn.net/c1ea79029e3f6c126ea59b8e54d9eddec0b9a60e889060bffcfd373a5ee3afc81881f30782fd3d0580e7c0941c6a08d63dba1f5696e01048627e537db0661918a6103996b249df90ecae951f9341b2332893afe0dd1e1d62e12ac0e236276b1d593228e98f8e06dc91d712e9d490731010509ea4599b4fda7a86ea6d03c00a5d003f27b47c34ed2b075382cfd37c11621acd489749d4018c3db1d9fcb8b3e907c3dfe681832423d540786f3bd4173248/elmar_low.mp3' },
  'retro':   { name: 'Retro FM', url: 'https://edge02.cdn.bitflip.ee:8888/RETRO' },
  'power':   { name: 'Power Hit Radio', url: 'https://ice.leviracloud.eu/phr96-aac' },
  'rock':    { name: 'Rock FM', url: 'https://edge03.cdn.bitflip.ee:8888/rck?_i=c1283824' },
  'starfm':  { name: 'Star FM', url: 'https://ice.leviracloud.eu/star320-mp3' },
  'vomba':   { name: 'Võmba FM', url: 'https://c4.radioboss.fm:18123/stream' },
};

function getFinalStream(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = u.protocol === "https:" ? https : http;

    const req = client.request(
      u,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "*/*",
          "Icy-MetaData": "1",
          Connection: "keep-alive",
        },
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          maxRedirects > 0
        ) {
          res.destroy();
          return resolve(getFinalStream(res.headers.location, maxRedirects - 1));
        }

        if (res.statusCode === 200) return resolve(res);

        // Bubble up exact status for your error message
        res.resume(); // drain
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    );

    req.on("error", reject);
    req.end();
  });
}

// channelOrKey can be:
//  - string: key in radioChannels
//  - object: { name, url } from FMStream
async function playRadioStream(interaction, channelOrKey, guildStates) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    try {
      if (interaction.reply) {
        await interaction.reply({ content: 'Liitu esmalt häälekanaliga!', ephemeral: true });
      } else if (interaction.followUp) {
        await interaction.followUp({ content: 'Liitu esmalt häälekanaliga!', ephemeral: true });
      }
    } catch {}
    return;
  }

  const guildId = interaction.guildId;

  let channelInfo = null;
  let channelKey = null;

  if (typeof channelOrKey === 'string') {
    channelKey = channelOrKey;
    channelInfo = radioChannels[channelKey];
  } else if (channelOrKey && typeof channelOrKey === 'object') {
    channelInfo = channelOrKey;
  }

  if (!channelInfo || !channelInfo.url) {
    console.error('[Radio] Invalid channelOrKey:', channelOrKey);
    try {
      await interaction.reply({ content: 'Vigane raadiokanali valik.', ephemeral: true });
    } catch {}
    return;
  }

  // if (!interaction.deferred && !interaction.replied && interaction.deferreply) {
    // try {
      // await interaction.deferreply({ ephemeral: true });
    // } catch {}
  // }

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
      nowPlayingRadioMsgId: null,
      lastPlayedRadioKey: null,
    };
    guildStates.set(guildId, state);
  }

  state.textChannel = interaction.channel;
  if (channelKey) {
    state.lastPlayedRadioKey = channelKey;
  } else {
    state.lastPlayedRadioKey = null;
  }
  clearTimeout(state.timeoutId);

  // Delete previous now-playing message
  if (state.nowPlayingRadioMsgId && state.textChannel) {
    try {
      const previousMessage = await state.textChannel.messages.fetch(state.nowPlayingRadioMsgId);
      if (previousMessage) await previousMessage.delete();
      console.log(`[Radio] Deleted previous Now Playing message ${state.nowPlayingRadioMsgId} for guild ${guildId}`);
    } catch (error) {
      if (error.code !== 10008) {
        console.warn(`[Radio] Could not delete previous Now Playing message ${state.nowPlayingRadioMsgId}:`, error.message);
      }
    } finally {
      state.nowPlayingRadioMsgId = null;
    }
  }

  // Voice connection
  try {
    if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed || state.connection.state.status === VoiceConnectionStatus.Disconnected) {
      if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        state.connection.destroy();
      }
      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      state.connectionListenersAttached = false;
      state.connection.rejoinAttempts = 0;
    } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
      await interaction.editReply({
        content: `Olen juba teises kanalis (${interaction.guild.channels.cache.get(state.connection.joinConfig.channelId)?.name}). Kasuta \`${process.env.PREFIX || '!'}stop\` ja proovi uuesti.`,
        ephemeral: true,
      }).catch(() => {});
      return;
    }
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error(`[Radio] Error joining/connecting to voice channel for guild ${guildId}:`, err);
    if (state.connection && state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      state.connection.destroy();
    }
    guildStates.delete(guildId);
    await interaction.editReply({ content: 'Ei saanud häälekanaliga ühendust luua.', ephemeral: true }).catch(() => {});
    return;
  }

  // Player
  if (state.player && state.currentSourceType && state.currentSourceType !== 'radio') {
    state.player.stop(true);
    state.queue = [];
  }

  state.currentSourceType = 'radio';

  if (!state.player) {
    state.player = createAudioPlayer();
    state.playerListenersAttached = false;
  }

  if (!state.connection.subscription || state.connection.subscription.player !== state.player) {
    state.connection.subscribe(state.player);
  }

  const streamUrl = channelInfo.url;
  console.log(`[Radio] Attempting to play stream: ${streamUrl} for channel: ${channelInfo.name} (Guild: ${guildId})`);

  let sentMessage;
  try {
    const playEmbed = new EmbedBuilder()
      .setColor(Math.floor(Math.random() * 0xFFFFFF))
      .setTitle('Häälestun Raadiole...')
      .setDescription(`**${channelInfo.name}**`)
      .setFooter({ text: `Häälekanal: ${voiceChannel.name}` });

    sentMessage = await state.textChannel.send({ embeds: [playEmbed] });
    state.nowPlayingRadioMsgId = sentMessage.id;

    interaction.followUp?.({
      content: `Häälestan kanalile **${channelInfo.name}**.`,
      ephemeral: true
    }).catch(() => {});

    try {
      const res = await getFinalStream(streamUrl);

      const resource = createAudioResource(res, {
        inputType: 'arbitrary'
      });

      state.player.play(resource);

      playEmbed
        .setTitle('Mängib Nüüd (Raadio)')
        .setDescription(`**${channelInfo.name}**`);
      sentMessage.edit({ embeds: [playEmbed] }).catch(console.error);

    } catch (err) {
      console.error(`[Radio] Stream error for ${streamUrl}:`, err.message);

      playEmbed
        .setTitle('Viga Raadio Striimiga')
        .setDescription(`Ei saanud ühendust kanaliga **${channelInfo.name}**.`);
      sentMessage.edit({ embeds: [playEmbed] }).catch(console.error);

      state.currentSourceType = null;
      state.nowPlayingRadioMsgId = null;
    }


  } catch (err) {
    console.error(`[Radio] Error sending message or during stream setup for guild ${guildId}:`, err);
    await interaction.editReply({ content: 'Tekkis ootamatu viga raadio mängimisel.', ephemeral: true }).catch(console.error);
    if (state.nowPlayingRadioMsgId && sentMessage) {
      try { await sentMessage.delete(); } catch {}
      state.nowPlayingRadioMsgId = null;
    }
    if (state.connection && state.connection.state.status !== 'destroyed') state.connection.destroy(); else guildStates.delete(guildId);
  }
}

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
