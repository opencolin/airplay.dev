import { exchange } from './_oauth.js';

export function POST(request) {
  return exchange(request, ({ refresh_token }) => (typeof refresh_token === 'string' && refresh_token
    ? { grant_type: 'refresh_token', refresh_token } : null));
}
