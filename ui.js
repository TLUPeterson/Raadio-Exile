const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const countries = require('./data/countries');
const { fmstream } = require('./fmstream');
const { getAvailableStyleChoices } = require('./styleAvailability');

const menuMessages = new Map();
const MENU_MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
const FEATURED_COUNTRY_CODES = [
  'EE',
  'US',
  'FI',
  'AF',
  'AU',
  'CD',
  'FR',
  'DE',
  'IN',
  'IR',
  'IQ',
  'IE',
  'IL',
  'IT',
  'JM',
  'JP',
  'KP',
  'KR',
  'SE',
  'UG',
  'UA',
  'AE',
  'GB',
];

function pruneMenuMessages() {
  const now = Date.now();
  for (const [channelId, entry] of menuMessages.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      menuMessages.delete(channelId);
    }
  }
}

function getFeaturedCountries() {
  const countryByCode = new Map(countries.map((country) => [country.code, country]));
  return FEATURED_COUNTRY_CODES
    .map((code) => countryByCode.get(code))
    .filter(Boolean);
}

async function showMainModeMenu(channel, interaction = null) {
  pruneMenuMessages();

  const modeMenu = new StringSelectMenuBuilder()
    .setCustomId('radio_mode')
    .setPlaceholder('Vali kuidas raadiot valida')
    .addOptions([
      { label: 'Juhuslik jaam (maailmast)', value: 'random_world' },
      { label: 'Riik + stiil', value: 'country_style' },
      { label: 'Eesti eelseatud jaamad', value: 'estonian' },
    ]);

  const modeRow = new ActionRowBuilder().addComponents(modeMenu);

  if (interaction) {
    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({
          content: 'Vali uus raadiojaam:',
          components: [modeRow],
        });
      }

      return interaction.update({
        content: 'Vali uus raadiojaam:',
        components: [modeRow],
      });
    } catch (error) {
      console.warn('showMainModeMenu interaction update failed', error);
    }
  }

  const message = await channel.send({
    content: 'Vali uus raadiojaam:',
    components: [modeRow],
  });

  menuMessages.set(channel.id, {
    id: message.id,
    expiresAt: Date.now() + MENU_MESSAGE_TTL_MS,
  });
}

async function showCountryMenu(interaction) {
  const options = getFeaturedCountries().map((country) => ({
    label: String(country.name ?? country.label ?? country.code),
    value: String(country.code),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_country')
    .setPlaceholder('Vali riik')
    .addOptions(options);

  const menuRow = new ActionRowBuilder().addComponents(menu);
  const backBtn = new ButtonBuilder()
    .setCustomId('radio_back_main')
    .setLabel('Tagasi')
    .setStyle(ButtonStyle.Secondary);
  const btnRow = new ActionRowBuilder().addComponents(backBtn);

  await interaction.update({
    content: 'Vali riik:',
    components: [menuRow, btnRow],
  });
}

async function showStyleMenu(interaction, countryCode) {
  if (!interaction.deferred && !interaction.replied && interaction.deferUpdate) {
    await interaction.deferUpdate();
  }

  const styleOptions = await getAvailableStyleChoices(countryCode, {
    limit: 25,
    includeRandom: true,
    maxProbes: 24,
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`radio_style:${countryCode}`)
    .setPlaceholder('Vali stiil/zhanr')
    .addOptions(styleOptions);

  const menuRow = new ActionRowBuilder().addComponents(menu);
  const backBtn = new ButtonBuilder()
    .setCustomId('radio_back_country')
    .setLabel('Tagasi')
    .setStyle(ButtonStyle.Secondary);
  const btnRow = new ActionRowBuilder().addComponents(backBtn);

  await interaction.editReply({
    content: `Valitud riik: **${countryCode}**\nVali nuud stiil/zhanr:`,
    components: [menuRow, btnRow],
  });
}

async function showStationMenu(interaction, countryCode, style) {
  let api;
  try {
    api = await fmstream({ c: countryCode, style, hq: 1 });
  } catch (error) {
    return interaction.update({
      content: 'Tekkis viga jaamade parimisel. Proovi uuesti.',
      components: [],
    });
  }

  const stations = Array.isArray(api?.data) ? api.data : [];
  if (!stations.length) {
    const backBtn = new ButtonBuilder()
      .setCustomId(`radio_back_style:${countryCode}`)
      .setLabel('Tagasi')
      .setStyle(ButtonStyle.Secondary);
    const btnRow = new ActionRowBuilder().addComponents(backBtn);

    return interaction.update({
      content: `Jaamu ei leitud riigile **${countryCode}** ja stiiliga **${style}**.\nProovi teist stiili.`,
      components: [btnRow],
    });
  }

  interaction.client.stationCache ??= {};
  interaction.client.stationCache[interaction.guildId] = stations;

  const stationOptions = stations.slice(0, 25).map((station) => ({
    label: (station.program || `Jaam ${station.id}`).slice(0, 100),
    value: String(station.id),
    description: (station.description || '').slice(0, 100) || undefined,
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('radio_station_pick')
    .setPlaceholder('Vali jaam')
    .addOptions(stationOptions);

  const menuRow = new ActionRowBuilder().addComponents(menu);
  const backBtn = new ButtonBuilder()
    .setCustomId(`radio_back_style:${countryCode}`)
    .setLabel('Tagasi')
    .setStyle(ButtonStyle.Secondary);
  const btnRow = new ActionRowBuilder().addComponents(backBtn);

  await interaction.update({
    content: `Vali jaam (**${countryCode}**, stiil: ${style}):`,
    components: [menuRow, btnRow],
  });
}

module.exports = {
  showMainModeMenu,
  showCountryMenu,
  showStyleMenu,
  showStationMenu,
};
