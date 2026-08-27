// Minimal Web Push (VAPID) sender for payload-less "tickle" notifications:
// we sign a VAPID JWT and POST an empty body to the subscription endpoint;
// the service worker's push handler shows a generic "new request" notification.
// No aes128gcm payload encryption needed (the SW supplies the text), which
// keeps this dependency-free and robust.

function b64urlBytes(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlStr(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

async function vapidToken(env, audience) {
  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT,
  };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web Crypto returns the ECDSA signature as raw r||s (IEEE P1363), which is
  // exactly the JWS ES256 form.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64urlBytes(sig)}`;
}

// Sends a payload-less push. Returns the push service's HTTP response so the
// caller can prune stale (404/410) subscriptions.
export async function sendPush(env, subscription) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await vapidToken(env, audience);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
      TTL: '2419200',
    },
    signal: AbortSignal.timeout(5000),
  });
}
