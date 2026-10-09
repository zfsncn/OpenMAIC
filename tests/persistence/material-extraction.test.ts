import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import {
  ensureMaterialExtractionSchema,
  listMaterialExtractionsByDigest,
  MAX_MATERIAL_EXTRACTION_IMAGE_BYTES,
  readMaterialExtraction,
  writeMaterialExtraction,
  type WriteMaterialExtractionInput,
} from '@/lib/persistence/material-extraction';
import {
  ensureMaterialImageBlobSchema,
  pruneMaterialImageBlobs,
} from '@/lib/persistence/material-image-blob';
import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The node-postgres pool surface, backed by the single-connection PGlite. */
class PGlitePool {
  constructor(readonly db: PGlite) {}

  query<TRow>(text: string, params?: unknown[]) {
    return this.db.query<TRow>(text, params);
  }

  async connect() {
    return {
      query: <TRow>(text: string, params?: unknown[]) => this.db.query<TRow>(text, params),
      release() {},
    };
  }

  async end() {
    await this.db.close();
  }
}

const input = (
  overrides: Partial<WriteMaterialExtractionInput> = {},
): WriteMaterialExtractionInput => ({
  ownerId: 'owner-1',
  contentDigest: 'digest-a',
  extractorId: 'alidocmind',
  extractorVersion: '1',
  fileName: 'chapter-01.pdf',
  mimeType: 'application/pdf',
  byteSize: 1234,
  parser: 'alidocmind',
  pageCount: 12,
  text: '# Chapter 1\n\n![](images/fig-1.jpg)',
  images: [
    { id: 'img_1', src: 'data:image/png;base64,AAAA', pageNumber: 1, width: 10, height: 20 },
  ],
  ...overrides,
});

const key = (overrides: Partial<Parameters<typeof readMaterialExtraction>[1]> = {}) => ({
  ownerId: 'owner-1',
  contentDigest: 'digest-a',
  extractorId: 'alidocmind',
  extractorVersion: '1',
  ...overrides,
});

