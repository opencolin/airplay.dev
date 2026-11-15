// Holds the shared SmartThings OAuth app's secret, so hubs never need it. Hubs send the one-time
// code (or their own refresh token) here and get the tokens back; nothing is stored.
const TOKEN_URL = 'https://api.smartthings.com/oauth/token';
export const REDIRECT_URI = 'https://airplay.dev/smartthings/callback';
export const SCOPE = 'r:devices:*';

const json = (status, body) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function exchange(request, grant) {
  const { SMARTTHINGS_CLIENT_ID: id, SMARTTHINGS_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return json(503, { error: 'SmartThings sign-in is not set up on airplay.dev yet.' });
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Send JSON.' });
  }
  const params = grant(body);
  if (!params) return json(400, { error: 'Missing code or refresh_token.' });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...params, client_id: id }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return json(res.status === 400 || res.status === 401 ? 400 : 502, { error: data.error_description ?? data.error ?? `SmartThings answered ${res.status}.` });
  const { access_token, refresh_token, expires_in, scope } = data;
  return json(200, { access_token, refresh_token, expires_in, scope });
}
