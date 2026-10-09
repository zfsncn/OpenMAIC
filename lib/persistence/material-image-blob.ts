/**
 * Content-addressed byte layer for course-material extraction images.
 *
 * ## Why this exists, and why it is not the asset pool
 *
 * P0/P1 archived an extraction's images inline, as base64 data URLs inside the
 * `material_extraction.images` JSONB column. That made the row as large as the
 * chapter's scans (hence the 24 MB inline cap) and made two chapters that share
 * a figure pay for it twice. This table moves the bytes out: the archive row
 * keeps only `sha256(bytes)` per image, and identical images collapse to one
 * row wherever they appear — the same figure in two chapters, or the same
 * chapter re-archived under a different extractor.
 *
 * It is deliberately NOT `asset_blobs`. That table is only reachable through
 * `asset_entries`, whose rows are claimed by a live document
 * (`document_asset_refs`); the offline collector reclaims any entry no document
 * names. A material is extracted *before* any course exists, so a material
 * image parked in the pool would be reclaimed and the archive would quietly
 * lose its images. This layer is owner-independent by construction and is
 * reclaimed only by {@link pruneMaterialImageBlobs}, which checks references
 * itself.
 *
 * ## Cost, stated plainly
 *
 * A second copy of every image the archive holds, no longer deduplicated by
 * anything the document store already did. That is the accepted price of
 * "small rows, one copy per distinct image"; the prune below is what keeps it
 * from growing without bound.
 *
 * ## Reclamation is reference-checked, never heuristic
 *
 * {@link pruneMaterialImageBlobs} deletes a blob only when BOTH hold: it has
 * not been touched for {@link MATERIAL_IMAGE_BLOB_TTL_MS}, AND no
 * `material_extraction` row references its hash. The reference check is what
 * makes the TTL safe — a blob a live row still points at is never a candidate,
 * however old the touch — and the TTL is what bounds the check: candidates are
 * blobs nobody has re-archived in a month, which in a steady state is none.
 * Deleting a referenced blob would silently drop an image from a chapter that
 * can no longer be re-uploaded (the whole point of the archive), so the check
 * errs toward keeping.
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';

const log = createLogger('MaterialImageBlob');

/**
 * How long a blob must have gone untouched before it is even a candidate for
 * reclamation. Long on purpose: re-archiving the same material refreshes the
 * touch, so a month of silence means the owning derivations are gone rather
 * than merely idle, and a generous window costs only disk.
 */
export const MATERIAL_IMAGE_BLOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many candidates one prune pass may consider. The reference check is a
 * containment probe per candidate, so the bound keeps a write that happens to
 * trigger a prune from scanning an unbounded set; a backlog drains over
 * successive writes rather than in one.
 */
export const MATERIAL_IMAGE_BLOB_PRUNE_LIMIT = 500;