describe('material extraction archive', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    // The identity lock lives in the owner-merge schema, which every
    // owner-keyed write takes first; the real bootstrap installs both.
    await ensureOwnerMaterialSchema(db);
    await ensureMaterialExtractionSchema(db);
    await ensureMaterialImageBlobSchema(db);
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
  });

  it('round-trips one derivation, text and images included', async () => {
    const written = await writeMaterialExtraction(pool as unknown as ConnectableQueryable, input());
    expect(written).toEqual({ imageCount: 1, imagesTruncated: false });

    const record = await readMaterialExtraction(pool as unknown as ConnectableQueryable, key());
    expect(record).not.toBeNull();
    expect(record?.text).toBe('# Chapter 1\n\n![](images/fig-1.jpg)');
    expect(record?.images).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,AAAA', pageNumber: 1, width: 10, height: 20 },
    ]);
    expect(record?.fileName).toBe('chapter-01.pdf');
    expect(record?.byteSize).toBe(1234);
    expect(record?.pageCount).toBe(12);
    expect(record?.parser).toBe('alidocmind');
  });

  it('keeps one row per (owner, digest, extractor) when the same derivation is written twice', async () => {
    await writeMaterialExtraction(pool as unknown as ConnectableQueryable, input());
    await writeMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      input({ text: '# Chapter 1 (re-parsed)' }),
    );

    const rows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM material_extraction',
    );
    expect(rows.rows[0]?.count).toBe('1');
    const record = await readMaterialExtraction(pool as unknown as ConnectableQueryable, key());
    expect(record?.text).toBe('# Chapter 1 (re-parsed)');
  });

  it('keeps two rows when the same bytes were extracted by two different extractors', async () => {
    // Same PDF, same bytes, two parsers: the composite key is what lets the
    // second parse sit beside the first instead of replacing it.
    await writeMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      input({ text: '# Chapter 1 (AliDocMind)' }),
    );
    await writeMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      input({ extractorId: 'unpdf', text: '# Chapter 1 (unpdf)' }),
    );

    const both = await listMaterialExtractionsByDigest(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      'digest-a',
    );
    expect(both).toHaveLength(2);
    expect(new Set(both.map((row) => row.extractorId))).toEqual(new Set(['alidocmind', 'unpdf']));

    // A bumped extractor version is a third identity, for the same reason.
    await writeMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      input({ extractorVersion: '2' }),
    );
    const three = await listMaterialExtractionsByDigest(
      pool as unknown as ConnectableQueryable,
      'owner-1',
      'digest-a',
    );
    expect(three).toHaveLength(3);

    // The exact-key read still answers exactly one of them.
    const exact = await readMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      key({ extractorId: 'alidocmind' }),
    );
    expect(exact?.text).toBe('# Chapter 1 (AliDocMind)');
  });

  it("does not read another owner's derivation", async () => {
    await writeMaterialExtraction(pool as unknown as ConnectableQueryable, input());
    const other = await readMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      key({ ownerId: 'owner-2' }),
    );
    expect(other).toBeNull();
    const listed = await listMaterialExtractionsByDigest(
      pool as unknown as ConnectableQueryable,
      'owner-2',
      'digest-a',
    );
    expect(listed).toEqual([]);
  });

  it('archives the text but drops images past the payload bound', async () => {
    // One image a little over the cap: the text must survive, the images must
    // not, and the flag must say which of the two happened.
    const oversized = 'x'.repeat(MAX_MATERIAL_EXTRACTION_IMAGE_BYTES + 1);
    const written = await writeMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      input({
        contentDigest: 'digest-big',
        images: [
          { id: 'img_1', src: 'data:image/png;base64,AAAA', pageNumber: 1 },
          { id: 'img_2', src: oversized, pageNumber: 2 },
        ],
      }),
    );
    expect(written).toEqual({ imageCount: 1, imagesTruncated: true });

    const record = await readMaterialExtraction(
      pool as unknown as ConnectableQueryable,
      key({ contentDigest: 'digest-big' }),
    );
    expect(record?.text).toBe('# Chapter 1\n\n![](images/fig-1.jpg)');
    expect(record?.images.map((image) => image.id)).toEqual(['img_1']);
    expect(record?.imagesTruncated).toBe(true);
  });

  it('prunes the oldest derivations of one owner once the ceiling is reached', async () => {
    const queryable = pool as unknown as ConnectableQueryable;
    for (let index = 0; index < 4; index += 1) {
      await writeMaterialExtraction(
        queryable,
        input({ contentDigest: `digest-${index}`, text: `body ${index}` }),
        { maxRowsPerOwner: 2 },
      );
    }

    const remaining = await pool.query<{ content_digest: string }>(
      'SELECT content_digest FROM material_extraction ORDER BY updated_at DESC',
    );
    expect(remaining.rows.map((row) => row.content_digest).sort()).toEqual([
      'digest-2',
      'digest-3',
    ]);
    // The prune never crosses owners: another owner's rows are untouched.
    await writeMaterialExtraction(
      queryable,
      input({ ownerId: 'owner-2', contentDigest: 'digest-a' }),
      { maxRowsPerOwner: 1 },
    );
    await writeMaterialExtraction(
      queryable,
      input({ ownerId: 'owner-2', contentDigest: 'digest-z' }),
      { maxRowsPerOwner: 1 },
    );
    const ownerTwo = await pool.query<{ content_digest: string }>(
      "SELECT content_digest FROM material_extraction WHERE owner_id = 'owner-2'",
    );
    expect(ownerTwo.rows.map((row) => row.content_digest)).toEqual(['digest-z']);
  });
});

