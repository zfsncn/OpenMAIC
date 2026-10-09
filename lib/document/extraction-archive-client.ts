/**
 * The browser's half of the course-material derivation archive: ask
 * `GET /api/material-extraction` for the extraction of a known byte digest.
 *
 * ## When this is the only source left
 *
 * The chapter directory syncs between devices, but a material's bytes do not
 * (`lib/utils/image-storage.ts` keeps them in the uploading device's
 * IndexedDB). On a device that never held them the pipeline used to be stuck:
 * byte extraction needs bytes. It now has a second way in — the derivation the
 * archive already holds for those bytes, which is what makes a restored
 * chapter generatable without re-uploading the file.
 *
 * ## Why it returns `null` instead of throwing
 *
 * The call sites differ in what a failure means, and only they can say it:
 * for a chapter with bytes, an archive miss is irrelevant (the parse runs); for
 * a chapter without them, an archive miss is the end of the road and has to
 * reach the user as an actionable error. Returning `null` for "nothing came
 * back" lets the caller decide, and keeps a network fault from surfacing as a
 * raw `TypeError` in a code path whose whole job is to recover from missing
 * data. The distinction that matters — no archive here vs. archive down — is
 * logged here, where the status and error code are still in hand.
 *
 * The response body is narrowed field by field rather than trusted: it crosses
 * a network boundary and is written by whatever version of the server wrote it
 * last, and a malformed body must degrade to "nothing came back", never to a
 * half-built extraction the bundle would try to render.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('ExtractionArchiveClient');

/** One image as the extraction response carries it (`ParsedPdfContent.metadata.pdfImages`). */
export interface ParsedDocumentResponseImage {
  id: string;
  src?: string;
  pageNumber?: number;
  description?: string;
  width?: number;
  height?: number;
}

/**
 * What a caller gets back: the same fields the generation pipeline reads off a
 * live `/api/extract-document` response, and nothing it does not.
 */
export interface ArchivedExtraction {
  text: string;
  images?: string[];
  metadata?: {
    pageCount?: number;
    pdfImages?: ParsedDocumentResponseImage[];
    /**
     * Names the derivation that answered. Present on every archived response
     * (and on a live cache hit), so a caller can see — and log — that the text
     * came from the archive, and which extractor produced it.
     */
    extractionCache?: {
      digest: string;
      extractorId: string;
      extractorVersion: string;
      hit: boolean;
    };
  };
}

function readImage(value: unknown): ParsedDocumentResponseImage | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string') return null;
  return {
    id: entry.id,
    ...(typeof entry.src === 'string' ? { src: entry.src } : {}),
    ...(typeof entry.pageNumber === 'number' && Number.isFinite(entry.pageNumber)
      ? { pageNumber: entry.pageNumber }
      : {}),
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    ...(typeof entry.width === 'number' && Number.isFinite(entry.width)
      ? { width: entry.width }
      : {}),
    ...(typeof entry.height === 'number' && Number.isFinite(entry.height)
      ? { height: entry.height }
      : {}),
  };
}

/**
 * Narrow a response body to {@link ArchivedExtraction}, or `null`.
 *
 * Exported because the streamed extraction response carries the same body
 * shape by construction — its final record *is* the body this route's
 * single-body form would have returned — so the two clients must not grow two
 * independent narrowing rules that drift apart.
 */
export function readArchivedExtraction(value: unknown): ArchivedExtraction | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as Record<string, unknown>;
  if (body.success !== true) return null;
  const data = body.data;
  if (typeof data !== 'object' || data === null) return null;
  const { text, images, metadata } = data as Record<string, unknown>;
  if (typeof text !== 'string') return null;

  const rawImages = Array.isArray(images)
    ? images.filter((src): src is string => typeof src === 'string')
    : undefined;

  let readMetadata: ArchivedExtraction['metadata'];
  if (typeof metadata === 'object' && metadata !== null) {
    const { pageCount, pdfImages, extractionCache } = metadata as Record<string, unknown>;
    const cached =
      typeof extractionCache === 'object' && extractionCache !== null
        ? (extractionCache as Record<string, unknown>)
        : null;
    readMetadata = {
      ...(typeof pageCount === 'number' && Number.isFinite(pageCount) ? { pageCount } : {}),
      ...(Array.isArray(pdfImages)
        ? {
            pdfImages: pdfImages
              .map(readImage)
              .filter((image): image is ParsedDocumentResponseImage => image !== null),
          }
        : {}),
      ...(cached &&
      typeof cached.digest === 'string' &&
      typeof cached.extractorId === 'string' &&
      typeof cached.extractorVersion === 'string'
        ? {
            extractionCache: {
              digest: cached.digest,
              extractorId: cached.extractorId,
              extractorVersion: cached.extractorVersion,
              hit: cached.hit === true,
            },
          }
        : {}),
    };
  }

  return {
    text,
    ...(rawImages ? { images: rawImages } : {}),
    ...(readMetadata ? { metadata: readMetadata } : {}),
  };
}

