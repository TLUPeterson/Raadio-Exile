# Raadio-Exile

## Setup

Create a `.env` file with the desired prefix and three bot tokens:
```
PREFIX="!"
TOKEN_1="" # Primary Discord bot token
TOKEN_2="" # Second Discord bot token
TOKEN_3="" # Third Discord bot token
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
ANNOUNCEMENT_INTERVAL_MS=1800000 # time in milliseconds (3600000 for 1 hour)
RADIO_RESUME_MAX_ATTEMPTS=3 # stop after this many consecutive stream failures
RADIO_RESUME_RETRY_BASE_MS=1000 # exponential retry delay: 1s, 2s, 4s
RADIO_RESUME_RETRY_MAX_MS=30000 # maximum delay between stream retries
RADIO_STABLE_PLAYBACK_MS=30000 # successful playback duration that resets failures
keya="" #fmstream key
keyb="" #fmstream key
YOUTUBE_COOKIE_FILE='/path/to/youtube-cookies.txt' # optional; only needed for restricted videos
PYTHON_BIN='python3' # optional override; defaults to py on Windows and python3 elsewhere
```

Run these commands in the terminal:

```bash
npm install
python3 -m pip install -r requirements.txt
```

On Windows, use `py -m pip install -r requirements.txt` for the second command.

Create three applications in the Discord Developer Portal, add a bot to each,
and invite all three bots to the same server with voice permissions. Never use
normal Discord user-account tokens.

Start all configured bots with:

```bash
npm start
```

Normal prefix commands such as `!raadio` are automatically routed to a bot
already serving your voice channel or to the first available bot. Address a
specific bot by mentioning it, for example `@Radio Bot 2 raadio` or
`@Radio Bot 2 stop`. Each bot also registers its own `/radio` command; choose the
desired bot/application in Discord's command picker.

Each bot can occupy one voice channel in a server, allowing up to three voice
channels in that server at the same time. A bot that is already active in one
channel cannot be reused in another channel until it is stopped.

## Favorites

Favorites are shared by everyone in a Discord server. Use **Lisa lemmikuks** on
the Now Playing message to save a station, or **Eemalda lemmikutest** to remove
it. Saved stations appear under **Lemmikud** in the main radio menu.

The three bot processes coordinate all writes through the pool launcher. Data is
stored atomically in `data/favorites.json`, is limited to 25 stations per server,
and is ignored by Git. Back up this file when migrating the Oracle VM. Set
`FAVORITES_FILE=/another/path/favorites.json` to store it outside the repository.

## Web dashboard

The optional dashboard provides live status for all three bots, voice-channel
selection, station search, playback controls, favorites, and recent history.
It listens on localhost by default so it can safely sit behind Caddy or Nginx.

Add these values to `.env`:

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=3000
DISCORD_CLIENT_ID=your-primary-application-id
DISCORD_CLIENT_SECRET=your-primary-application-secret
DISCORD_REDIRECT_URI=https://radio.example.com/auth/discord/callback
DASHBOARD_ALLOWED_GUILD_IDS=your-discord-server-id
# Optional: restrict control to specific Discord users
DASHBOARD_ALLOWED_USER_IDS=user-id-1,user-id-2
HISTORY_FILE=/home/ubuntu/raadio-data/history.json
HISTORY_MAX_ENTRIES=5000
```

In the primary application in Discord's Developer Portal, add the exact
`DISCORD_REDIRECT_URI` under **OAuth2 -> Redirects**. The dashboard requests only
the `identify` and `guilds` scopes and keeps the OAuth access token server-side.

An example reverse-proxy configuration is available in
`deploy/Caddyfile.example`. Replace its hostname, point the domain's DNS record
at the Oracle VM, allow inbound TCP ports 80 and 443 in OCI and Ubuntu, and keep
port 3000 private. After deployment, `/health` should return `{ "ok": true }`.

For a single-bot setup, keep using `TOKEN` and run:

```bash
npm run start:single
```

"!raadio" open discord ui for channel selection
 
## YouTube

YouTube playback uses yt-dlp, FFmpeg, and Node.js 22 or newer. Keep yt-dlp updated because YouTube changes frequently:

```bash
python3 -m pip install -U -r requirements.txt
```

Public videos normally do not need cookies. For restricted videos, export YouTube cookies in Netscape `cookies.txt` format and set `YOUTUBE_COOKIE_FILE` to that file's path. Keep the file private and do not commit it.
