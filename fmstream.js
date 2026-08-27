const https = require('https');
const { URL, URLSearchParams } = require('url');

const MAX_REDIRECTS = 3;

const fmstreamCountryAliases = {
  AE: 'UAE',
  AF: 'AFG',
  AT: 'AUT',
  AU: 'AUS',
  BE: 'BEL',
  BR: 'B',
  CA: 'CAN',
  CD: 'COD',
  CH: 'SUI',
  CN: 'CHN',
  CZ: 'CZE',
  DE: 'D',
  DK: 'DNK',
  EE: 'EST',
  ES: 'E',
  FI: 'FIN',
  FR: 'F',
  GB: 'G',
  GR: 'GRC',
  IE: 'IRL',
  IL: 'ISR',
  IN: 'IND',
  IQ: 'IRQ',
  IR: 'IRN',
  IT: 'I',
  JM: 'JMC',
  JP: 'J',
  KP: 'KRE',
  KR: 'KOR',
  LA: 'LAO',
  NL: 'HOL',
  NO: 'NOR',
  PT: 'POR',
  SE: 'S',
  UA: 'UKR',
  UG: 'UGA',
  US: 'USA',
};

function normalizeCountryCode(code) {
  return fmstreamCountryAliases[code] || code;
}

function redactUrl(url) {
  const parsed = new URL(url);
  if (parsed.searchParams.has('key')) {
    parsed.searchParams.set('key', 'REDACTED');
  }
  return parsed.toString();
}

function fmstreamFetch(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();

        if (!res.headers.location) {
          reject(new Error(`fmstream redirected without a Location header (HTTP ${res.statusCode})`));
          return;
        }

        if (redirectCount >= MAX_REDIRECTS) {
          reject(new Error('Too many redirects from fmstream'));
          return;
        }

        const redirectUrl = new URL(res.headers.location, url);
        if (redirectUrl.protocol !== 'https:') {
          reject(new Error(`Refusing non-HTTPS redirect from fmstream: ${redirectUrl.protocol}`));
          return;
        }

        resolve(fmstreamFetch(redirectUrl.toString(), redirectCount + 1));
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // Attempt to parse JSON, but handle non-JSON responses gracefully
        try {
          const trimmed = data.trim().replace(/^null+/, '');
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            resolve(JSON.parse(trimmed));
          } else {
            const contentType = res.headers['content-type'] || 'unknown content type';
            console.warn('[fmstream] Received non-JSON response:', {
              statusCode: res.statusCode,
              contentType,
              body: trimmed.slice(0, 200),
            });
            reject(new Error(`Non-JSON response from fmstream (HTTP ${res.statusCode}, ${contentType})`));
          }
        } catch (err) {
          console.error('[fmstream] JSON parse error. Raw data:', data.slice(0, 200));
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function fmstream(params = {}) {
  // Generate authentication key if environment variables are present
  const keya = process.env.keya;
  const keyb = process.env.keyb;

  const unix = Math.floor(Date.now() / 1000);
  let qsParams = { ...params };
  if (qsParams.c) {
    qsParams.c = normalizeCountryCode(qsParams.c);
  }
  if (keya && keyb) {
    // Helper to parse potential hex or decimal
    const parseKey = (val) => {
      // If it looks like a hex string without 0x (e.g. "ad4a"), prefix it
      // PHP 0x... usually implies we should handle it as hex/number.
      // If Number() works (e.g. "123" or "0x123"), use it.
      const n = Number(val);
      if (!isNaN(n)) return n;
      // Try parsing as hex explicitly if valid hex chars
      if (/^[0-9A-Fa-f]+$/.test(val)) {
        return parseInt(val, 16);
      }
      return NaN;
    };

    const valA = parseKey(keya);
    const valB = parseKey(keyb);

    if (!isNaN(valA) && !isNaN(valB)) {
      const key = Math.round(valA * unix + valB).toString(16);
      qsParams.key = key;
    } else {
      console.warn(`[fmstream] Invalid API keys (keya=${keya}, keyb=${keyb}); authentication disabled.`);
    }
  } else {
    console.warn('[fmstream] Missing API keys (keya/keyb); proceeding without authentication key.');
  }

  const qs = new URLSearchParams(qsParams).toString();
  const url = `https://fmstream.org/index.php?${qs}`;
  console.info('[fmstream] Fetching URL:', redactUrl(url));

  return fmstreamFetch(url);
}

module.exports = { fmstream };
