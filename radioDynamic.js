const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { fmstream } = require('./fmstream');
const countries = require('./data/countries');
const styles = require('./data/styles');
const radio = require('./radio');

function getOrCreateState(interaction, guildStates) {
  let state = guildStates.get(interaction.guildId);
  if (!state) {
    state = {
      connection: null,
      player: null,
      queue: [],
      currentSourceType: null,
      textChannel: interaction.channel,
      timeoutId: null,
      connectionListenersAttached: false,
      playerListenersAttached: false,
      nowPlayingRadioMsgId: null,
      lastPlayedRadioKey: null,
      lastPlayedRadioInfo: null,
      announcementIntervalId: null,
      isAnnouncementPlaying: false,
      resumeRadioAfterAnnouncement: false,
    };
    guildStates.set(interaction.guildId, state);
  }

  state.textChannel = interaction.channel;
  return state;
}

async function showCountryMenu(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_country')
    .setPlaceholder('Vali riik')
    .addOptions(
      countries.map((country) => ({
        label: country.name,
        value: country.code,
      }))
    );

  await interaction.update({
    content: 'Vali riik:',
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showStyleMenu(interaction, countryCode) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`radio_style:${countryCode}`)
    .setPlaceholder('Vali stiil/zhanr')
    .addOptions(styles);

  await interaction.update({
    content: `Valitud riik: **${countryCode}**\nVali nuud stiil/zhanr:`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showStationMenu(interaction, countryCode, style, guildStates) {
  let api;
  try {
    api = await fmstream({ c: countryCode, style, hq: 1 });
  } catch (error) {
    console.error('[FMStream] Error fetching stations:', error);
    return interaction.update({
      content: 'Tekkis viga jaamade parimisel. Proovi uuesti.',
      components: [],
    });
  }

  if (!api.data || api.data.length === 0) {
    const styleMenu = new StringSelectMenuBuilder()
      .setCustomId(`radio_style:${countryCode}`)
      .setPlaceholder('Vali muu stiil/zhanr')
      .addOptions(styles);

    return interaction.update({
      content: `Jaamu ei leitud riigile **${countryCode}** ja stiiliga **${style}**.\nVali moni muu stiil:`,
      components: [new ActionRowBuilder().addComponents(styleMenu)],
    });
  }

  const state = getOrCreateState(interaction, guildStates);
  state.stationSearch = {
    country: countryCode,
    style,
    stations: api.data,
  };

  const stations = api.data.slice(0, 25).map((station) => ({
    label: station.program.slice(0, 80),
    description: (station.description || 'Kirjeldus puudub').slice(0, 90),
    value: String(station.id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_station_pick')
    .setPlaceholder('Vali jaam')
    .addOptions(stations);

  await interaction.update({
    content: `Vali jaam (**${countryCode}**, stiil: ${style}):`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function pickStation(interaction, guildStates) {
  await interaction.deferUpdate();

  const state = guildStates.get(interaction.guildId);
  const stationId = interaction.values[0];
  const cache = state?.stationSearch?.stations;

  if (!cache) {
    return interaction.followUp({
      content: 'Jaamade nimekiri ei ole saadaval. Alusta uuesti riigi ja stiili valikust.',
      ephemeral: true,
    });
  }

  const station = cache.find((item) => String(item.id) === stationId);
  if (!station) {
    return interaction.followUp({
      content: 'Jaama ei leitud. Proovi uuesti.',
      ephemeral: true,
    });
  }

  const stream = station.urls?.[0]?.url || station.urls?.[0] || null;
  if (!stream) {
    return interaction.followUp({
      content: `Jaamal **${station.program}** puudub toimiv URL.`,
      ephemeral: true,
    });
  }

  await radio.playRadioStream(
    interaction,
    { name: station.program, url: stream },
    guildStates
  );
}

async function playRandomWorld(interaction, guildStates) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }

  let api;
  try {
    api = await fmstream({ c: 'RD' });
  } catch (error) {
    console.error('[FMStream] Error fetching random station:', error);
    return interaction.followUp({
      content: 'Tekkis viga juhusliku jaama toomisel.',
      ephemeral: true,
    });
  }

  if (!api.data || api.data.length === 0) {
    return interaction.followUp({
      content: 'Juhuslikke jaamu ei leitud. Proovi uuesti.',
      ephemeral: true,
    });
  }

  const station = api.data[0];
  const stream = station.urls?.[0]?.url;
  if (!stream) {
    return interaction.followUp({
      content: 'Juhuslikul jaamal puudub striim.',
      ephemeral: true,
    });
  }

  await interaction.followUp({
    content: `Juhuslik jaam: **${station.program}** (${station.country})`,
    ephemeral: true,
  }).catch(() => {});

  await radio.playRadioStream(
    interaction,
    { name: station.program, url: stream },
    guildStates
  );
}

module.exports = {
  showCountryMenu,
  showStyleMenu,
  showStationMenu,
  pickStation,
  playRandomWorld,
};
