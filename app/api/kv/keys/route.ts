/**
 * `GET /api/kv/keys?prefix=` — list the caller's keys, per
 * `packages/@openmaic/storage/docs/kv-http-contract.md`.
 *
 * The listing is scoped to the request's owner and is never paginated (the
 * primitive is sized for small configuration values). A prefix is as opaque as
 * a key: it is a literal, byte-for-byte comparison, and the store escapes
 * `LIKE`'s metacharacters before applying it so a prefix containing `%`, `_`
 * or the escape character cannot silently become a pattern.
 *
 * It shares the entries route's channel rules: no scope anywhere (path, query,
 * header, body), and the read is never cached.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { listAppKvKeys } from '@/lib/persistence/app-kv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function contractError(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

function scopeViolation(req: NextRequest, search: URLSearchParams): string | null {
  if (search.has('scope')) {
    return 'this contract carries no scope; a ?scope= query parameter is not expressible';
  }
  for (const name of ['scope', 'x-scope', 'kv-scope', 'x-kv-scope']) {
    if (req.headers.get(name) !== null) {
      return `this contract carries no scope; the ${name} header is not expressible`;
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) {
    return contractError(404, 'ROUTE_NOT_FOUND', 'the kv route is not served by this deployment');
  }
  const search = new URL(req.url).searchParams;
  const violation = scopeViolation(req, search);
  if (violation) return contractError(400, 'VALIDATION_FAILED', violation);
  const length = req.headers.get('content-length');
  if ((length !== null && length !== '0') || req.headers.get('transfer-encoding') !== null) {
    return contractError(400, 'VALIDATION_FAILED', 'a kv read carries no request body');
  }

  // An absent prefix means "list everything" — the empty string is a
  // legitimate, literal prefix of every key.
  const prefix = search.get('prefix') ?? '';

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    responseHeaders.set('Cache-Control', 'no-store');
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const keys = await listAppKvKeys(pool, ownerId, prefix);
      return Response.json(keys, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error(`[AppKV] Failed to list keys [owner=${ownerId}]:`, error);
      return contractError(500, 'INTERNAL_ERROR', 'the keys could not be listed', responseHeaders);
    }
  });
}
