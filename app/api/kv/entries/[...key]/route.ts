/**
 * `GET|PUT|DELETE /api/kv/entries/{key}` — the `account`-scope KV store over
 * HTTP, per `packages/@openmaic/storage/docs/kv-http-contract.md`.
 *
 * The contract's client half (`HttpAccountKV`, reached through `HttpKVStore`)
 * already ships in the storage package; this is the server half a real
 * deployment needs, backed by the owner-scoped `app_kv` table
 * (`lib/persistence/app-kv.ts`).
 *
 * Three things the contract is strict about, and why this handler is:
 *
 * 1. **The scope is never on the wire.** `account` is the only scope this
 *    route serves and there is no field for a `device` value to occupy, in any
 *    of the four channels a client or proxy might reach for: the path, the
 *    query string, a header, or the body. Each is refused with `400` rather
 *    than ignored, so a client that tries to describe a scope fails loud
 *    instead of having its intent silently discarded — the failure mode that
 *    would put a device-local value on a server.
 * 2. **Keys are opaque.** The key is decoded once and used as a bound
 *    parameter; it is never parsed, never a path component of a query, and
 *    never validated for content.
 * 3. **`404` is not one thing.** Only `KEY_NOT_FOUND` maps to a missing value
 *    on the client; an absent route or a refusal must stay an error, so the
 *    machine-readable code is what distinguishes them.
 *
 * Reads carry `Cache-Control: no-store` — `account` is by definition the scope
 * another device may have just written, and nothing downstream can invalidate
 * a cached copy when that happens.
 *
 * Owner resolution is the same seam every owner-scoped route uses
 * (`withRequestOwner`): the principal comes from the authenticated session and
 * is never a request parameter, so one account cannot address another's keys.
 * Gated on server persistence, NOT on the agent runtime: this needs the
 * database and nothing the runtime adds.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { deleteAppKvEntry, readAppKvEntry, writeAppKvEntry } from '@/lib/persistence/app-kv';
import { ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ key: string[] }> };

/** The contract's error envelope. `details` is optional and unused here. */
function contractError(status: number, code: string, message: string, headers?: Headers): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/**
 * A `scope` this contract cannot express, in any of the four channels it could
 * arrive in. Returns the reason to answer `400` with, or `null` when the
 * request is clean.
 */
function scopeViolation(req: NextRequest, search: URLSearchParams): string | null {
  if (search.has('scope')) {
    return 'this contract carries no scope; a ?scope= query parameter is not expressible';
  }
  // There is no single canonical spelling of a scope header, so the whole
  // prohibited set is refused — checking one leaves the others open.
  for (const name of ['scope', 'x-scope', 'kv-scope', 'x-kv-scope']) {
    if (req.headers.get(name) !== null) {
      return `this contract carries no scope; the ${name} header is not expressible`;
    }
  }
  return null;
}

/**
 * Whether the request carries a body. `GET` and `DELETE` are bodyless here, so
 * a body is a malformed request rather than something to ignore: a server that
 * routed them without reading the body would let `GET /kv/keys` with a scope
 * field succeed, and the no-scope guarantee would fail silently.
 */
function carriesBody(req: NextRequest): boolean {
  const length = req.headers.get('content-length');
  if (length !== null && length !== '0') return true;
  return req.headers.get('transfer-encoding') !== null;
}

/** Decode the catch-all segments back into one opaque key. */
function decodeKey(segments: readonly string[]): string {
  return segments.map((segment) => decodeURIComponent(segment)).join('/');
}

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) {
    return contractError(404, 'ROUTE_NOT_FOUND', 'the kv route is not served by this deployment');
  }
  const search = new URL(req.url).searchParams;
  const violation = scopeViolation(req, search);
  if (violation) return contractError(400, 'VALIDATION_FAILED', violation);
  if (carriesBody(req)) {
    return contractError(400, 'VALIDATION_FAILED', 'a kv read carries no request body');
  }

  const key = decodeKey((await params).key);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    // Reads never come from a cache: another device may have written this key
    // a moment ago and nothing downstream can invalidate a cached copy.
    responseHeaders.set('Cache-Control', 'no-store');
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const value = await readAppKvEntry(pool, ownerId, key);
      if (value === null) {
        return contractError(
          404,
          'KEY_NOT_FOUND',
          'no value is stored under this key',
          responseHeaders,
        );
      }
      return Response.json({ value }, { status: 200, headers: responseHeaders });
    } catch (error) {
      console.error(`[AppKV] Failed to read [owner=${ownerId}]:`, error);
      return contractError(500, 'INTERNAL_ERROR', 'the value could not be read', responseHeaders);
    }
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) {
    return contractError(404, 'ROUTE_NOT_FOUND', 'the kv route is not served by this deployment');
  }
  const search = new URL(req.url).searchParams;
  const violation = scopeViolation(req, search);
  if (violation) return contractError(400, 'VALIDATION_FAILED', violation);

  const key = decodeKey((await params).key);

  // The body is read before the owner is resolved, so a malformed request
  // cannot mint an anonymous cookie partition for a write that will not run —
  // the same ordering the folder routes use.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return contractError(400, 'VALIDATION_FAILED', 'a kv write body must be JSON');
  }
  if (typeof body !== 'object' || body === null || !('value' in body)) {
    return contractError(400, 'VALIDATION_FAILED', 'a kv write body must carry "value"');
  }
  const value = (body as { value: unknown }).value;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      await writeAppKvEntry(pool, ownerId, key, value);
      return new Response(null, { status: 204, headers: responseHeaders });
    } catch (error) {
      // A write under a retired or busy owner answers `403`/`503` like every
      // other owner write, rather than a generic failure.
      const refused = ownerWriteErrorResponse(error, responseHeaders);
      if (refused) return refused;
      console.error(`[AppKV] Failed to write [owner=${ownerId}]:`, error);
      return contractError(
        500,
        'INTERNAL_ERROR',
        'the value could not be written',
        responseHeaders,
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) {
    return contractError(404, 'ROUTE_NOT_FOUND', 'the kv route is not served by this deployment');
  }
  const search = new URL(req.url).searchParams;
  const violation = scopeViolation(req, search);
  if (violation) return contractError(400, 'VALIDATION_FAILED', violation);
  if (carriesBody(req)) {
    return contractError(400, 'VALIDATION_FAILED', 'a kv delete carries no request body');
  }

  const key = decodeKey((await params).key);
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      await deleteAppKvEntry(pool, ownerId, key);
      // Idempotent: deleting an absent key succeeds.
      return new Response(null, { status: 204, headers: responseHeaders });
    } catch (error) {
      const refused = ownerWriteErrorResponse(error, responseHeaders);
      if (refused) return refused;
      console.error(`[AppKV] Failed to delete [owner=${ownerId}]:`, error);
      return contractError(
        500,
        'INTERNAL_ERROR',
        'the value could not be deleted',
        responseHeaders,
      );
    }
  });
}
