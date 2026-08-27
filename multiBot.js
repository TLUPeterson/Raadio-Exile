require('dotenv').config();

const { fork } = require('child_process');
const path = require('path');
const { FavoritesStore } = require('./favorites');
const { HistoryStore } = require('./history');
const { startDashboard } = require('./dashboard');
const countries = require('./data/countries');
const { radioChannels } = require('./radio');
const { getCountryStations, getStationsForCountrySearch, getStationsForCountryStyle } = require('./styleAvailability');

const MAX_BOTS = 3;
const children = new Map();
const pendingClaims = new Map();
const favoritesStore = new FavoritesStore();
const historyStore = new HistoryStore();
const pendingStatusRequests = new Map();
const pendingCommandRequests = new Map();
let requestSequence = 0;
let shuttingDown = false;

function chooseClaimWinner(candidates) {
  return candidates.find((claim) => claim.availability === 'same') ||
    candidates.find((claim) => claim.availability === 'free') ||
    candidates.find((claim) => claim.instanceNumber === 1) ||
    candidates[0];
}

function finalizeClaim(requestId) {
  const pending = pendingClaims.get(requestId);
  if (!pending) return;
  pendingClaims.delete(requestId);
  clearTimeout(pending.timer);

  const candidates = [...pending.claims.values()];
  const winner = chooseClaimWinner(candidates);

  for (const claim of candidates) {
    claim.child.send?.({
      type: 'pool-claim-result',
      requestId,
      selected: claim.instanceNumber === winner?.instanceNumber,
      noFreeBot: !candidates.some((candidate) => candidate.availability !== 'busy'),
    });
  }
}

function recordClaim(child, message, count) {
  const requestId = message.requestId;
  let pending = pendingClaims.get(requestId);
  if (!pending) {
    pending = {
      claims: new Map(),
      timer: setTimeout(() => finalizeClaim(requestId), 200),
    };
    pendingClaims.set(requestId, pending);
  }

  pending.claims.set(message.instanceNumber, { ...message, child });
  if (pending.claims.size >= count) finalizeClaim(requestId);
}

async function handleFavoritesRequest(child, message) {
  const { requestId, operation, guildId, payload = {} } = message;
  try {
    if (!['list', 'add', 'remove'].includes(operation)) throw new Error('Unknown favorites operation.');
    const args = operation === 'add'
      ? [guildId, payload.station, payload.addedBy]
      : operation === 'remove'
        ? [guildId, payload.url]
        : [guildId];
    const result = await favoritesStore[operation](...args);
    child.send?.({ type: 'favorites-result', requestId, result });
  } catch (error) {
    child.send?.({ type: 'favorites-result', requestId, error: error.message });
  }
}

function finishStatusRequest(requestId) {
  const pending = pendingStatusRequests.get(requestId);
  if (!pending) return;
  pendingStatusRequests.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve([...pending.results.values()]);
}

function collectStatuses() {
  const requestId = `status-${Date.now()}-${requestSequence += 1}`;
  return new Promise((resolve) => {
    const connectedChildren = [...children.values()].filter((child) => child.connected);
    if (connectedChildren.length === 0) return resolve([]);
    const pending = {
      expected: connectedChildren.length,
      results: new Map(),
      resolve,
      timer: setTimeout(() => finishStatusRequest(requestId), 1_000),
    };
    pendingStatusRequests.set(requestId, pending);
    connectedChildren.forEach((child) => child.send({ type: 'dashboard-status-request', requestId }));
  });
}

function recordStatusResult(message) {
  const pending = pendingStatusRequests.get(message.requestId);
  if (!pending) return;
  pending.results.set(message.instanceNumber, message.status);
  if (pending.results.size >= pending.expected) finishStatusRequest(message.requestId);
}

