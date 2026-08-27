const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FAVORITES_PER_GUILD = 25;
const DEFAULT_FAVORITES_FILE = process.env.FAVORITES_FILE
  ? path.resolve(process.env.FAVORITES_FILE)
  : path.join(__dirname, 'data', 'favorites.json');

function normalizeStation(station, addedBy) {
  const name = String(station?.name || '').trim().slice(0, 100);
  const url = String(station?.url || '').trim();
  if (!name || !url) throw new Error('Station name and URL are required.');

  const parsedUrl = new URL(url);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP and HTTPS station URLs are supported.');
  }

  return {
    id: crypto.createHash('sha256').update(url).digest('hex').slice(0, 16),
    name,
    url,
    logo: station.logo ? String(station.logo).slice(0, 2_000) : null,
    color: station.color || null,
    addedBy: addedBy ? String(addedBy) : null,
    addedAt: new Date().toISOString(),
  };
}

class FavoritesStore {
  constructor(filePath = DEFAULT_FAVORITES_FILE) {
    this.filePath = filePath;
    this.operationQueue = Promise.resolve();
  }

  async readData() {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.guilds !== 'object') {
        throw new Error('Invalid favorites file structure.');
      }
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, guilds: {} };
      throw error;
    }
  }

  async writeData(data) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temporaryPath, this.filePath);
  }

  enqueue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  list(guildId) {
    return this.enqueue(async () => {
      const data = await this.readData();
      return Array.isArray(data.guilds[guildId]) ? data.guilds[guildId] : [];
    });
  }

  add(guildId, station, addedBy) {
    return this.enqueue(async () => {
      const data = await this.readData();
      const favorites = Array.isArray(data.guilds[guildId]) ? data.guilds[guildId] : [];
      const normalized = normalizeStation(station, addedBy);
      const existing = favorites.find((favorite) => favorite.url === normalized.url);
      if (existing) return { added: false, favorite: existing, count: favorites.length };
      if (favorites.length >= MAX_FAVORITES_PER_GUILD) {
        throw new Error(`This server already has ${MAX_FAVORITES_PER_GUILD} favorites.`);
      }

      favorites.push(normalized);
      data.guilds[guildId] = favorites;
      await this.writeData(data);
      return { added: true, favorite: normalized, count: favorites.length };
    });
  }

  remove(guildId, url) {
    return this.enqueue(async () => {
      const data = await this.readData();
      const favorites = Array.isArray(data.guilds[guildId]) ? data.guilds[guildId] : [];
      const index = favorites.findIndex((favorite) => favorite.url === url);
      if (index === -1) return { removed: false, count: favorites.length };

      const [favorite] = favorites.splice(index, 1);
      data.guilds[guildId] = favorites;
      await this.writeData(data);
      return { removed: true, favorite, count: favorites.length };
    });
  }
}

const pendingRequests = new Map();
let nextRequestId = 0;

if (typeof process.send === 'function') {
  process.on('message', (message) => {
    if (message?.type !== 'favorites-result') return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    clearTimeout(pending.timeoutId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
}

const localStore = new FavoritesStore();

function runOperation(operation, guildId, payload = {}) {
  const useCoordinator = Number(process.env.BOT_INSTANCE_COUNT || 1) > 1 &&
    typeof process.send === 'function';

  if (!useCoordinator) {
    return localStore[operation](guildId, ...(operation === 'add'
      ? [payload.station, payload.addedBy]
      : operation === 'remove'
        ? [payload.url]
        : []));
  }

  const requestId = `${process.pid}-${Date.now()}-${nextRequestId += 1}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Favorites coordinator timed out.'));
    }, 5_000);
    pendingRequests.set(requestId, { resolve, reject, timeoutId });
    process.send({ type: 'favorites-request', requestId, operation, guildId, payload });
  });
}

module.exports = {
  FavoritesStore,
  MAX_FAVORITES_PER_GUILD,
  addFavorite: (guildId, station, addedBy) => runOperation('add', guildId, { station, addedBy }),
  listFavorites: (guildId) => runOperation('list', guildId),
  removeFavorite: (guildId, url) => runOperation('remove', guildId, { url }),
};
