import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cookiesUseSecureAttribute } from '@/lib/server/secure-cookies';

/**
 * Two cookies carry authority — the anonymous owner cookie and the access-code
 * token — and both must answer "does this deployment's traffic warrant the
 * `Secure` attribute" the same way. They once answered it separately and
 * drifted: the anonymous cookie honoured `COOKIE_SECURE=0` while the
 * access-code cookie hard-coded the production check, so a plain-HTTP LAN
 * deployment could never keep the access code. These tests pin the shared
 * policy and the fact that both call sites read it.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cookiesUseSecureAttribute', () => {
  it('is on in production by default', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', undefined);
    expect(cookiesUseSecureAttribute()).toBe(true);
  });

  it('opts out only for the exact value 0', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', '0');
    expect(cookiesUseSecureAttribute()).toBe(false);

    vi.stubEnv('COOKIE_SECURE', 'false');
    expect(cookiesUseSecureAttribute()).toBe(true);
  });

  it('is off outside production even when COOKIE_SECURE is set', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('COOKIE_SECURE', '0');
    expect(cookiesUseSecureAttribute()).toBe(false);

    vi.stubEnv('COOKIE_SECURE', undefined);
    expect(cookiesUseSecureAttribute()).toBe(false);
  });
});

describe('the shared policy has one reader-facing source', () => {
  const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
  const POLICY = 'cookiesUseSecureAttribute';

  it.each(['app/api/access-code/verify/route.ts', 'lib/server/identity/anonymous-cookie.ts'])(
    '%s reads the shared decision',
    (path) => {
      expect(source(path)).toContain(POLICY);
    },
  );

  it.each(['app/api/access-code/verify/route.ts', 'lib/server/identity/anonymous-cookie.ts'])(
    '%s does not re-inline the production check',
    (path) => {
      // The drift this module exists to prevent: a second copy of the policy.
      expect(source(path)).not.toMatch(/process\.env\.NODE_ENV\s*===\s*'production'/);
    },
  );
});
