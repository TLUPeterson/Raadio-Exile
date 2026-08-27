const { fmstream } = require('./fmstream');
const allStyles = require('./data/styles');

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
      stationsBySearch: new Map(),
      pendingSearchStations: new Map(),
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

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeStyleKey(value) {
  return normalizeSearchText(value).replace(/\s+/g, '-');
}

function getFmstreamSearchValue(value) {
  return normalizeSearchText(value).replace(/\s+/g, ' ');
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

function getStyleRank(style, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const label = normalizeSearchText(style.label);
  const value = normalizeSearchText(style.value);
  const key = normalizeStyleKey(style.value || style.label);
  const queryKey = normalizeStyleKey(query);

  if (label === normalizedQuery || value === normalizedQuery || key === queryKey) {
    return 0;
  }

  if (label.startsWith(normalizedQuery) || value.startsWith(normalizedQuery) || key.startsWith(queryKey)) {
    return 1;
  }

  if (label.includes(normalizedQuery) || value.includes(normalizedQuery) || key.includes(queryKey)) {
    return 2;
  }

  return 3;
}

function buildStyleSearchCandidates(countryStyles, query) {
  const normalizedQuery = normalizeSearchText(query);
  const queryKey = normalizeStyleKey(query);
  const candidates = new Map();

  const addCandidate = (style, sourceRank) => {
    if (!style?.label || !style?.value) {
      return;
    }

    const key = normalizeStyleKey(style.value || style.label);
    if (!key) {
      return;
    }

    const label = normalizeSearchText(style.label);
    const value = normalizeSearchText(style.value);
    if (normalizedQuery && !label.includes(normalizedQuery) && !value.includes(normalizedQuery) && !key.includes(queryKey)) {
      return;
    }

    const existing = candidates.get(key);
    const next = {
      label: style.label,
      value: style.value,
      stationCount: style.stationCount || 0,
      sourceRank,
      matchRank: getStyleRank(style, query),
    };

    if (!existing ||
      next.matchRank < existing.matchRank ||
      (next.matchRank === existing.matchRank && next.sourceRank < existing.sourceRank) ||
      (next.matchRank === existing.matchRank && next.sourceRank === existing.sourceRank && next.stationCount > existing.stationCount)) {
      candidates.set(key, next);
    }
  };

  for (const style of countryStyles) {
    addCandidate(style, 0);
  }

  for (const style of allStyles) {
    addCandidate(style, 1);
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.matchRank !== right.matchRank) {
      return left.matchRank - right.matchRank;
    }

    if (left.sourceRank !== right.sourceRank) {
      return left.sourceRank - right.sourceRank;
    }

    if (right.stationCount !== left.stationCount) {
      return right.stationCount - left.stationCount;
    }

    return left.label.localeCompare(right.label);
  });
}

function stationSearchText(station) {
  return normalizeSearchText([
    station.program,
    station.style,
    station.branding,
    station.frequency,
    station.frq,
    station.country,
    station.description,
    station.slogan,
  ].filter(Boolean).join(' '));
}

function getStationRank(station, query) {
  const search = normalizeSearchText(query);
  if (!search) {
    return 0;
  }

  const styleTokens = getStyleTokens(station.style).map(normalizeSearchText);
  const program = normalizeSearchText(station.program);
  const branding = normalizeSearchText(station.branding);
  const description = normalizeSearchText(station.description);
  const haystack = stationSearchText(station);

  if (styleTokens.some((style) => style === search)) {
    return 0;
  }

  if (styleTokens.some((style) => style.includes(search))) {
    return 1;
  }

  if (program.includes(search) || branding.includes(search)) {
    return 2;
  }

  if (description.includes(search) || haystack.includes(search)) {
    return 3;
  }

  return 4;
}

function sortStationsForQuery(stations, query) {
  return [...stations].sort((left, right) => {
    const leftRank = getStationRank(left, query);
    const rightRank = getStationRank(right, query);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftScore = Number(left.score || left.hpstatus || 0);
    const rightScore = Number(right.score || right.hpstatus || 0);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return String(left.program || '').localeCompare(String(right.program || ''));
  });
}

