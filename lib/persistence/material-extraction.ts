/**
 * Owner-scoped archive of course-material extraction output — the durable half
 * of RFC #1153's derivation cache (the `lib/document/extraction-cache.ts` the
 * extractor manifest and `contentDigest` comments already point at).
 *
 * ## Why a table of its own
 *
 * The extraction of a course material is a pure function of its bytes and of
 * the extractor that ran. Both halves already exist as values the pipeline
 * computes — the bytes are hashed at the route, and every extractor declares a
 * `version` whose comment says to bump it "whenever output shape or quality
 * changes" — but nothing stored the result, so the same chapter re-extracted
 * on another device paid the full parse again and the parsed markdown was lost
 * the moment the tab closed.
 *
 * This table keeps that output: one row per (owner, content digest, extractor
 * id, extractor version). The composite primary key IS the design:
 *
 * - **Same bytes, same extractor** collide on one row, so a re-extraction
 *   updates in place instead of accumulating duplicates.
 * - **Same bytes, different extractor** land on different rows, so switching a
 *   material from one extractor to another keeps both results side by side rather
 *   than overwriting the one the user already had. That is what the key is
 *   for — the alternative (keying on the material's id) would lose the old
 *   result on every parser change, and the alternative (keying on the owner
 *   and the digest alone) would make two parsers fight over one row.
 *
 * It is deliberately NOT `app_kv`: that store's contract is sized for small
 * configuration values and its listing is unpaginated, and it is NOT the asset
 * pool: rows there are claimed by a live document through
 * `document_asset_refs.stage_id`, but a material is extracted *before* any
 * course exists, so an unreferenced pool entry would be reclaimed by the
 * collector — the archive would quietly empty itself.
 *
 * ## Writes are best-effort at the call site
 *
 * Nothing here swallows errors: the caller decides. The extraction route wraps
 * the write so a database hiccup leaves a successful parse successful (see
 * `lib/document/extraction-archive.ts`); a cache that can take the upload path
 * down with it costs far more than the parse it saves.
 *
 * Writes take the owner's identity lock first ({@link fenceOwnerWrite}), like
 * every other owner-keyed store, so a write racing a claim either lands before
 * it (and is moved) or is refused — never left under a retired id.
 */
import { createHash } from 'node:crypto';

import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';

import { createLogger } from '@/lib/logger';

import {
  pruneMaterialImageBlobs,
  writeMaterialImageBlobs,
  type MaterialImageBlobInput,
} from './material-image-blob';
import { fenceOwnerWrite } from './owner-merges';

const log = createLogger('MaterialExtraction');

/**
 * Rows kept per owner, newest first. An archive that grows without bound is
 * not an archive; older derivations are re-creatable from the same bytes, so
 * the oldest are the ones to drop when the cap is reached. Generous enough
 * that a normal library never prunes.
 */
export const MAX_MATERIAL_EXTRACTION_ROWS_PER_OWNER = 1000;

/**
 * Ceiling on the image payload archived with one extraction, measured in RAW
 * bytes.
 *
 * Image bytes live in the deduped `material_image_blob` layer, not in the row
 * (see that module): a scan-heavy chapter would otherwise write tens of
 * megabytes of base64 into a JSONB column, and a figure shared between two
 * chapters would be stored twice. Above this bound the text is still archived
 * — the part the generation pipeline actually consumes — and the images are
 * dropped with a flag, so one material cannot fill the byte layer on its own.
 */
export const MAX_MATERIAL_EXTRACTION_IMAGE_BYTES = 24 * 1024 * 1024;

export const MATERIAL_EXTRACTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS material_extraction (
  owner_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  extractor_id TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  byte_size DOUBLE PRECISION NOT NULL,
  parser TEXT,
  page_count INTEGER,
  text TEXT NOT NULL,
  images JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_count INTEGER NOT NULL DEFAULT 0,
  images_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, content_digest, extractor_id, extractor_version)
);

