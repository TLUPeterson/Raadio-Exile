const https = require('https');
const { URLSearchParams } = require('url');

const fmstreamCountryAliases = {
  AE: 'ARE',
  AF: 'AFG',
  AT: 'AUT',
  AU: 'AUS',
  BE: 'BEL',
  CH: 'SUI',
  CD: 'COD',
  DE: 'D',
  DK: 'DNK',
  EE: 'EST',
  ES: 'E',
  FI: 'FIN',
  FR: 'FRA',
  GB: 'GBR',
  IE: 'IRL',
  IL: 'ISR',
  IN: 'IND',
  IQ: 'IRQ',
  IR: 'IRN',
  IT: 'ITA',
  JM: 'JAM',
  KP: 'PRK',
  KR: 'KOR',
  NL: 'HOL',
  NO: 'NOR',
  PT: 'POR',
  SE: 'SWE',
  UA: 'UKR',
  UG: 'UGA',
  US: 'USA',
};

function normalizeCountryCode(code) {
  return fmstreamCountryAliases[code] || code;
}

function fmstreamFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // Attempt to parse JSON, but handle non-JSON responses gracefully
        try {
          const trimmed = data.trim().replace(/^null+/, '');
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            resolve(JSON.parse(trimmed));
          } else {
            console.warn('[fmstream] Received non-JSON response:', trimmed.slice(0, 200));
            reject(new Error('Non-JSON response from fmstream'));
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
  console.info('[fmstream] Fetching URL:', url);

  return fmstreamFetch(url);
}

module.exports = { fmstream };
