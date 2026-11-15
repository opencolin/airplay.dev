import { REDIRECT_URI, SCOPE } from './_oauth.js';

// The client id is public: hubs need it to send people to SmartThings to sign in.
export function GET() {
  const clientId = process.env.SMARTTHINGS_CLIENT_ID;
  if (!clientId) return Response.json({ error: 'SmartThings sign-in is not set up on airplay.dev yet.' }, { status: 503 });
  return Response.json({
    authorizeUrl: 'https://api.smartthings.com/oauth/authorize', clientId, redirectUri: REDIRECT_URI, scope: SCOPE,
  });
}
