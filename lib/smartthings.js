import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.smartthings.com/v1';
const INPUT_CAPABILITIES = ['samsungvd.mediaInputSource', 'mediaInputSource'];
// airplay.dev holds the shared OAuth app's secret and swaps codes and refresh tokens for us.
const AIRPLAY = process.env.AIRPLAY_ORIGIN ?? 'https://airplay.dev';
const REFRESH_EARLY_MS = 60 * 60000;
const SIGN_IN_MS = 10 * 60000;

// Access comes from, in order: SMARTTHINGS_TOKEN, a SmartThings sign-in (OAuth, refreshed here),
// or a personal access token saved to smartthings-token.txt (these expire after 24 hours).
export function smartThings(dataDir) {
  const tokenFile = path.join(dataDir, 'smartthings-token.txt');
  const oauthFile = path.join(dataDir, 'smartthings-oauth.json');
  const pending = new Map(); // sign-in state -> expiry
  let refreshing = null;

  const readOauth = () => (fs.existsSync(oauthFile) ? JSON.parse(fs.readFileSync(oauthFile, 'utf8')) : null);
  const readPat = () => (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() || null : null);

  async function airplay(route, body) {
    const res = await fetch(AIRPLAY + route, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `airplay.dev answered ${res.status}.`);
    return data;
  }

  function saveOauth({ access_token, refresh_token, expires_in }) {
    const saved = { access_token, refresh_token, expires_at: Date.now() + expires_in * 1000 };
    fs.writeFileSync(oauthFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    return saved;
  }

  async function oauthToken() {
    const saved = readOauth();
    if (!saved) return null;
    if (saved.expires_at - Date.now() > REFRESH_EARLY_MS) return saved.access_token;
    // SmartThings replaces the refresh token on every refresh, so only ever run one at a time.
    refreshing ??= airplay('/api/smartthings/refresh', { refresh_token: saved.refresh_token })
      .then(saveOauth).finally(() => { refreshing = null; });
    try {
      return (await refreshing).access_token;
    } catch (err) {
      if (saved.expires_at > Date.now()) return saved.access_token;
      throw new Error(`SmartThings sign-in expired (${err.message}). Sign in again from the dashboard.`);
    }
  }

  return {
    method() {
      if (process.env.SMARTTHINGS_TOKEN) return 'env';
      if (readOauth()) return 'oauth';
      return readPat() ? 'token' : null;
    },
    async token() {
      return process.env.SMARTTHINGS_TOKEN?.trim() || await oauthToken() || readPat();
    },
    async signInUrl(port) {
      const { authorizeUrl, clientId, redirectUri, scope } = await airplay('/api/smartthings/config');
      const state = `${crypto.randomBytes(18).toString('base64url')}.${port}`;
      pending.set(state, Date.now() + SIGN_IN_MS);
      const url = new URL(authorizeUrl);
      url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope, state });
      return url.href;
    },
    async finishSignIn({ code, state, error, error_description: description }) {
      const expires = pending.get(state);
      pending.delete(state);
      if (!expires || expires < Date.now()) throw new Error('This sign-in link is old or came from somewhere else. Start again from the dashboard.');
      if (error) throw new Error(`SmartThings refused: ${description ?? error}`);
      if (!code) throw new Error('SmartThings sent no code.');
      saveOauth(await airplay('/api/smartthings/token', { code }));
    },
    savePersonalToken(token) {
      if (!/^[0-9a-f-]{36}$/i.test(token ?? '')) throw new Error('That does not look like a SmartThings token.');
      fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    },
    disconnect() {
      for (const file of [oauthFile, tokenFile]) fs.rmSync(file, { force: true });
    },
  };
}

async function get(token, url) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error('SmartThings token is invalid or expired.');
  if (res.status === 403) throw new Error('SmartThings token lacks the r:devices:* scope.');
  if (!res.ok) throw new Error(`SmartThings answered ${res.status}.`);
  return res.json();
}

async function listDevices(token) {
  const devices = [];
  for (let url = '/devices'; url; ) {
    const page = await get(token, url);
    devices.push(...page.items);
    url = page._links?.next?.href;
  }
  return devices;
}

// What each SmartThings TV or monitor reports.
export async function readInputs(token) {
  const screens = (await listDevices(token)).filter((d) => d.ocf?.ocfDeviceType === 'oic.d.tv'
    || d.components?.some((c) => c.capabilities?.some((cap) => INPUT_CAPABILITIES.includes(cap.id))));
  return Promise.all(screens.map(async (d) => {
    const main = (await get(token, `/devices/${d.deviceId}/status`)).components?.main ?? {};
    const input = INPUT_CAPABILITIES.map((cap) => main[cap]?.inputSource?.value).find(Boolean) ?? null;
    return {
      deviceId: d.deviceId,
      label: d.label ?? d.name,
      model: main.ocf?.mnmo?.value ?? null,
      power: main.switch?.switch?.value ?? null,
      input,
    };
  }));
}

// Pair SmartThings devices with hub screens by name. SmartThings ids don't match anything the
// screens report on the LAN, but a name set in the SmartThings app becomes the screen's network
// name, so each screen needs a name no other screen has.
export function matchInputs(monitors, devices) {
  const byScreen = {};
  const unmatched = [];
  for (const d of devices) {
    const named = monitors.filter((s) => s.name === d.label || s.label === d.label);
    if (named.length === 1) byScreen[named[0].id] = d;
    else unmatched.push(d);
  }
  return { byScreen, unmatched };
}