function sendDashboardCommand(instanceNumber, command) {
  const child = children.get(Number(instanceNumber));
  if (!child?.connected) return Promise.reject(new Error('Selected bot is offline.'));
  const requestId = `command-${Date.now()}-${requestSequence += 1}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingCommandRequests.delete(requestId);
      reject(new Error('Bot command timed out.'));
    }, 25_000);
    pendingCommandRequests.set(requestId, { resolve, reject, timeoutId });
    child.send({ type: 'dashboard-command', requestId, command });
  });
}

function recordCommandResult(message) {
  const pending = pendingCommandRequests.get(message.requestId);
  if (!pending) return;
  pendingCommandRequests.delete(message.requestId);
  clearTimeout(pending.timeoutId);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.result);
}

function getAllowedGuildIds(userGuildIds) {
  const configured = String(process.env.DASHBOARD_ALLOWED_GUILD_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  return userGuildIds.filter((id) => configured.length === 0 || configured.includes(id));
}

async function getDashboardOverview(userGuildIds, selectedGuildId) {
  const statuses = await collectStatuses();
  const allowed = new Set(getAllowedGuildIds(userGuildIds));
  const guildMap = new Map();
  for (const status of statuses) {
    for (const guild of status.guilds || []) {
      if (!allowed.has(guild.id)) continue;
      const existing = guildMap.get(guild.id) || {
        id: guild.id, name: guild.name, voiceChannels: guild.voiceChannels, bots: [],
      };
      existing.bots.push({
        instanceNumber: status.instanceNumber,
        online: status.online,
        bot: status.bot,
        session: guild.session,
      });
      guildMap.set(guild.id, existing);
    }
  }
  const guilds = [...guildMap.values()];
  const guildId = guildMap.has(selectedGuildId) ? selectedGuildId : guilds[0]?.id || null;
  return {
    guilds,
    selectedGuildId: guildId,
    favorites: guildId ? await favoritesStore.list(guildId) : [],
    history: guildId ? await historyStore.list(guildId, 50) : [],
    staticStations: Object.values(radioChannels).map(({ name, url, logo, color }) => ({ name, url, logo, color })),
    countries: countries.map(({ code, name }) => ({ code, name })),
  };
}

async function playFromDashboard(command) {
  const statuses = await collectStatuses();
  const candidates = statuses.map((status) => {
    const guild = status.guilds?.find((item) => item.id === command.guildId);
    return guild ? { instanceNumber: status.instanceNumber, session: guild.session } : null;
  }).filter(Boolean);
  const winner = candidates.find((candidate) => candidate.session?.voiceChannelId === command.voiceChannelId) ||
    candidates.find((candidate) => !candidate.session);
  if (!winner) throw new Error('All radio bots are already occupied in this server.');
  return sendDashboardCommand(winner.instanceNumber, { ...command, operation: 'play' });
}

async function searchDashboardStations({ country, style, query }) {
  if (!country) throw new Error('Choose a country first.');
  const stations = query
    ? await getStationsForCountrySearch(country, query, style || '')
    : style
      ? await getStationsForCountryStyle(country, style)
      : await getCountryStations(country);
  return stations.slice(0, 50).map((station) => ({
    name: station.program || 'Unknown station',
    url: station.urls?.[0]?.url || station.urls?.[0] || '',
    country: station.country || country,
    style: station.style || style || '',
  })).filter((station) => station.url);
}

function getConfiguredTokens(env = process.env) {
  const listTokens = String(env.BOT_TOKENS || '')
    .split(/[\r\n,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const numberedTokens = Array.from({ length: MAX_BOTS }, (_, index) =>
    String(env[`TOKEN_${index + 1}`] || '').trim()
  ).filter(Boolean);

  const legacyToken = String(env.TOKEN || env.token || '').trim();
  const tokens = listTokens.length > 0
    ? listTokens
    : numberedTokens.length > 0
      ? numberedTokens
      : legacyToken
        ? [legacyToken]
        : [];

  return [...new Set(tokens)].slice(0, MAX_BOTS);
}

function startBot(token, index, count) {
  const instanceNumber = index + 1;
  const child = fork(path.join(__dirname, 'eksiilsus.js'), [], {
    env: {
      ...process.env,
      TOKEN: token,
      BOT_INSTANCE_INDEX: String(index),
      BOT_INSTANCE_NUMBER: String(instanceNumber),
      BOT_INSTANCE_COUNT: String(count),
      LEGACY_PREFIX_COMMANDS: index === 0 ? 'true' : 'false',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  children.set(instanceNumber, child);
  child.on('message', (message) => {
    if (message?.type === 'pool-claim') recordClaim(child, message, count);
    if (message?.type === 'favorites-request') handleFavoritesRequest(child, message);
    if (message?.type === 'dashboard-status-result') recordStatusResult(message);
    if (message?.type === 'dashboard-command-result') recordCommandResult(message);
    if (message?.type === 'playback-started') {
      historyStore.add(message.entry).catch((error) => console.error('[History] Write failed:', error));
    }
  });

  child.on('exit', (code, signal) => {
    children.delete(instanceNumber);
    if (shuttingDown) return;

    console.error(
      `[Bot Pool] Bot ${instanceNumber} stopped (code=${code ?? 'none'}, signal=${signal ?? 'none'}). Restarting in 5 seconds.`
    );
    setTimeout(() => {
      if (!shuttingDown) startBot(token, index, count);
    }, 5_000).unref();
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Bot Pool] ${signal} received; stopping ${children.size} bot instance(s).`);

  for (const child of children.values()) {
    if (child.connected) child.kill('SIGTERM');
  }

  setTimeout(() => process.exit(0), 5_000).unref();
}

function main() {
  const tokens = getConfiguredTokens();
  if (tokens.length === 0) {
    console.error('[Bot Pool] No tokens configured. Set BOT_TOKENS or TOKEN_1, TOKEN_2, and TOKEN_3.');
    process.exitCode = 1;
    return;
  }

  if (tokens.length < MAX_BOTS) {
    console.warn(`[Bot Pool] ${tokens.length}/${MAX_BOTS} bot tokens configured.`);
  }

  console.log(`[Bot Pool] Starting ${tokens.length} bot instance(s).`);
  tokens.forEach((token, index) => startBot(token, index, tokens.length));

  if (process.env.DASHBOARD_ENABLED === 'true') {
    startDashboard({
      getOverview: getDashboardOverview,
      searchStations: searchDashboardStations,
      play: playFromDashboard,
      stop: ({ instanceNumber, ...command }) => sendDashboardCommand(instanceNumber, { ...command, operation: 'stop' }),
      addFavorite: (guildId, station, userId) => favoritesStore.add(guildId, station, userId),
      removeFavorite: (guildId, url) => favoritesStore.remove(guildId, url),
    });
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  main();
}

module.exports = { chooseClaimWinner, getConfiguredTokens };