function getStationSearchRank(station, query) {
  const search = normalizeSearchText(query);
  if (!search) {
    return 0;
  }

  const compactSearch = search.replace(/\s+/g, '');
  const tokens = search.split(/\s+/).filter(Boolean);
  const program = normalizeSearchText(station.program);
  const programCompact = program.replace(/\s+/g, '');
  const branding = normalizeSearchText(station.branding);
  const style = normalizeSearchText(station.style);
  const haystack = stationSearchText(station);

  if (program === search || programCompact === compactSearch) {
    return 0;
  }

  if (program.includes(search) || programCompact.includes(compactSearch)) {
    return 1;
  }

  if (tokens.length && tokens.every((token) => program.includes(token) || branding.includes(token))) {
    return 2;
  }

  if (tokens.some((token) => program.includes(token) || branding.includes(token))) {
    return 3;
  }

  if (style.includes(search) || tokens.some((token) => style.includes(token))) {
    return 4;
  }

  if (tokens.length && tokens.every((token) => haystack.includes(token))) {
    return 5;
  }

  if (tokens.some((token) => haystack.includes(token))) {
    return 6;
  }

  return 7;
}

function sortStationsForSearch(stations, query) {
  return [...stations].sort((left, right) => {
    const leftRank = getStationSearchRank(left, query);
    const rightRank = getStationSearchRank(right, query);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    const leftScore = Number(left.score || left.hpstatus || 0);
    const rightScore = Number(right.score || right.hpstatus || 0);
    if (rightScore !== leftScore) {
      return rightScore - leftScore;
    }

    return String(left.program || '').localeCompare(String(right.program || ''));
  });
}

function mergeStations(...stationLists) {
  const stations = new Map();
  for (const list of stationLists) {
    for (const station of list || []) {
      const key = String(station.id || station.url || station.program);
      if (key && !stations.has(key)) {
        stations.set(key, station);
      }
    }
  }

  return [...stations.values()];
}

function getSearchVariants(query) {
  const normalized = getFmstreamSearchValue(query);
  if (!normalized) {
    return [];
  }

  const compact = normalized.replace(/\s+/g, '');
  const variants = [];

  if (compact.length >= 3 && compact !== normalized) {
    variants.push(compact);
  }

  variants.push(normalized);
  return [...new Set(variants)];
}

function getFallbackSearchVariants(query) {
  const genericWords = new Set(['channel', 'chanel', 'station', 'radio', 'fm', 'am']);
  const tokens = normalizeSearchText(query)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !genericWords.has(token));

  return [...new Set(tokens)];
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
  const cacheKey = normalizeStyleKey(styleValue);
  if (cache.stationsByStyle.has(cacheKey)) {
    return cache.stationsByStyle.get(cacheKey);
  }

  if (cache.pendingStyleStations.has(cacheKey)) {
    return cache.pendingStyleStations.get(cacheKey);
  }

  const request = (async () => {
    try {
      const searchValue = getFmstreamSearchValue(styleValue);
      const styleApi = await fmstream({ c: countryCode, style: styleValue, hq: 1, o: 'top' });
      const styleStations = Array.isArray(styleApi?.data) ? styleApi.data : [];
      let searchStations = [];

      if (searchValue && (styleStations.length === 0 || !styleStations.some((station) => getStationRank(station, styleValue) <= 1))) {
        const searchApi = await fmstream({ c: countryCode, s: searchValue, hq: 1, o: 'top' });
        searchStations = Array.isArray(searchApi?.data) ? searchApi.data : [];
      }

      const stations = sortStationsForQuery(mergeStations(styleStations, searchStations), styleValue);
      cache.stationsByStyle.set(cacheKey, stations);
      touchCountryCache(cache);
      return stations;
    } finally {
      cache.pendingStyleStations.delete(cacheKey);
    }
  })();

  cache.pendingStyleStations.set(cacheKey, request);
  return request;
}

