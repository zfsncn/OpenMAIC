/**
 * Archive a successful extraction into the owner's derivation table
 * (`lib/persistence/material-extraction.ts`).
 *
 * ## Best-effort on purpose
 *
 * This is the only place that decides a failed archive is not a failed
 * extraction, and the decision is deliberate: the table is a cache and an
 * archive, and both are re-creatable from bytes the caller still holds. If a
 * database hiccup could turn a successful parse into a 500, the cache would
 * cost the user an upload instead of saving them a parse — strictly worse than
 * having no cache at all. So a write failure is logged and swallowed; the
 * extraction result is returned regardless.
 *
 * The alternative (fail the request) was rejected, not deferred: there is no
 * caller for whom "the material could not be read because the archive was
 * unavailable" is a better answer than "the material was read".
 *
 * ## What is stored
 *
 * Whatever the extractor produced, without interpretation of the text: the
 * text, the images, and the identity of the run. Image BYTES are moved out of
 * the row into the content-addressed `material_image_blob` layer (see
 * `lib/persistence/material-image-blob.ts`) and the row keeps each image's
 * sha256, so a figure shared by two chapters is stored once and the row stays
 * small. The response shape is unchanged: the reader rehydrates a data URL
 * from the stored bytes, so a client cannot tell an archived extraction from a
 * live one.
 *
 * The markdown's relative image links are NOT rewritten here — that happens at
 * the extractor, so the live and the archived text
 * are byte-identical and a link that names `img_1` names the same image on
 * either path.
 */
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { readMaterialImageBlobs } from '@/lib/persistence/material-image-blob';
import {
  readMaterialExtraction,
  writeMaterialExtraction,
  type MaterialExtractionImage,
  type MaterialExtractionImageInput,
  type MaterialExtractionRecord,
} from '@/lib/persistence/material-extraction';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import type { ParsedPdfContent } from '@/lib/types/pdf';

const log = createLogger('ExtractionArchive');

export interface ArchiveExtractionInput {
  ownerId: string;
  /** SHA-256 (hex) of the original file bytes. */
  contentDigest: string;
  /** The extractor that actually ran — the resolved provider, not the request's hint. */
  extractorId: string;
  extractorVersion: string;
  byteSize: number;
  fileName?: string;
  mimeType?: string;
  result: ParsedPdfContent;
}

/**
 * The images to archive, normalized to one shape.
 *
 * `metadata.pdfImages` is the authoritative array — it is what the response
 * sends and what the client rebuilds `PdfImage`s from. Only when it is absent
 * (a provider that returned bare `images: string[]`) do those strings stand in
 * for it, numbered the way the bundle numbers them.
 */
export function archivedImagesOf(result: ParsedPdfContent): MaterialExtractionImage[] {
  const pdfImages = result.metadata?.pdfImages;
  if (Array.isArray(pdfImages) && pdfImages.length > 0) {
    return pdfImages.map((image) => ({
      id: image.id,
      src: image.src,
      pageNumber: image.pageNumber,
      ...(image.description ? { description: image.description } : {}),
      ...(typeof image.width === 'number' ? { width: image.width } : {}),
      ...(typeof image.height === 'number' ? { height: image.height } : {}),
    }));
  }
  return result.images.map((src, index) => ({
    id: `img_${index + 1}`,
    src,
    pageNumber: 1,
  }));
}

/**
 * Decode a base64 data URL into its MIME type and raw bytes, or `null` when
 * the src is not a self-contained data URL (an http URL, a bare id, a
 * placeholder). Only a data URL can be stored in the byte layer: anything else
 * has no bytes here to hash.
 */
function decodeDataUrl(src: string): { mime: string; bytes: Buffer } | null {
  if (!src.startsWith('data:')) return null;
  const comma = src.indexOf(',');
  if (comma === -1) return null;
  const header = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  const [mime, ...params] = header.split(';');
  if (params.some((param) => param.trim().toLowerCase() === 'base64')) {
    try {
      return { mime: mime || 'application/octet-stream', bytes: Buffer.from(payload, 'base64') };
    } catch {
      return null;
    }
  }
  // A non-base64 data URL carries its payload URL-encoded.
  try {
    return {
      mime: mime || 'text/plain',
      bytes: Buffer.from(decodeURIComponent(payload), 'utf8'),
    };
  } catch {
    return null;
  }
}

