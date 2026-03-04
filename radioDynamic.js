const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { fmstream } = require('./fmstream');
const countries = require('./data/countries');
const radio = require('./radio');
const {
  RANDOM_STYLE_LABEL,
  RANDOM_STYLE_VALUE,
  getAvailableStyleChoices,
  getStationsForCountryStyle,
  getStyleLabel,
  resolveRandomStyle,
} = require('./styleAvailability');
const MAX_SELECT_OPTIONS = 25;
const STATION_SEARCH_TTL_MS = 15 * 60 * 1000;
const FEATURED_COUNTRY_CODES = [
  'EST',
  'USA',
  'FIN',
  'AFG',
  'AUS',
  'COD',
  'F',
  'D',
  'IND',
  'IRN',
  'IRQ',
  'IRL',
  'ISR',
  'I',
  'JMC',
  'J',
  'KRE',
  'KOR',
  'LAO',
  'S',
  'UGA',
  'UKR',
  'UAE',
  'G',
];

function getCountryName(countryCode) {
  return countries.find((country) => country.code === countryCode)?.name || countryCode;
}

function getFeaturedCountries() {
  const countryByCode = new Map(countries.map((country) => [country.code, country]));
  return FEATURED_COUNTRY_CODES
    .map((code) => countryByCode.get(code))
    .filter(Boolean);
}

function pruneStationSearches(state) {
  if (!state?.stationSearches) {
    return;
  }

  const now = Date.now();
  for (const [userId, entry] of state.stationSearches.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      state.stationSearches.delete(userId);
    }
  }
}

async function respondToInteraction(interaction, payload) {
  if (interaction.isStringSelectMenu?.() || interaction.isButton?.()) {
    return interaction.update(payload);
  }

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }

  return interaction.reply({ ...payload, flags: 64 });
}

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

  pruneStationSearches(state);
  state.textChannel = interaction.channel;
  return state;
}

async function showCountryMenu(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_country')
    .setPlaceholder('Vali riik')
    .addOptions(
      getFeaturedCountries().slice(0, MAX_SELECT_OPTIONS).map((country) => ({
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
  const styleOptions = await getAvailableStyleChoices(countryCode, {
    limit: MAX_SELECT_OPTIONS,
    includeRandom: true,
    maxProbes: 24,
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`radio_style:${countryCode}`)
    .setPlaceholder('Vali stiil/zhanr')
    .addOptions(styleOptions);

  await respondToInteraction(interaction, {
    content: `Valitud riik: **${getCountryName(countryCode)}**\nVali nuud stiil/zhanr:`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function showStationMenu(interaction, countryCode, style, guildStates) {
  let resolvedStyle = style;
  let stations = [];

  try {
    if (style === RANDOM_STYLE_VALUE) {
      const randomMatch = await resolveRandomStyle(countryCode);
      if (!randomMatch) {
        const styleOptions = await getAvailableStyleChoices(countryCode, {
          limit: MAX_SELECT_OPTIONS,
          includeRandom: true,
          maxProbes: 24,
        });
        return respondToInteraction(interaction, {
          content: `Riigile **${getCountryName(countryCode)}** ei leidunud juhuslikku toimivat stiili.`,
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`radio_style:${countryCode}`)
              .setPlaceholder('Vali muu stiil/zhanr')
              .addOptions(styleOptions)
          )],
        });
      }

      resolvedStyle = randomMatch.style.value;
      stations = randomMatch.stations;
    } else {
      stations = await getStationsForCountryStyle(countryCode, style);
    }
  } catch (error) {
    console.error('[FMStream] Error fetching stations:', error);
    return respondToInteraction(interaction, {
      content: 'Tekkis viga jaamade parimisel. Proovi uuesti.',
      components: [],
    });
  }

  if (!stations.length) {
    const styleOptions = await getAvailableStyleChoices(countryCode, {
      limit: MAX_SELECT_OPTIONS,
      includeRandom: true,
      maxProbes: 24,
    });
    const styleMenu = new StringSelectMenuBuilder()
      .setCustomId(`radio_style:${countryCode}`)
      .setPlaceholder('Vali muu stiil/zhanr')
      .addOptions(styleOptions);

    return respondToInteraction(interaction, {
      content: `Jaamu ei leitud riigile **${countryCode}** ja stiiliga **${getStyleLabel(resolvedStyle)}**.\nVali moni muu stiil:`,
      components: [new ActionRowBuilder().addComponents(styleMenu)],
    });
  }

  const state = getOrCreateState(interaction, guildStates);
  state.stationSearches ??= new Map();
  state.stationSearches.set(interaction.user.id, {
    country: countryCode,
    style: resolvedStyle,
    stations,
    expiresAt: Date.now() + STATION_SEARCH_TTL_MS,
  });

  const stationOptions = stations.slice(0, 25).map((station) => ({
    label: station.program.slice(0, 80),
    description: (station.description || 'Kirjeldus puudub').slice(0, 90),
    value: String(station.id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_station_pick')
    .setPlaceholder('Vali jaam')
    .addOptions(stationOptions);

  await respondToInteraction(interaction, {
    content: `Vali jaam (**${getCountryName(countryCode)}**, stiil: ${getStyleLabel(resolvedStyle)}):`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

async function pickStation(interaction, guildStates) {
  await interaction.deferUpdate();

  const state = guildStates.get(interaction.guildId);
  pruneStationSearches(state);
  const stationId = interaction.values[0];
  const cache = state?.stationSearches?.get(interaction.user.id)?.stations;

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
  RANDOM_STYLE_LABEL,
  RANDOM_STYLE_VALUE,
  STATION_SEARCH_TTL_MS,
};
