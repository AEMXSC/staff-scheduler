// Stateless session tokens: the expiry is baked into the signed payload, so
// there's nothing to look up or store per-session -- just verify the HMAC.

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

export async function issueToken(env) {
  const expiryMs = Date.now() + SESSION_TTL_MS;
  const sig = await hmacHex(env.SESSION_SECRET, String(expiryMs));
  return `${expiryMs}.${sig}`;
}

export async function verifyToken(env, token) {
  if (!token) return false;
  const [expiryStr, sig] = token.split('.');
  const expiryMs = Number(expiryStr);
  if (!expiryMs || Number.isNaN(expiryMs) || Date.now() > expiryMs) return false;
  const expected = await hmacHex(env.SESSION_SECRET, expiryStr);
  return expected === sig;
}

export function requireAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  return verifyToken(env, token);
}

// Failed-attempt counter, keyed by IP, in the same KV namespace as the
// schedule data (different key prefix) -- not worth a second namespace.
const MAX_ATTEMPTS = 5;
const LOCKOUT_TTL_SECONDS = 600;

export async function isRateLimited(env, ip) {
  const raw = await env.SCHEDULE_KV.get(`authfail:${ip}`);
  return raw !== null && Number(raw) >= MAX_ATTEMPTS;
}

export async function recordFailedAuth(env, ip) {
  const raw = await env.SCHEDULE_KV.get(`authfail:${ip}`);
  const count = (raw ? Number(raw) : 0) + 1;
  await env.SCHEDULE_KV.put(`authfail:${ip}`, String(count), { expirationTtl: LOCKOUT_TTL_SECONDS });
}

export async function clearFailedAuth(env, ip) {
  await env.SCHEDULE_KV.delete(`authfail:${ip}`);
}