CREATE INDEX IF NOT EXISTS material_extraction_owner_updated_idx
  ON material_extraction (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS material_extraction_owner_digest_idx
  ON material_extraction (owner_id, content_digest);
`;

export async function ensureMaterialExtractionSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(MATERIAL_EXTRACTION_SCHEMA)) {
    await queryable.query(statement);
  }
}

/**
 * One archived image, in the shape the extraction response already carries
 * (`ParsedPdfContent.metadata.pdfImages`, i.e. `PdfImage` minus the
 * bundle-level fields the archive has no use for).
 *
 * The bytes are addressed one of two ways:
 *
 * - `contentHash` (the current shape) names a row in `material_image_blob`,
 *   where the raw bytes live deduplicated by sha256. The reader rehydrates a
 *   data URL from it, so the response the client sees is unchanged.
 * - `src` (the legacy shape) is a verbatim base64 data URL, written before the
 *   byte layer existed. Rows are read, not rewritten, so a row written by an
 *   older deployment keeps working; it is simply not deduplicated.
 *
 * Exactly one is present; both are optional in the type because a row is
 * whatever version of the app wrote it last.
 */
export interface MaterialExtractionImage {
  id: string;
  pageNumber: number;
  description?: string;
  width?: number;
  height?: number;
  /** Hash of the raw bytes in `material_image_blob`; the current shape. */
  contentHash?: string;
  /** Verbatim data URL; the pre-byte-layer shape. */
  src?: string;
}

/**
 * An image on its way INTO the archive: the metadata plus either raw bytes (to
 * be hashed and stored in the byte layer) or a verbatim src for an image with
 * no stored bytes (a non-data URL, which the byte layer cannot address).
 */
export interface MaterialExtractionImageInput {
  id: string;
  pageNumber: number;
  description?: string;
  width?: number;
  height?: number;
  /** Raw bytes to store, deduplicated across every material. */
  bytes?: Uint8Array;
  /** MIME for `bytes`; required when `bytes` is present. */
  mime?: string;
  /** Verbatim src for an image that has no bytes to store. */
  src?: string;
}

export interface MaterialExtractionRecord {
  ownerId: string;
  contentDigest: string;
  extractorId: string;
  extractorVersion: string;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number;
  /** The parser the extraction reported, when it reported one. */
  parser: string | null;
  pageCount: number | null;
  text: string;
  images: MaterialExtractionImage[];
  imageCount: number;
  imagesTruncated: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface WriteMaterialExtractionInput {
  ownerId: string;
  contentDigest: string;
  extractorId: string;
  extractorVersion: string;
  fileName?: string | null;
  mimeType?: string | null;
  byteSize: number;
  parser?: string | null;
  pageCount?: number | null;
  text: string;
  images: readonly MaterialExtractionImageInput[];
}

/** What the write decided about the images, so the caller can log it. */
export interface WriteMaterialExtractionResult {
  imageCount: number;
  imagesTruncated: boolean;
}

interface RawMaterialExtractionRow extends Record<string, unknown> {
  owner_id: string;
  content_digest: string;
  extractor_id: string;
  extractor_version: string;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | string;
  parser: string | null;
  page_count: number | string | null;
  text: string;
  images: unknown;
  image_count: number | string;
  images_truncated: boolean;
  created_at: number | string;
  updated_at: number | string;
}

const MATERIAL_EXTRACTION_COLUMNS = `owner_id,
  content_digest,
  extractor_id,
  extractor_version,
  file_name,
  mime_type,
  byte_size,
  parser,
  page_count,
  text,
  images,
  image_count,
  images_truncated,
  created_at,
  updated_at`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow a stored image to the archived shape, or drop it. A row is written by
 * whatever version of the app wrote it last, so a malformed entry degrades to
 * "not archived" rather than reaching a consumer as a half-built image.
 *
 * An entry is kept when it names bytes either way — a `contentHash` into the
 * byte layer, or a verbatim `src`. An entry with neither cannot become an
 * image and is dropped.
 */
function readImage(value: unknown): MaterialExtractionImage | null {
  if (!isRecord(value)) return null;
  const { id, src, contentHash, pageNumber, description, width, height } = value;
  if (typeof id !== 'string') return null;
  const hasHash = typeof contentHash === 'string' && contentHash.length > 0;
  const hasSrc = typeof src === 'string' && src.length > 0;
  if (!hasHash && !hasSrc) return null;
  const page = typeof pageNumber === 'number' && Number.isFinite(pageNumber) ? pageNumber : 0;
  return {
    id,
    pageNumber: page,
    ...(hasHash ? { contentHash } : {}),
    ...(!hasHash && hasSrc ? { src } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof width === 'number' && Number.isFinite(width) ? { width } : {}),
    ...(typeof height === 'number' && Number.isFinite(height) ? { height } : {}),
  };
}

function rowToRecord(row: RawMaterialExtractionRow): MaterialExtractionRecord {
  const rawImages = Array.isArray(row.images) ? row.images : [];
  return {
    ownerId: row.owner_id,
    contentDigest: row.content_digest,
    extractorId: row.extractor_id,
    extractorVersion: row.extractor_version,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    parser: row.parser,
    pageCount: row.page_count === null ? null : Number(row.page_count),
    text: row.text,
    images: rawImages
      .map(readImage)
      .filter((image): image is MaterialExtractionImage => image !== null),
    imageCount: Number(row.image_count),
    imagesTruncated: row.images_truncated === true,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Split the incoming images into what the row stores and what the byte layer
 * stores, keeping the total RAW payload under
 * {@link MAX_MATERIAL_EXTRACTION_IMAGE_BYTES}.
 *
 * The bound is applied on raw bytes rather than on the encoded src because the
 * raw bytes are what the byte layer holds; an image with no bytes (a verbatim
 * src) is measured by its src length, which is all it costs. Images past the
 * bound are dropped together with everything after them, and the flag travels
 * with the row so a consumer can tell "no images" from "images not archived".
 *
 * An image carried by bytes is stored as a `contentHash` entry and its bytes
 * are handed to the byte layer; an image with only a src keeps the src. An
 * image with neither has nothing to store and is skipped — the extractor
 * produced a placeholder, and an empty entry would only cost a row slot.
 */
function boundedImages(images: readonly MaterialExtractionImageInput[]): {
  entries: MaterialExtractionImage[];
  blobs: MaterialImageBlobInput[];
  truncated: boolean;
} {
  const entries: MaterialExtractionImage[] = [];
  const blobs: MaterialImageBlobInput[] = [];
  const seenHashes = new Set<string>();
  let total = 0;
  for (const image of images) {
    const bytes = image.bytes;
    const byteSize = bytes ? bytes.byteLength : Buffer.byteLength(image.src ?? '', 'utf8');
    if (!bytes && !image.src) continue;
    if (total + byteSize > MAX_MATERIAL_EXTRACTION_IMAGE_BYTES) {
      return { entries, blobs, truncated: true };
    }
    total += byteSize;
    const meta = {
      id: image.id,
      pageNumber: image.pageNumber,
      ...(image.description ? { description: image.description } : {}),
      ...(typeof image.width === 'number' ? { width: image.width } : {}),
      ...(typeof image.height === 'number' ? { height: image.height } : {}),
    };
    if (bytes) {
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      entries.push({ ...meta, contentHash });
      // The same bytes twice in one extraction store one blob.
      if (!seenHashes.has(contentHash)) {
        seenHashes.add(contentHash);
        blobs.push({ contentHash, mime: image.mime ?? 'application/octet-stream', bytes });
      }
    } else {
      entries.push({ ...meta, src: image.src as string });
    }
  }
  return { entries, blobs, truncated: false };
}

export interface WriteMaterialExtractionOptions {
  /**
   * Override the per-owner row ceiling. Defaults to
   * {@link MAX_MATERIAL_EXTRACTION_ROWS_PER_OWNER}; a caller with its own
   * retention policy (or a test that would otherwise have to write a thousand
   * rows to see the prune) can set it here.
   */
  maxRowsPerOwner?: number;
}

/**
 * Archive one extraction. Idempotent by construction: the same (owner, bytes,
 * extractor) writes the same row, so a re-extraction refreshes it in place.
 *
 * Runs in one transaction that takes the owner's identity lock first, then
 * upserts and prunes. The prune is what keeps {@link
 * MAX_MATERIAL_EXTRACTION_ROWS_PER_OWNER} honest; it runs in the same
 * transaction as the insert so a concurrent pair of writes cannot both decide
 * the table is over the cap and both prune.
 */
export async function writeMaterialExtraction(
  queryable: ConnectableQueryable,
  input: WriteMaterialExtractionInput,
  options?: WriteMaterialExtractionOptions,
): Promise<WriteMaterialExtractionResult> {
  const bounded = boundedImages(input.images);
  const maxRows = options?.maxRowsPerOwner ?? MAX_MATERIAL_EXTRACTION_ROWS_PER_OWNER;
  const now = Date.now();
  const withTransaction = nodePostgresTransaction(queryable);
  await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, input.ownerId);
    // Bytes before the entry that names them, the same order the asset
    // registry uses: a row must never point at a blob that was not stored.
    // Deduplication happens here, on the content hash, so a figure shared by
    // two chapters is written once.
    if (bounded.blobs.length > 0) {
      await writeMaterialImageBlobs(tx, bounded.blobs, now);
    }
    await tx.query(
      `INSERT INTO material_extraction
         (owner_id, content_digest, extractor_id, extractor_version,
          file_name, mime_type, byte_size, parser, page_count, text,
          images, image_count, images_truncated, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $14)
       ON CONFLICT (owner_id, content_digest, extractor_id, extractor_version)
       DO UPDATE SET
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         byte_size = EXCLUDED.byte_size,
         parser = EXCLUDED.parser,
         page_count = EXCLUDED.page_count,
         text = EXCLUDED.text,
         images = EXCLUDED.images,
         image_count = EXCLUDED.image_count,
         images_truncated = EXCLUDED.images_truncated,
         updated_at = EXCLUDED.updated_at`,
      [
        input.ownerId,
        input.contentDigest,
        input.extractorId,
        input.extractorVersion,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.byteSize,
        input.parser ?? null,
        input.pageCount ?? null,
        input.text,
        encodeJson(bounded.entries, 'material extraction images'),
        bounded.entries.length,
        bounded.truncated,
        now,
      ],
    );
    await tx.query(
      `DELETE FROM material_extraction
        WHERE owner_id = $1
          AND (content_digest, extractor_id, extractor_version) NOT IN (
            SELECT content_digest, extractor_id, extractor_version
              FROM material_extraction
             WHERE owner_id = $1
             ORDER BY updated_at DESC
             LIMIT $2
          )`,
      [input.ownerId, maxRows],
    );
  });
  // Reclaim abandoned image bytes. Deliberately OUTSIDE the transaction and
  // best-effort: it is housekeeping, not part of the archive write, and a
  // failure here must not undo a row that was stored correctly. It only ever
  // deletes blobs no row references (see pruneMaterialImageBlobs), so a missed
  // pass costs disk and never an image.
  if (bounded.blobs.length > 0) {
    try {
      await pruneMaterialImageBlobs(queryable as unknown as Queryable, { now });
    } catch (error) {
      log.warn('Could not reclaim abandoned material image blobs:', error);
    }
  }
  return { imageCount: bounded.entries.length, imagesTruncated: bounded.truncated };
}

/**
 * Read one derivation, or `null` when this owner holds no row for it. The
 * exact key is an exact answer: a miss is a miss, never a row for a different
 * extractor that happened to share the bytes.
 */
export async function readMaterialExtraction(
  queryable: Queryable,
  key: {
    ownerId: string;
    contentDigest: string;
    extractorId: string;
    extractorVersion: string;
  },
): Promise<MaterialExtractionRecord | null> {
  const result = await queryable.query<RawMaterialExtractionRow>(
    `SELECT ${MATERIAL_EXTRACTION_COLUMNS}
       FROM material_extraction
      WHERE owner_id = $1
        AND content_digest = $2
        AND extractor_id = $3
        AND extractor_version = $4`,
    [key.ownerId, key.contentDigest, key.extractorId, key.extractorVersion],
  );
  const row = result.rows[0];
  return row ? rowToRecord(row) : null;
}

/**
 * Every derivation this owner holds for one digest, newest first — the read
 * behind "same PDF, several parsers" when the caller wants to show what is
 * available without naming an extractor up front.
 */
export async function listMaterialExtractionsByDigest(
  queryable: Queryable,
  ownerId: string,
  contentDigest: string,
): Promise<MaterialExtractionRecord[]> {
  const result = await queryable.query<RawMaterialExtractionRow>(
    `SELECT ${MATERIAL_EXTRACTION_COLUMNS}
       FROM material_extraction
      WHERE owner_id = $1 AND content_digest = $2
      ORDER BY updated_at DESC`,
    [ownerId, contentDigest],
  );
  return result.rows.map(rowToRecord);
}