/**
 * Read the archived extraction of `contentDigest`, preferring `extractorId`
 * when the server holds one (see `selectArchivedExtraction` for the fallback).
 * `null` means nothing came back — no archive on this deployment, no row for
 * these bytes, or a request that failed.
 */
export async function fetchArchivedExtraction(input: {
  contentDigest: string;
  extractorId?: string;
  signal?: AbortSignal;
}): Promise<ArchivedExtraction | null> {
  const params = new URLSearchParams({ digest: input.contentDigest });
  if (input.extractorId) params.set('extractor', input.extractorId);
  let response: Response;
  try {
    response = await fetch(`/api/material-extraction?${params.toString()}`, {
      signal: input.signal,
    });
  } catch (error) {
    // An aborted generation reaches here too: the caller's own cancel handling
    // owns that case, and this read has nothing to add to it.
    if (input.signal?.aborted) return null;
    log.warn(
      `Could not reach the extraction archive for digest ${input.contentDigest.slice(0, 12)}…:`,
      error,
    );
    return null;
  }
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { reason?: unknown } | null;
    const reason = typeof failure?.reason === 'string' ? failure.reason : `HTTP ${response.status}`;
    // `NOT_ARCHIVED` is the ordinary answer for a chapter whose bytes were
    // parsed on a deployment that had no archive at the time; anything else is
    // worth a louder line.
    if (reason === 'NOT_ARCHIVED') {
      log.debug(`No archived extraction for digest ${input.contentDigest.slice(0, 12)}…`);
    } else {
      log.warn(
        `The extraction archive did not answer for digest ${input.contentDigest.slice(0, 12)}…: ${reason}`,
      );
    }
    return null;
  }
  const parsed = readArchivedExtraction(await response.json().catch(() => null));
  if (!parsed) {
    log.warn(
      `The extraction archive returned an unreadable body for ${input.contentDigest.slice(0, 12)}…`,
    );
  }
  return parsed;
}

/**
 * Whether the archive already holds *usable* text for these bytes, so that a
 * caller deciding "do I need to run extraction at all?" can answer without
 * paying for one.
 *
 * Two things make this stricter than "the request succeeded", and both are
 * needed by the caller — the home page deciding whether a re-uploaded material
 * still needs extracting before it opens the classroom that material belongs
 * to:
 *
 * - **`200` is not "has text".** The server serves a named extractor's row
 *   without judging its text, so a parser that returned nothing — a scanned
 *   PDF through a text-only parser yields a single space — answers `200`. Only
 *   the content can say whether there is anything to generate from, which is
 *   why this reads `text` rather than the status.
 * - **A fallback is not the caller's extractor.** A miss on the named extractor
 *   falls back to the newest *non-empty* derivation (`selectArchivedExtraction`),
 *   so a `200` can carry another parser's output. A caller that asked for the
 *   extractor it has selected wants that parser to have run; otherwise it
 *   would call these bytes "already parsed" on the strength of the very
 *   derivation it was trying to replace. The response names the extractor that
 *   answered (`metadata.extractionCache.extractorId`), so the match is
 *   checkable — and only a response naming a *different* extractor is refused,
 *   so a server that omits the name degrades to trusting the text.
 */
export async function hasUsableArchivedExtraction(input: {
  contentDigest: string;
  extractorId?: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const archived = await fetchArchivedExtraction(input);
  if (!archived || archived.text.trim().length === 0) return false;
  const answeredBy = archived.metadata?.extractionCache?.extractorId;
  return !(input.extractorId && answeredBy && answeredBy !== input.extractorId);
}
