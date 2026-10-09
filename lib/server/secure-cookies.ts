/**
 * Whether credential-bearing cookies carry the `Secure` attribute.
 *
 * Two cookies carry authority rather than preferences: the anonymous owner
 * cookie (`lib/server/identity/anonymous-cookie.ts`) and the access-code token
 * (`app/api/access-code/verify/route.ts`). Both must answer this the same way,
 * so the policy lives here and both ask it.
 *
 * Production sets `Secure` by default. A deployment served over plain HTTP
 * opts out with the exact value `COOKIE_SECURE=0`: browsers only treat
 * `https://` origins and loopback (`localhost`, `127.0.0.1`) as secure
 * contexts, so a `Secure` cookie handed out over `http://<lan-ip>` is silently
 * dropped — every request then mints a fresh owner or re-demands the access
 * code. Safari refuses such cookies even on plain `http://localhost`, which is
 * how the escape hatch was first introduced.
 *
 * This module must stay dependency-free: the Edge middleware mints the
 * anonymous cookie through `identity/anonymous-cookie.ts`, which imports it,
 * so it may not pull in `node:*` built-ins or `crypto`.
 *
 * ⚠️ Turning the attribute off removes real protection the moment the service
 * is reachable beyond a trusted network: an attacker who can observe the
 * connection reads the cookie in the clear. Keep the default (`Secure` on) for
 * anything exposed to the public internet or fronted by TLS.
 */
export function cookiesUseSecureAttribute(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '0';
}
