const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB_ROOT = path.join(__dirname, 'web');
const sessions = new Map();
const oauthStates = new Map();
let developmentSession = null;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function redirect(response, location, cookie) {
  response.writeHead(302, { Location: location, ...(cookie ? { 'Set-Cookie': cookie } : {}) });
  response.end();
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function getSession(request) {
  if (developmentSession) return developmentSession;
  const id = parseCookies(request.headers.cookie).raadio_session;
  const session = id ? sessions.get(id) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return session;
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) sendJson(response, 401, { error: 'Login required.' });
  return session;
}

function assertGuildAccess(session, guildId) {
  const allowedUsers = String(process.env.DASHBOARD_ALLOWED_USER_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  if (allowedUsers.length && !allowedUsers.includes(session.user.id)) throw new Error('Your account is not allowed to control this dashboard.');
  if (!guildId || !session.guildIds.includes(String(guildId))) throw new Error('You cannot control that server.');
  const configured = String(process.env.DASHBOARD_ALLOWED_GUILD_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean);
  if (configured.length && !configured.includes(String(guildId))) throw new Error('That server is not enabled.');
}

function assertCsrf(request, session) {
  if (request.headers['x-csrf-token'] !== session.csrfToken) throw new Error('Invalid security token.');
}

function serveFile(response, fileName, contentType) {
  fs.readFile(path.join(WEB_ROOT, fileName), (error, data) => {
    if (error) return sendJson(response, 404, { error: 'Not found.' });
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
    });
    response.end(data);
  });
}

