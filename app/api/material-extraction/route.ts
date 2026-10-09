/**
 * `GET /api/material-extraction` — the read half of the course-material
 * derivation archive (`lib/persistence/material-extraction.ts`).
 *
 * ## What it is for
 *
 * The chapter directory travels between devices (`lib/document/
 * course-material-persistence.ts`), but a material's *bytes* never do: they
 * live in the uploading device's IndexedDB. Until now that made a restored
 * chapter visible but unusable — the file had to be selected again before a
 * lesson could be generated from it, even though the text had already been
 * extracted from those exact bytes and paid for.
 *
 * This route closes that gap. It answers with the archived extraction for a
 * byte digest, in the same response shape `/api/extract-document` uses, so the
 * generation pipeline consumes it without knowing which of the two answered.
 *
 * ## Address, not content
 *
 * The query is a **digest**, never bytes and never a material id: a nanoid
 * material id is allocated per upload, so two uploads of the same file would
 * have different ids and no archive row in common. The digest is the only
 * identifier two uploads share, and it is the same digest the route that
 * *wrote* the row computed — the two are the same algorithm by construction
 * (`lib/document/content-digest.ts` explains why that matters).
 *
 * `extractor` is optional and is the caller's preference, not a requirement:
 * see {@link selectArchivedExtraction} for why a miss falls back rather than
 * failing. Omitting it asks for "whatever you archived for these bytes", which
 * is the honest question a device with no bytes and default settings can ask.
 *
 * ## 404 is not one thing
 *
 * A deployment with no `DATABASE_URL` answers `404` for the route itself, the
 * way every other persistence-backed route does. A deployment that *has* an
 * archive answers `404` with `NOT_ARCHIVED` when this owner holds no usable
 * row for the digest. The two are deliberately different bodies so the client
 * can tell "this deployment cannot answer" from "this deployment has no such
 * chapter", and log the right one.
 *
 * Owner resolution is the same seam every owner-scoped route uses
 * (`withRequestOwner`): the principal comes from the session and is never a
 * request parameter, so one owner cannot read another's archive. A read is
 * never cached — the same key can be refreshed in place by a re-extraction.
 */
import type { NextRequest } from 'next/server';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import {
  archivedRecordToResponse,
  selectArchivedExtraction,
} from '@/lib/document/extraction-archive';
import { createLogger } from '@/lib/logger';
import { listMaterialExtractionsByDigest } from '@/lib/persistence/material-extraction';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { attachOwnerCookies, withRequestOwner } from '@/lib/server/identity/with-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const log = createLogger('MaterialExtraction');

/** A lowercase-hex SHA-256, the only shape `content_digest` is ever stored as. */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export async function GET(req: NextRequest) {
  if (!isServerPersistenceConfigured()) {
    return new Response('Not found', { status: 404 });
  }

  const search = new URL(req.url).searchParams;
  const digest = search.get('digest')?.trim() ?? '';
  if (!DIGEST_PATTERN.test(digest)) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'A 64-character lowercase-hex content digest is required.',
    );
  }
  // An empty `extractor` is treated as absent rather than as "the extractor
  // named empty string", which no record can match and which would only turn a
  // clear question into a guaranteed fallback.
  const requestedExtractorId = search.get('extractor')?.trim() || undefined;

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    // Every answer carries the resolution's `Set-Cookie` values (a minted or
    // renewed anonymous owner must survive this request) and is uncached: the
    // same key can be refreshed in place by a re-extraction, and nothing
    // downstream could invalidate a cached copy when it is.
    const answer = (response: Response): Response => {
      response.headers.set('Cache-Control', 'no-store');
      return attachOwnerCookies(response, responseHeaders.getSetCookie());
    };
    try {
      const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
      const records = await listMaterialExtractionsByDigest(pool, ownerId, digest);
      const selected = selectArchivedExtraction(records, requestedExtractorId);
      if (!selected) {
        log.debug(
          `No archived extraction [owner=${ownerId}, digest=${digest.slice(0, 12)}…, ` +
            `extractor=${requestedExtractorId ?? '(any)'}, rows=${records.length}]`,
        );
        return answer(
          apiError(
            'ASSET_NOT_FOUND',
            404,
            'No extraction of these bytes is stored for this owner.',
            undefined,
            'NOT_ARCHIVED',
          ),
        );
      }
      if (requestedExtractorId && selected.extractorId !== requestedExtractorId) {
        // The fallback is legitimate (see `selectArchivedExtraction`) but it is
        // worth saying out loud: the text came from a different parser than the
        // one this device has selected.
        log.debug(
          `Served "${selected.fileName ?? digest.slice(0, 12)}" from ${selected.extractorId}` +
            `@${selected.extractorVersion}, not the requested ${requestedExtractorId}`,
        );
      }
      return answer(apiSuccess({ data: await archivedRecordToResponse(pool, selected) }, 200));
    } catch (error) {
      log.error(`Could not read the extraction archive [owner=${ownerId}]:`, error);
      return answer(
        apiError(
          'INTERNAL_ERROR',
          500,
          'The extraction archive could not be read.',
          undefined,
          'ARCHIVE_UNAVAILABLE',
        ),
      );
    }
  });
}
