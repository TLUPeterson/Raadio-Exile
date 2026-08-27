const fs = require('fs');
const path = require('path');
const util = require('util');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const TOKEN_PATTERNS = [
  /(token\s*[=:]\s*)["']?[^"'\s]+/gi,
  /(authorization\s*:\s*bot\s+)[^"'\s]+/gi,
  /(key=)[^&\s]+/gi,
];

let installed = false;
let currentDate = null;
let stream = null;

function getDateParts(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureLogStream() {
  const date = getDateParts();
  if (stream && currentDate === date) {
    return stream;
  }

  if (stream) {
    stream.end();
    stream = null;
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  currentDate = date;
  stream = fs.createWriteStream(path.join(LOG_DIR, `${date}.log`), { flags: 'a' });
  return stream;
}

function redactSecrets(message) {
  return TOKEN_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, '$1[REDACTED]'),
    message
  );
}

function formatArgs(args) {
  return redactSecrets(args.map((arg) => {
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }

    if (typeof arg === 'string') {
      return arg;
    }

    return util.inspect(arg, {
      depth: 6,
      colors: false,
      breakLength: 120,
    });
  }).join(' '));
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
  try {
    ensureLogStream().write(line);
  } catch (_) {
    // Avoid recursive logging if filesystem logging itself fails.
  }
}

function installLogger() {
  if (installed) {
    return;
  }

  installed = true;
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      write(level, args);
      original[level](...args);
    };
  }

  process.on('warning', (warning) => {
    write('warning', [warning]);
  });

  process.on('beforeExit', () => {
    if (stream) {
      stream.end();
    }
  });

  console.info(`[Logger] Daily logs enabled in ${LOG_DIR}`);
}

module.exports = { installLogger };