function startDashboard(handlers) {
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  const secureCookie = redirectUri?.startsWith('https://');
  if (process.env.DASHBOARD_DEV_BYPASS === 'true' && ['127.0.0.1', 'localhost', '::1'].includes(host)) {
    developmentSession = {
      user: { id: 'dashboard-preview', username: 'Dashboard Preview', avatar: null },
      guildIds: String(process.env.DASHBOARD_DEV_GUILD_IDS || process.env.DASHBOARD_ALLOWED_GUILD_IDS || 'preview-guild')
        .split(',').map((id) => id.trim()).filter(Boolean),
      csrfToken: 'dashboard-preview-token',
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    console.warn('[Dashboard] Development authentication bypass is active on loopback.');
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (request.method === 'GET' && requestUrl.pathname === '/') {
        return serveFile(response, 'index.html', 'text/html; charset=utf-8');
      }
      if (request.method === 'GET' && requestUrl.pathname === '/styles.css') {
        return serveFile(response, 'styles.css', 'text/css; charset=utf-8');
      }
      if (request.method === 'GET' && requestUrl.pathname === '/app.js') {
        return serveFile(response, 'app.js', 'application/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && requestUrl.pathname === '/health') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && requestUrl.pathname === '/auth/login') {
        if (!clientId || !clientSecret || !redirectUri) {
          return sendJson(response, 503, { error: 'Discord OAuth is not configured.' });
        }
        const state = crypto.randomBytes(24).toString('hex');
        oauthStates.set(state, Date.now() + 10 * 60_000);
        const authorize = new URL('https://discord.com/oauth2/authorize');
        authorize.search = new URLSearchParams({
          response_type: 'code', client_id: clientId, scope: 'identify guilds',
          state, redirect_uri: redirectUri, prompt: 'consent',
        });
        return redirect(response, authorize.toString());
      }
      if (request.method === 'GET' && requestUrl.pathname === '/auth/discord/callback') {
        const state = requestUrl.searchParams.get('state');
        const code = requestUrl.searchParams.get('code');
        const oauthError = requestUrl.searchParams.get('error');
        const oauthErrorDescription = requestUrl.searchParams.get('error_description');
        if (oauthError) {
          throw new Error(`Discord authorization was denied: ${oauthErrorDescription || oauthError}`);
        }
        const expiresAt = oauthStates.get(state);
        oauthStates.delete(state);
        if (!state || !code || !expiresAt || expiresAt < Date.now()) throw new Error('Invalid OAuth state.');

        const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code, client_id: clientId,
            client_secret: clientSecret, redirect_uri: redirectUri,
          }),
        });
        if (!tokenResponse.ok) {
          const errorBody = await tokenResponse.text();
          let errorDetails = errorBody.slice(0, 300);
          try {
            const parsedError = JSON.parse(errorBody);
            errorDetails = parsedError.error_description || parsedError.error || errorDetails;
          } catch (_) {}
          console.error(`[Dashboard OAuth] Discord token exchange returned HTTP ${tokenResponse.status}: ${errorDetails}`);
          throw new Error(`Discord login failed: ${errorDetails || `HTTP ${tokenResponse.status}`}`);
        }
        const token = await tokenResponse.json();
        const authHeaders = { Authorization: `Bearer ${token.access_token}` };
        const [userResponse, guildResponse] = await Promise.all([
          fetch('https://discord.com/api/v10/users/@me', { headers: authHeaders }),
          fetch('https://discord.com/api/v10/users/@me/guilds', { headers: authHeaders }),
        ]);
        if (!userResponse.ok || !guildResponse.ok) throw new Error('Could not read Discord account information.');
        const user = await userResponse.json();
        const guilds = await guildResponse.json();
        const sessionId = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionId, {
          user: { id: user.id, username: user.global_name || user.username, avatar: user.avatar },
          guildIds: guilds.map((guild) => guild.id),
          csrfToken: crypto.randomBytes(24).toString('hex'),
          expiresAt: Date.now() + Math.min(Number(token.expires_in || 604_800) * 1_000, 7 * 24 * 60 * 60_000),
        });
        const cookie = `raadio_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureCookie ? '; Secure' : ''}`;
        return redirect(response, '/', cookie);
      }
      if (request.method === 'POST' && requestUrl.pathname === '/auth/logout') {
        const sessionId = parseCookies(request.headers.cookie).raadio_session;
        if (sessionId) sessions.delete(sessionId);
        return redirect(response, '/', 'raadio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
        const session = getSession(request);
        return sendJson(response, 200, session
          ? { authenticated: true, user: session.user, csrfToken: session.csrfToken }
          : { authenticated: false, oauthConfigured: Boolean(clientId && clientSecret && redirectUri) });
      }

      const session = requireSession(request, response);
      if (!session) return;

      if (request.method === 'GET' && requestUrl.pathname === '/api/overview') {
        const guildId = requestUrl.searchParams.get('guildId');
        const overview = await handlers.getOverview(session.guildIds, guildId);
        return sendJson(response, 200, overview);
      }
      if (request.method === 'GET' && requestUrl.pathname === '/api/stations') {
        const guildId = requestUrl.searchParams.get('guildId');
        assertGuildAccess(session, guildId);
        if (session.lastStationSearchAt && Date.now() - session.lastStationSearchAt < 2_000) {
          throw new Error('Please wait two seconds between station searches.');
        }
        session.lastStationSearchAt = Date.now();
        const stations = await handlers.searchStations({
          country: requestUrl.searchParams.get('country'),
          style: requestUrl.searchParams.get('style'),
          query: requestUrl.searchParams.get('query'),
        });
        return sendJson(response, 200, { stations });
      }
      if (request.method === 'POST' && ['/api/play', '/api/stop', '/api/favorites'].includes(requestUrl.pathname)) {
        assertCsrf(request, session);
        const body = await readBody(request);
        assertGuildAccess(session, body.guildId);
        let result;
        if (requestUrl.pathname === '/api/play') {
          result = await handlers.play({ ...body, userId: session.user.id });
        } else if (requestUrl.pathname === '/api/stop') {
          result = await handlers.stop(body);
        } else if (body.operation === 'add') {
          result = await handlers.addFavorite(body.guildId, body.station, session.user.id);
        } else if (body.operation === 'remove') {
          result = await handlers.removeFavorite(body.guildId, body.url);
        } else {
          throw new Error('Unknown favorites operation.');
        }
        return sendJson(response, 200, result);
      }
      return sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      console.error('[Dashboard]', error);
      return sendJson(response, 400, { error: error.message || 'Request failed.' });
    }
  });

  server.listen(port, host, () => {
    console.log(`[Dashboard] Listening on http://${host}:${port}`);
    if (!clientId || !clientSecret || !redirectUri) console.warn('[Dashboard] Discord OAuth settings are incomplete.');
  });
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [state, expiresAt] of oauthStates) if (expiresAt <= now) oauthStates.delete(state);
  }, 60 * 60_000).unref();
  return server;
}

module.exports = { startDashboard };