async function getStationsForCountrySearch(countryCode, searchQuery, styleValue = '') {
  const cache = getCountryCache(countryCode);
  const normalizedSearch = normalizeSearchText(searchQuery);
  const cacheKey = `${normalizeStyleKey(styleValue || 'any')}:${normalizedSearch}`;

  if (cache.stationsBySearch.has(cacheKey)) {
    return cache.stationsBySearch.get(cacheKey);
  }

  if (cache.pendingSearchStations.has(cacheKey)) {
    return cache.pendingSearchStations.get(cacheKey);
  }

  const request = (async () => {
    try {
      let variants = getSearchVariants(searchQuery);
      let responses = await Promise.all(variants.map(async (variant) => {
        const params = { c: countryCode, s: variant, hq: 1, o: 'top' };
        if (styleValue) {
          params.style = styleValue;
        }

        const api = await fmstream(params);
        return Array.isArray(api?.data) ? api.data : [];
      }));

      let stations = sortStationsForSearch(mergeStations(...responses), searchQuery);

      if (!stations.length) {
        variants = getFallbackSearchVariants(searchQuery);
        responses = await Promise.all(variants.map(async (variant) => {
          const params = { c: countryCode, s: variant, hq: 1, o: 'top' };
          if (styleValue) {
            params.style = styleValue;
          }

          const api = await fmstream(params);
          return Array.isArray(api?.data) ? api.data : [];
        }));
        stations = sortStationsForSearch(mergeStations(...responses), variants.join(' '));
      }

      if (!stations.length && styleValue) {
        stations = await getStationsForCountryStyle(countryCode, styleValue);
      }

      cache.stationsBySearch.set(cacheKey, stations);
      touchCountryCache(cache);
      return stations;
    } finally {
      cache.pendingSearchStations.delete(cacheKey);
    }
  })();

  cache.pendingSearchStations.set(cacheKey, request);
  return request;
}

async function getAvailableStyleChoices(countryCode, {
  limit = 25,
  query = '',
  includeRandom = false,
  maxProbes = 8,
} = {}) {
  const normalizedQuery = normalizeQuery(query);
  const cache = getCountryCache(countryCode);
  const styles = normalizedQuery ? (cache.styles || []) : await getCountryStyles(countryCode);

  let choices;
  if (normalizedQuery) {
    const candidates = buildStyleSearchCandidates(styles, query);
    const probeLimit = Math.max(1, Math.min(maxProbes, 3));
    const probedCandidates = candidates.slice(0, probeLimit);
    const probed = await Promise.all(probedCandidates.map(async (style) => {
      const stations = await getStationsForCountryStyle(countryCode, style.value);
      if (!stations.length) {
        return null;
      }

      return {
        label: style.label,
        value: style.value,
        description: `${stations.length} jaama`,
      };
    }));

    const validatedChoices = probed.filter(Boolean);
    const validatedValues = new Set(validatedChoices.map((choice) => normalizeStyleKey(choice.value)));
    const unvalidatedChoices = candidates
      .filter((style) => !validatedValues.has(normalizeStyleKey(style.value)))
      .slice(0, limit - validatedChoices.length)
      .map((style) => ({
        label: style.label,
        value: style.value,
        description: 'Otsi jaamu',
      }));

    choices = [...validatedChoices, ...unvalidatedChoices];
  } else {
    choices = styles.map((style) => ({
      label: style.label,
      value: style.value,
      description: `${style.stationCount} jaama`,
    }));
  }

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
  const key = normalizeStyleKey(styleValue);
  return allStyles.find((style) => normalizeStyleKey(style.value) === key)?.label || styleValue;
}

module.exports = {
  RANDOM_STYLE_LABEL,
  RANDOM_STYLE_VALUE,
  COUNTRY_CACHE_TTL_MS,
  getAvailableStyleChoices,
  getCountryStations,
  getCountryStyles,
  getStationsForCountrySearch,
  getStationsForCountryStyle,
  getStyleLabel,
  resolveRandomStyle,
};
