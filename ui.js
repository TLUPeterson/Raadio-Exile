// ui.js
const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const countries = require('./data/countries'); // array of { code, name } or similar
const styles = require('./data/styles');       // array of strings or { value, label }
const { fmstream } = require('./fmstream'); // fmstream({ c, style, ... }) -> { status, data }

const menuMessages = new Map();

// ----------------------------------------------------------------------
// MAIN MODE MENU (single persistent menu per channel)
// ----------------------------------------------------------------------
async function showMainModeMenu(channel) {
  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId('radio_mode')
    .setPlaceholder('Vali kuidas raadiot valida')
    .addOptions([
      { label: '🎲 Juhuslik jaam (maailmast)', value: 'random_world' },
      { label: '🌍 Riik + stiil', value: 'country_style' },
      { label: '🇪🇪 Eesti eelseatud jaamad', value: 'estonian' },
    ]);

  const modeRow = new ActionRowBuilder().addComponents(modeMenu);

  const existingId = menuMessages.get(channel.id);

  if (existingId) {
    try {
      const msg = await channel.messages.fetch(existingId);
      return msg.edit({
        content: 'Vali uus raadiojaam:',
        components: [modeRow],
      });
    } catch {
      // message deleted or not found → fall through to create new
    }
  }

  const m = await channel.send({
    content: 'Vali uus raadiojaam:',
    components: [modeRow],
  });

  menuMessages.set(channel.id, m.id);
}

// ----------------------------------------------------------------------
// COUNTRY MENU
// ----------------------------------------------------------------------
async function showCountryMenu(interaction) {
  // Discord hard limit: 25 options
  const options = countries.slice(0, 25).map(c => ({
    label: String(c.name ?? c.label ?? c.code),
    value: String(c.code),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_country')
    .setPlaceholder('Vali riik')
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(menu);

  await interaction.update({
    content: 'Vali riik:',
    components: [row],
  });
}

// ----------------------------------------------------------------------
// STYLE MENU
// ----------------------------------------------------------------------
async function showStyleMenu(interaction, countryCode) {
  // styles can be:
  //  - ["rock", "pop", ...]
  //  - [{ value: "rock", label: "Rock" }, { value: "30s", label: "thirties" }, ...]
  const styleOptions = styles.slice(0, 25).map(s => {
    if (typeof s === 'string') {
      return {
        label: s,
        value: s,
      };
    }

    if (s && typeof s === 'object') {
      return {
        label: String(s.label ?? s.value ?? 'Stiil'),
        value: String(s.value ?? s.label ?? 'style'),
      };
    }

    return {
      label: String(s),
      value: String(s),
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`radio_style:${countryCode}`)
    .setPlaceholder('Vali stiil/žanr')
    .addOptions(styleOptions);

  const row = new ActionRowBuilder().addComponents(menu);

  await interaction.update({
    content: `Valitud riik: **${countryCode}**\nVali nüüd stiil/žanr:`,
    components: [row],
  });
}

// ----------------------------------------------------------------------
// STATION MENU (after country + style)
// ----------------------------------------------------------------------
async function showStationMenu(interaction, countryCode, style) {
  let api;
  try {
    api = await fmstream({ c: countryCode, style, hq: 1 });
  } catch (err) {
    return interaction.update({
      content: 'Tekkis viga jaamade pärimisel. Proovi uuesti.',
      components: [],
    });
  }

  const stations = Array.isArray(api?.data) ? api.data : [];

  if (!stations.length) {
    return interaction.update({
      content: `❌ Jaamu ei leitud riigile **${countryCode}** ja stiiliga **${style}**.\nProovi teist stiili.`,
      components: [],
    });
  }

  // 🔥 STORE stations for pickStation()
  interaction.client.stationCache ??= {};
  interaction.client.stationCache[interaction.guildId] = stations;

  const stationOptions = stations.slice(0, 25).map(st => ({
    label: (st.program || `Jaam ${st.id}`).slice(0, 100),
    value: String(st.id),
    description: (st.description || '').slice(0, 100) || undefined,
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_station_pick')
    .setPlaceholder('Vali jaam')
    .addOptions(stationOptions);

  const row = new ActionRowBuilder().addComponents(menu);

  await interaction.update({
    content: `Vali jaam (**${countryCode}**, stiil: ${style}):`,
    components: [row],
  });
}


module.exports = {
  showMainModeMenu,
  showCountryMenu,
  showStyleMenu,
  showStationMenu,
};
