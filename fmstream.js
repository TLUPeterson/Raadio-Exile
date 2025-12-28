const https = require('https');
const { URLSearchParams } = require('url');

function fmstreamFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

async function fmstream(params = {}) {
  const keya = 0xad4a;
  const keyb = 0x619a;

  const unix = Math.floor(Date.now() / 1000);
  const key = Math.round(keya * unix + keyb).toString(16);

  const qs = new URLSearchParams({ ...params, key }).toString();
  const url = `https://fmstream.org/index.php?${qs}`;

  return fmstreamFetch(url);
}

module.exports = { fmstream };