export const MATERIAL_IMAGE_BLOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS material_image_blob (
  content_hash TEXT PRIMARY KEY,
  byte_size BIGINT NOT NULL,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  last_seen_at DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS material_image_blob_last_seen_idx
  ON material_image_blob (last_seen_at);
`;

export async function ensureMaterialImageBlobSchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(MATERIAL_IMAGE_BLOB_SCHEMA)) {
    await queryable.query(statement);
  }
}

/** One image's bytes on their way into the layer. */
export interface MaterialImageBlobInput {
  /** Lowercase hex sha256 of the raw bytes. */
  contentHash: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * Upsert a batch of images, deduplicated by content hash.
 *
 * `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: a re-archive of the same
 * bytes must refresh `last_seen_at` so the prune does not treat a still-live
 * blob as abandoned. The stored `bytes` are rewritten too — same hash means
 * same bytes, so the write is a no-op in content and simply keeps the row
 * correct if a prior write had stored a partial value (it cannot, but the
 * statement does not have to assume that).
 */
export async function writeMaterialImageBlobs(
  queryable: Queryable,
  blobs: readonly MaterialImageBlobInput[],
  now: number,
): Promise<void> {
  for (const blob of blobs) {
    await queryable.query(
      `INSERT INTO material_image_blob (content_hash, byte_size, mime, bytes, created_at, last_seen_at)
       VALUES ($1, $2, $3, $4::bytea, $5, $5)
       ON CONFLICT (content_hash) DO UPDATE
         SET byte_size = EXCLUDED.byte_size,
             mime = EXCLUDED.mime,
             bytes = EXCLUDED.bytes,
             last_seen_at = EXCLUDED.last_seen_at`,
      [blob.contentHash, blob.bytes.byteLength, blob.mime, Buffer.from(blob.bytes), now],
    );
  }
}

/** A blob as read back, with bytes normalized to a Node `Buffer`. */
export interface MaterialImageBlob {
  mime: string;
  bytes: Buffer;
}

interface RawBlobRow extends Record<string, unknown> {
  content_hash: string;
  mime: string;
  bytes: unknown;
}

/** Normalize a driver's bytea value (Buffer or Uint8Array) to a Buffer. */
function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  // PGlite can hand back an `{ data: [...] }`-shaped value for bytea in some
  // builds; accept it rather than dropping an image the archive holds.
  if (value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data);
  }
  return null;
}

/**
 * Read a batch of blobs by hash. Hashes with no row are simply absent from the
 * map — the caller decides what a missing image means (an incomplete archive
 * degrades to an image without bytes, not to a failed read).
 */
export async function readMaterialImageBlobs(
  queryable: Queryable,
  hashes: readonly string[],
): Promise<Map<string, MaterialImageBlob>> {
  const unique = [...new Set(hashes)].filter((hash) => hash.length > 0);
  const found = new Map<string, MaterialImageBlob>();
  if (unique.length === 0) return found;
  const result = await queryable.query<RawBlobRow>(
    `SELECT content_hash, mime, bytes
       FROM material_image_blob
      WHERE content_hash = ANY($1::text[])`,
    [unique],
  );
  for (const row of result.rows) {
    const bytes = toBuffer(row.bytes);
    if (bytes === null) continue;
    found.set(row.content_hash, { mime: row.mime, bytes });
  }
  return found;
}

export interface PruneMaterialImageBlobsOptions {
  /** Candidates untouched since before `now - this` are eligible. */
  ttlMs?: number;
  /** Ceiling on candidates considered in one pass. */
  limit?: number;
  /** Override "now" for tests. */
  now?: number;
}

/**
 * Delete blobs that are both abandoned and unreferenced. Returns how many were
 * deleted, so a caller can log it.
 *
 * Best-effort by design: a prune failure must never fail the archive write that
 * triggered it, so the caller wraps it -- see `writeMaterialExtraction`.
 */
export async function pruneMaterialImageBlobs(
  queryable: Queryable,
  options?: PruneMaterialImageBlobsOptions,
): Promise<number> {
  const ttlMs = options?.ttlMs ?? MATERIAL_IMAGE_BLOB_TTL_MS;
  const limit = options?.limit ?? MATERIAL_IMAGE_BLOB_PRUNE_LIMIT;
  const now = options?.now ?? Date.now();
  const cutoff = now - ttlMs;
  const result = await queryable.query<{ content_hash: string }>(
    `WITH candidates AS (
       SELECT content_hash
         FROM material_image_blob
        WHERE last_seen_at < $1
        ORDER BY last_seen_at ASC
        LIMIT $2
     )
     DELETE FROM material_image_blob AS blob
      WHERE blob.content_hash IN (SELECT content_hash FROM candidates)
        AND NOT EXISTS (
          SELECT 1 FROM material_extraction AS row
           WHERE row.images @> jsonb_build_array(jsonb_build_object('contentHash', blob.content_hash))
        )
      RETURNING blob.content_hash`,
    [cutoff, limit],
  );
  const deleted = result.rows.length;
  if (deleted > 0) log.debug(`Reclaimed ${deleted} abandoned material image blob(s).`);
  return deleted;
}
