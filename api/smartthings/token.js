import { exchange, REDIRECT_URI } from './_oauth.js';

export function POST(request) {
  return exchange(request, ({ code }) => (typeof code === 'string' && code
    ? { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI } : null));
}