/** Re-encode raw bytes as the base64 data URL the response carries. */
function encodeDataUrl(mime: string, bytes: Buffer): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * Turn the images an extractor produced into the form the archive stores:
 * images whose src is a data URL become raw bytes (the byte layer hashes and
 * deduplicates them), and anything else keeps its literal src so nothing is
 * silently lost. The row then holds a `contentHash` for the former and a `src`
 * for the latter.
 */
export function toStorageImages(
  images: readonly MaterialExtractionImage[],
): MaterialExtractionImageInput[] {
  return images.map((image) => {
    const meta = {
      id: image.id,
      pageNumber: image.pageNumber,
      ...(image.description ? { description: image.description } : {}),
      ...(typeof image.width === 'number' ? { width: image.width } : {}),
      ...(typeof image.height === 'number' ? { height: image.height } : {}),
    };
    const decoded = image.src ? decodeDataUrl(image.src) : null;
    if (decoded) return { ...meta, bytes: decoded.bytes, mime: decoded.mime };
    return { ...meta, ...(image.src ? { src: image.src } : {}) };
  });
}

/**
 * Rebuild the extraction response from an archived row.
 *
 * The shape is deliberately identical to what a live extraction returns — the
 * client cannot tell the two apart, which is the point: a cache that answered
 * a different shape would force every consumer to know whether it had hit.
 * `images` is the base64 list (the pre-`pdfImages` form the pipeline falls back
 * to) and `metadata.pdfImages` the authoritative array, exactly as
 * `documentArtifactToParsedPdfContent` builds them.
 *
 * `srcOf` rehydrates an image's data URL from its stored `contentHash`; a
 * missing entry yields an empty src, which every consumer already treats as
 * "no image here" (the vision selector filters on a truthy mapping value), so
 * an incomplete byte layer degrades instead of failing the read.
 *
 * `metadata.extractionCache` is the one addition: it names the derivation that
 * answered, so a hit is observable in the response and in a log rather than
 * being indistinguishable from a slow parse.
 */
export function archivedToParsedPdfContent(
  record: MaterialExtractionRecord,
  srcOf?: (image: MaterialExtractionImage) => string,
): ParsedPdfContent {
  const srcOfImage = (image: MaterialExtractionImage): string => {
    if (srcOf) return srcOf(image);
    return image.src ?? '';
  };
  return {
    text: record.text,
    images: record.images.map((image) => srcOfImage(image)),
    metadata: {
      ...(record.fileName ? { fileName: record.fileName } : {}),
      fileSize: record.byteSize,
      pageCount: record.pageCount ?? 0,
      parser: record.parser ?? record.extractorId,
      imageMapping: Object.fromEntries(record.images.map((image) => [image.id, srcOfImage(image)])),
      pdfImages: record.images.map((image) => ({
        id: image.id,
        src: srcOfImage(image),
        pageNumber: image.pageNumber,
        ...(image.description ? { description: image.description } : {}),
        ...(typeof image.width === 'number' ? { width: image.width } : {}),
        ...(typeof image.height === 'number' ? { height: image.height } : {}),
      })),
      extractionCache: {
        digest: record.contentDigest,
        extractorId: record.extractorId,
        extractorVersion: record.extractorVersion,
        hit: true,
      },
    },
  };
}

/**
 * Build the response for one archived derivation, reading any image bytes it
 * references from the byte layer first.
 *
 * Reads are best-effort per image: bytes the layer no longer holds yield an
 * empty src rather than a failed response, matching how the rest of the
 * archive degrades (a missing image is a smaller loss than a chapter that
 * cannot be generated from at all).
 */
export async function archivedRecordToResponse(
  queryable: Queryable,
  record: MaterialExtractionRecord,
): Promise<ParsedPdfContent> {
  const hashes = record.images
    .map((image) => image.contentHash)
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  if (hashes.length === 0) return archivedToParsedPdfContent(record);
  const blobs = await readMaterialImageBlobs(queryable, hashes);
  return archivedToParsedPdfContent(record, (image) => {
    if (image.src) return image.src;
    if (!image.contentHash) return '';
    const blob = blobs.get(image.contentHash);
    return blob ? encodeDataUrl(blob.mime, blob.bytes) : '';
  });
}

