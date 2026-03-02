const { fmstream } = require('./fmstream');

const RANDOM_STYLE_LABEL = 'Random';
const RANDOM_STYLE_VALUE = '__random__';
const COUNTRY_CACHE_TTL_MS = 30 * 60 * 1000;
const countryCache = new Map();

function isExpired(expiresAt) {
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function pruneCountryCache() {
  for (const [countryCode, cache] of countryCache.entries()) {
    if (cache.pendingStations || cache.pendingStyleStations.size > 0) {
      continue;
    }

    if (isExpired(cache.expiresAt)) {
      countryCache.delete(countryCode);
    }
  }
}

function touchCountryCache(cache) {
  cache.expiresAt = Date.now() + COUNTRY_CACHE_TTL_MS;
}

function getCountryCache(countryCode) {
  pruneCountryCache();

  let cache = countryCache.get(countryCode);
  if (!cache) {
    cache = {
      stations: null,
      styles: null,
      pendingStations: null,
      stationsByStyle: new Map(),
      pendingStyleStations: new Map(),
      expiresAt: Date.now() + COUNTRY_CACHE_TTL_MS,
    };
    countryCache.set(countryCode, cache);
  }

  touchCountryCache(cache);
  return cache;
}

function normalizeQuery(query) {
  return String(query || '').trim().toLowerCase();
}

function getStyleTokens(styleText) {
  return String(styleText || '')
    .split(/\s*\/\s*|\s*,\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildStylesFromStations(stations) {
  const styles = new Map();

  for (const station of stations) {
    const rawStyle = String(station.style || '').trim();
    if (!rawStyle) {
      continue;
    }

    const tokens = getStyleTokens(rawStyle);
    const values = tokens.length > 0 ? tokens : [rawStyle];

    for (const value of values) {
      const key = value.toLowerCase();
      if (!styles.has(key)) {
        styles.set(key, {
          label: value,
          value,
          stationCount: 0,
        });
      }

      styles.get(key).stationCount += 1;
    }
  }

  return [...styles.values()].sort((left, right) => {
    if (right.stationCount !== left.stationCount) {
      return right.stationCount - left.stationCount;
    }

    return left.label.localeCompare(right.label);
  });
}

async function getCountryStations(countryCode) {
  const cache = getCountryCache(countryCode);
  if (cache.stations) {
    return cache.stations;
  }

  if (cache.pendingStations) {
    return cache.pendingStations;
  }

  cache.pendingStations = (async () => {
    try {
      const api = await fmstream({ c: countryCode, hq: 1, o: 'top' });
      const stations = Array.isArray(api?.data) ? api.data : [];
      cache.stations = stations;
      cache.styles = buildStylesFromStations(stations);
      touchCountryCache(cache);
      return stations;
    } finally {
      cache.pendingStations = null;
    }
  })();

  return cache.pendingStations;
}

async function getCountryStyles(countryCode) {
  const cache = getCountryCache(countryCode);
  if (cache.styles) {
    return cache.styles;
  }

  await getCountryStations(countryCode);
  return cache.styles || [];
}

async function getStationsForCountryStyle(countryCode, styleValue) {
  const cache = getCountryCache(countryCode);
  if (cache.stationsByStyle.has(styleValue)) {
    return cache.stationsByStyle.get(styleValue);
  }

  if (cache.pendingStyleStations.has(styleValue)) {
    return cache.pendingStyleStations.get(styleValue);
  }

  const request = (async () => {
    try {
      const api = await fmstream({ c: countryCode, style: styleValue, hq: 1, o: 'top' });
      const stations = Array.isArray(api?.data) ? api.data : [];
      cache.stationsByStyle.set(styleValue, stations);
      touchCountryCache(cache);
      return stations;
    } finally {
      cache.pendingStyleStations.delete(styleValue);
    }
  })();

  cache.pendingStyleStations.set(styleValue, request);
  return request;
}

async function getAvailableStyleChoices(countryCode, {
  limit = 25,
  query = '',
  includeRandom = false,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const styles = await getCountryStyles(countryCode);

  const choices = styles
    .filter((style) => {
      if (!normalizedQuery) {
        return true;
      }

      return style.label.toLowerCase().includes(normalizedQuery);
    })
    .map((style) => ({
      label: style.label,
      value: style.value,
      description: `${style.stationCount} jaama`,
    }));

  if (includeRandom && (!normalizedQuery || RANDOM_STYLE_LABEL.toLowerCase().includes(normalizedQuery))) {
    choices.unshift({
      label: RANDOM_STYLE_LABEL,
      value: RANDOM_STYLE_VALUE,
      description: 'Valib juhusliku toimiva stiili',
    });
  }

  return choices.slice(0, limit);
}

async function resolveRandomStyle(countryCode) {
  const styles = await getCountryStyles(countryCode);
  if (!styles.length) {
    return null;
  }

  const randomStyle = styles[Math.floor(Math.random() * styles.length)];
  const stations = await getStationsForCountryStyle(countryCode, randomStyle.value);
  if (!stations.length) {
    return null;
  }

  return {
    style: randomStyle,
    stations,
  };
}

function getStyleLabel(styleValue) {
  return styleValue;
}

module.exports = {
  RANDOM_STYLE_LABEL,
  RANDOM_STYLE_VALUE,
  COUNTRY_CACHE_TTL_MS,
  getAvailableStyleChoices,
  getCountryStations,
  getCountryStyles,
  getStationsForCountryStyle,
  getStyleLabel,
  resolveRandomStyle,
};
