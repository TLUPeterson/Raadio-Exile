const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_HISTORY_ENTRIES = Number(process.env.HISTORY_MAX_ENTRIES || 5_000);
const DEFAULT_HISTORY_FILE = process.env.HISTORY_FILE
  ? path.resolve(process.env.HISTORY_FILE)
  : path.join(__dirname, 'data', 'history.json');

class HistoryStore {
  constructor(filePath = DEFAULT_HISTORY_FILE) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
      return Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, entries: [] };
      throw error;
    }
  }

  async write(data) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.promises.rename(temporaryPath, this.filePath);
  }

  add(entry) {
    return this.enqueue(async () => {
      const data = await this.read();
      const normalized = {
        id: crypto.randomUUID(),
        guildId: String(entry.guildId),
        station: {
          name: String(entry.station?.name || 'Unknown station').slice(0, 100),
          url: String(entry.station?.url || '').slice(0, 2_000),
        },
        botInstance: Number(entry.botInstance || 1),
        voiceChannelId: entry.voiceChannelId ? String(entry.voiceChannelId) : null,
        voiceChannelName: entry.voiceChannelName ? String(entry.voiceChannelName).slice(0, 100) : null,
        requestedBy: entry.requestedBy ? String(entry.requestedBy) : null,
        source: entry.source === 'web' ? 'web' : 'discord',
        playedAt: entry.playedAt || new Date().toISOString(),
      };
      data.entries.unshift(normalized);
      data.entries = data.entries.slice(0, Math.max(100, MAX_HISTORY_ENTRIES));
      await this.write(data);
      return normalized;
    });
  }

  list(guildId, limit = 50) {
    return this.enqueue(async () => {
      const data = await this.read();
      return data.entries
        .filter((entry) => entry.guildId === String(guildId))
        .slice(0, Math.min(100, Math.max(1, Number(limit) || 50)));
    });
  }
}

module.exports = { HistoryStore, MAX_HISTORY_ENTRIES };
