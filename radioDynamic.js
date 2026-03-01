// radioDynamic.js
const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { fmstream } = require('./fmstream');
const countries = require('./data/countries');
const styles = require('./data/styles');
const radio = require('./radio');

// STEP 2: show country menu
async function showCountryMenu(interaction) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_country')
    .setPlaceholder('Vali riik')
    .addOptions(
      countries.map(c => ({
        label: c.name,
        value: c.code,
      }))
    );

  await interaction.update({
    content: 'Vali riik:',
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

// STEP 3: show style menu
async function showStyleMenu(interaction, countryCode) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`radio_style:${countryCode}`)
    .setPlaceholder('Vali stiil/žanr')
    .addOptions(styles);

  await interaction.update({
    content: `Valitud riik: **${countryCode}**\nVali nüüd stiil/žanr:`,
    components: [new ActionRowBuilder().addComponents(menu)],
  });
}

// STEP 4: show station list for country + style
// NOTE: now takes guildStates param so we can store station list
async function showStationMenu(interaction, countryCode, style, guildStates) {
  let api;
  try {
    api = await fmstream({ c: countryCode, style, hq: 1 });
  } catch (e) {
    console.error('[FMStream] Error fetching stations:', e);
    return interaction.update({
      content: 'Tekkis viga jaamade pärimisel. Proovi uuesti.',
      components: [],
    });
  }

  if (!api.data || api.data.length === 0) {
    // REFRESH STYLE MENU IF EMPTY
    const styleMenu = new StringSelectMenuBuilder()
      .setCustomId(`radio_style:${countryCode}`)
      .setPlaceholder('Vali muu stiil/žanr')
      .addOptions(styles);

    return interaction.update({
      content: `❌ Jaamu ei leitud riigile **${countryCode}** ja stiiliga **${style}**.\nVali mõni muu stiil:`,
      components: [new ActionRowBuilder().addComponents(styleMenu)],
    });
  }

  const guildId = interaction.guildId;
  let state = guildStates.get(guildId);
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
    };
    guildStates.set(guildId, state);
  }

  // Store station search in guild state so pickStation can use it
  state.stationSearch = {
    country: countryCode,
    style,
    stations: api.data,
  };

  const stations = api.data.slice(0, 25).map(st => ({
    label: st.program.slice(0, 80),
    description: (st.description || 'Kirjeldus puudub').slice(0, 90),
    value: st.id.toString(), // just the ID, simpler
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

// STEP 5: user picks a specific station
async function pickStation(interaction, guildStates) {
  // Immediate defer to prevent "Interaction failed"
  await interaction.deferUpdate();

  const stationId = interaction.values[0];

  // cached by showStationMenu()
  const cache = interaction.client.stationCache?.[interaction.guildId];

  if (!cache) {
    return interaction.update({
      content: "❌ Jaamade nimekiri ei ole saadaval. Alusta uuesti (vali riik + stiil).",
      components: []
    });
  }

  const station = cache.find(s => String(s.id) === stationId);

  if (!station) {
    return interaction.update({
      content: "❌ Jaama ei leitud. Proovi uuesti.",
      components: []
    });
  }

  // Pick FIRST working stream
  const stream = station.urls?.[0]?.url || station.urls?.[0] || null;

  if (!stream) {
    return interaction.update({
      content: `❌ Jaamal **${station.program}** puudub toimiv URL.`,
      components: []
    });
  }

  // PLAY using your existing radio.js logic
  await radio.playRadioStream(
    interaction,
    { name: station.program, url: stream },
    guildStates
  );
  // Defer is already done at start
}

// Random worldwide station (c=RD)
async function playRandomWorld(interaction, guildStates) {
  let api;
  try {
    api = await fmstream({ c: 'RD' });
  } catch (e) {
    console.error('[FMStream] Error fetching random station:', e);
    return interaction.update({
      content: 'Tekkis viga juhusliku jaama toomisel.',
      components: [],
    });
  }

  if (!api.data || api.data.length === 0) {
    return interaction.update({
      content: 'Juhuslikke jaamu ei leitud. Proovi uuesti.',
      components: [],
    });
  }

  const station = api.data[0];
  const stream = station.urls?.[0]?.url;
  if (!stream) {
    return interaction.update({
      content: 'Juhuslikul jaamal puudub striim.',
      components: [],
    });
  }

  await interaction.update({
    content: `🎲 Juhuslik jaam:\n🎧 **${station.program}**\n🌍 ${station.country}\n\nMängin nüüd...`,
    components: [],
  });

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