/**
 * Pick the derivation to answer a read with, out of everything archived for
 * one digest.
 *
 * The requested extractor wins when it is present: a caller that named one is
 * describing the derivation it wants, and answering with another parser's
 * output would silently change the text under a name that promised otherwise.
 *
 * A miss falls back to the newest derivation whose text is non-empty, because
 * the whole point of the archive is the case where the bytes are gone: on a
 * device that never had them, the extractor named by *today's* settings is
 * frequently not the one that ran when the material was uploaded (`settings`
 * lives in device-local storage, so a new device starts from defaults). The
 * fallback is what makes a restored chapter generatable instead of merely
 * visible. Empty text is excluded from it on purpose: a parser that returned
 * nothing is a strictly worse answer than no answer, and serving it would
 * build a course out of an empty chapter rather than report that the file has
 * to be uploaded again.
 *
 * `records` is expected newest-first (as `listMaterialExtractionsByDigest`
 * returns it), so "newest" is simply the first match and no version ordering
 * is needed on top of it.
 */
export function selectArchivedExtraction(
  records: readonly MaterialExtractionRecord[],
  requestedExtractorId: string | undefined,
): MaterialExtractionRecord | null {
  if (requestedExtractorId) {
    const exact = records.find((record) => record.extractorId === requestedExtractorId);
    if (exact) return exact;
  }
  return records.find((record) => record.text.trim().length > 0) ?? null;
}

/**
 * Read the derivation for one (owner, bytes, extractor) and build its response,
 * or `null` when there is none.
 *
 * Best-effort like the write, and for the same reason: a cache that cannot be
 * read must fall through to the parse, not fail the request. There is no
 * "cache unavailable" answer the user could act on.
 *
 * The response is built here rather than returned as a bare record because the
 * record's images are hashes into the byte layer, and only a queryable can turn
 * a hash back into the data URL the caller expects. Doing it inside keeps the
 * two reads — row and bytes — behind one best-effort boundary, so a byte-layer
 * failure degrades to an image without bytes rather than to a cache miss.
 *
 * A deployment without `DATABASE_URL` has no archive, so it never hits — which
 * is exactly the old behavior.
 */
export async function readArchivedExtractionResponseBestEffort(input: {
  ownerId: string;
  contentDigest: string;
  extractorId: string;
  extractorVersion: string;
}): Promise<ParsedPdfContent | null> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  try {
    const provider = await getServerPersistenceProvider(connectionString);
    const record = await readMaterialExtraction(provider.pool, input);
    if (!record) return null;
    return await archivedRecordToResponse(provider.pool, record);
  } catch (error) {
    log.warn(
      `Could not read the extraction archive (extractor=${input.extractorId}@${input.extractorVersion}, ` +
        `digest=${input.contentDigest.slice(0, 12)}…); parsing instead:`,
      error,
    );
    return null;
  }
}

/**
 * Store one extraction, or log why it could not be stored. Never throws — see
 * the module note: the caller is an extraction that already succeeded.
 *
 * A deployment without `DATABASE_URL` has no archive and says nothing: the
 * absence of a database is a configuration, not a failure of this request.
 */
export async function archiveExtractionBestEffort(input: ArchiveExtractionInput): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return;
  try {
    const provider = await getServerPersistenceProvider(connectionString);
    const written = await writeMaterialExtraction(
      provider.pool as unknown as ConnectableQueryable,
      {
        ownerId: input.ownerId,
        contentDigest: input.contentDigest,
        extractorId: input.extractorId,
        extractorVersion: input.extractorVersion,
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize,
        parser: input.result.metadata?.parser ?? null,
        pageCount: input.result.metadata?.pageCount ?? null,
        text: input.result.text,
        images: toStorageImages(archivedImagesOf(input.result)),
      },
    );
    log.debug(
      `Archived extraction (extractor=${input.extractorId}@${input.extractorVersion}, ` +
        `digest=${input.contentDigest.slice(0, 12)}…, ${input.result.text.length} chars, ` +
        `${written.imageCount} images${written.imagesTruncated ? ', images truncated' : ''})`,
    );
  } catch (error) {
    // Swallowed by design: see the module header. The extraction result is
    // unaffected, and the next extraction of these bytes simply retries.
    log.warn(
      `Could not archive the extraction of "${input.fileName ?? 'document'}" ` +
        `(extractor=${input.extractorId}@${input.extractorVersion}):`,
      error,
    );
  }
}
