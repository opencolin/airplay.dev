// One-time setup for airplay.dev's shared SmartThings OAuth app, for accounts where the
// SmartThings CLI can't sign in. Needs a personal access token with the Apps scopes saved to
// data/smartthings-admin-token.txt. Writes the app (with its client secret) to
// data/smartthings-app.json and prints only the ids.
import fs from 'node:fs';
import path from 'node:path';

const data = path.join(import.meta.dirname, '..', 'data');
const token = fs.readFileSync(path.join(data, 'smartthings-admin-token.txt'), 'utf8').trim();
const request = JSON.parse(fs.readFileSync(path.join(data, 'smartthings-app-request.json'), 'utf8'));
const res = await fetch('https://api.smartthings.com/v1/apps?signatureType=ST_PADLOCK&requireConfirmation=false', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(request),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`SmartThings answered ${res.status}:`, JSON.stringify(body.error ?? body));
  process.exit(1);
}
fs.writeFileSync(path.join(data, 'smartthings-app.json'), JSON.stringify(body, null, 2), { mode: 0o600 });
console.log('Registered', body.app?.appName, 'appId', body.app?.appId, 'clientId', body.oauthClientId);