describe('material image byte layer', () => {
  let pool: PGlitePool;

  beforeEach(async () => {
    const db = new PGlite();
    await db.waitReady;
    await ensureOwnerMaterialSchema(db);
    await ensureMaterialExtractionSchema(db);
    await ensureMaterialImageBlobSchema(db);
    pool = new PGlitePool(db);
  });

  afterEach(async () => {
    await pool.end();
  });

  const queryable = () => pool as unknown as ConnectableQueryable;
  const blobCount = async (): Promise<string> => {
    const rows = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM material_image_blob',
    );
    return rows.rows[0]?.count ?? '';
  };

  it('keeps only the hash in the row and the bytes in the byte layer', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const written = await writeMaterialExtraction(
      queryable(),
      input({ images: [{ id: 'img_1', pageNumber: 1, bytes, mime: 'image/png' }] }),
    );
    expect(written).toEqual({ imageCount: 1, imagesTruncated: false });

    const record = await readMaterialExtraction(queryable(), key());
    // The row no longer carries base64; it carries the address of the bytes.
    expect(record?.images).toEqual([{ id: 'img_1', pageNumber: 1, contentHash: sha256(bytes) }]);

    const stored = await pool.query<{ mime: string; byte_size: string }>(
      'SELECT mime, byte_size::text AS byte_size FROM material_image_blob',
    );
    expect(stored.rows).toEqual([{ mime: 'image/png', byte_size: '4' }]);
  });

  it('stores one blob when two derivations share the same image bytes', async () => {
    const bytes = Buffer.from([9, 9, 9]);
    const image = [{ id: 'img_1', pageNumber: 1, bytes, mime: 'image/png' }];
    await writeMaterialExtraction(queryable(), input({ contentDigest: 'd1', images: image }));
    await writeMaterialExtraction(
      queryable(),
      input({ contentDigest: 'd2', extractorId: 'unpdf', images: image }),
    );
    // Two rows, one blob: that deduplication is the point of the layer.
    expect(await blobCount()).toBe('1');
  });

  it('drops an image with neither bytes nor a src rather than storing an empty entry', async () => {
    const written = await writeMaterialExtraction(
      queryable(),
      input({ images: [{ id: 'img_1', pageNumber: 1 }] }),
    );
    expect(written).toEqual({ imageCount: 0, imagesTruncated: false });
    expect(await blobCount()).toBe('0');
  });

  it('reclaims a blob once no derivation references it any more', async () => {
    const bytes = Buffer.from([7, 7]);
    await writeMaterialExtraction(
      queryable(),
      input({ images: [{ id: 'img_1', pageNumber: 1, bytes, mime: 'image/png' }] }),
    );
    expect(await blobCount()).toBe('1');

    // Abandon it: the row goes, and the touch ages past the TTL.
    await pool.query('DELETE FROM material_extraction');
    await pool.query('UPDATE material_image_blob SET last_seen_at = 0');

    const deleted = await pruneMaterialImageBlobs(pool, { now: Date.now() });
    expect(deleted).toBe(1);
    expect(await blobCount()).toBe('0');
  });

  it('never reclaims a blob a derivation still references, however old the touch', async () => {
    const bytes = Buffer.from([8, 8]);
    await writeMaterialExtraction(
      queryable(),
      input({ images: [{ id: 'img_1', pageNumber: 1, bytes, mime: 'image/png' }] }),
    );
    // The same abandoned-looking blob as above, but the row is still here.
    await pool.query('UPDATE material_image_blob SET last_seen_at = 0');

    await pruneMaterialImageBlobs(pool, { now: Date.now() });
    expect(await blobCount()).toBe('1');
  });

  it('leaves a freshly touched blob alone even when nothing references it', async () => {
    await pool.query(
      `INSERT INTO material_image_blob (content_hash, byte_size, mime, bytes, created_at, last_seen_at)
       VALUES ('orphan', 1, 'image/png', '\\x00'::bytea, $1, $1)`,
      [Date.now()],
    );
    // Within the TTL: not yet a candidate, so the reference check is not even
    // reached. This is the window that protects a blob written just before the
    // row that will name it.
    const deleted = await pruneMaterialImageBlobs(pool, { now: Date.now() });
    expect(deleted).toBe(0);
    expect(await blobCount()).toBe('1');
  });
});
