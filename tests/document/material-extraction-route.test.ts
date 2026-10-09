import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import type { MaterialExtractionRecord } from '@/lib/persistence/material-extraction';

const mocks = vi.hoisted(() => ({
  isServerPersistenceConfigured: vi.fn(() => true),
  withRequestOwner: vi.fn(),
  getServerPersistenceProvider: vi.fn(),
  listMaterialExtractionsByDigest: vi.fn(),
  readMaterialImageBlobs: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: mocks.isServerPersistenceConfigured,
}));

// Only the owner resolution is replaced: every answer still goes through the
// real response helpers, so the route's header behavior is what is tested.
vi.mock('@/lib/server/identity/with-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/identity/with-owner')>();
  return { ...actual, withRequestOwner: mocks.withRequestOwner };
});

vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: mocks.getServerPersistenceProvider,
}));

vi.mock('@/lib/persistence/material-extraction', () => ({
  listMaterialExtractionsByDigest: mocks.listMaterialExtractionsByDigest,
}));

vi.mock('@/lib/persistence/material-image-blob', () => ({
  readMaterialImageBlobs: mocks.readMaterialImageBlobs,
}));

const DIGEST = 'b'.repeat(64);

function record(overrides: Partial<MaterialExtractionRecord> = {}): MaterialExtractionRecord {
  return {
    ownerId: 'owner-1',
    contentDigest: DIGEST,
    extractorId: 'alidocmind',
    extractorVersion: '1',
    fileName: 'chapter-01.pdf',
    mimeType: 'application/pdf',
    byteSize: 4096,
    parser: 'alidocmind',
    pageCount: 12,
    text: '# Chapter 1',
    images: [{ id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 2 }],
    imageCount: 1,
    imagesTruncated: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

async function getArchive(query: string) {
  const { GET } = await import('@/app/api/material-extraction/route');
  return GET(
    new Request(`http://localhost/api/material-extraction${query}`) as unknown as NextRequest,
  );
}

describe('GET /api/material-extraction', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isServerPersistenceConfigured.mockReturnValue(true);
    mocks.getServerPersistenceProvider.mockResolvedValue({ pool: {} });
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([]);
    mocks.readMaterialImageBlobs.mockResolvedValue(new Map());
    mocks.withRequestOwner.mockImplementation(
      async (
        _req: unknown,
        handler: (principal: { ownerId: string }, headers: Headers) => Promise<Response>,
      ) => handler({ ownerId: 'owner-1' }, new Headers()),
    );
  });

  it('is not served at all without server persistence, like every other owner-scoped route', async () => {
    mocks.isServerPersistenceConfigured.mockReturnValue(false);
    const response = await getArchive(`?digest=${DIGEST}`);
    expect(response.status).toBe(404);
    // The route itself is absent, not the row: no archive exists to be empty.
    expect(mocks.listMaterialExtractionsByDigest).not.toHaveBeenCalled();
  });

  it.each([
    ['no digest', ''],
    ['a digest that is not a digest', '?digest=chapter-01'],
    ['an upper-case digest', `?digest=${DIGEST.toUpperCase()}`],
    ['a truncated digest', `?digest=${DIGEST.slice(0, 32)}`],
  ])('refuses %s with a 400', async (_label, query) => {
    const response = await getArchive(query);
    expect(response.status).toBe(400);
    expect((await response.json()).errorCode).toBe('INVALID_REQUEST');
    expect(mocks.listMaterialExtractionsByDigest).not.toHaveBeenCalled();
  });

  it('answers 404 NOT_ARCHIVED when this owner holds nothing for those bytes', async () => {
    const response = await getArchive(`?digest=${DIGEST}`);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.errorCode).toBe('ASSET_NOT_FOUND');
    // Distinct from the route being absent: the client logs the two differently.
    expect(body.reason).toBe('NOT_ARCHIVED');
  });

  it('scopes the read to the resolved owner, never to a request parameter', async () => {
    await getArchive(`?digest=${DIGEST}&ownerId=someone-else`);
    expect(mocks.listMaterialExtractionsByDigest).toHaveBeenCalledWith({}, 'owner-1', DIGEST);
  });

  it('answers with the archived extraction in the shape a live extraction uses', async () => {
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([record()]);
    const response = await getArchive(`?digest=${DIGEST}`);

    expect(response.status).toBe(200);
    // Another device may have just written this key's row, so nothing caches it.
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.text).toBe('# Chapter 1');
    expect(body.data.metadata.pageCount).toBe(12);
    expect(body.data.metadata.pdfImages).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 2 },
    ]);
    // The one addition over a live response, and what makes the source of the
    // text observable instead of indistinguishable from a fresh parse.
    expect(body.data.metadata.extractionCache).toEqual({
      digest: DIGEST,
      extractorId: 'alidocmind',
      extractorVersion: '1',
      hit: true,
    });
  });

  it('rehydrates image bytes stored in the byte layer into the data URL a live response sends', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([
      record({ images: [{ id: 'img_1', contentHash: 'a'.repeat(64), pageNumber: 2 }] }),
    ]);
    mocks.readMaterialImageBlobs.mockResolvedValue(
      new Map([['a'.repeat(64), { mime: 'image/png', bytes }]]),
    );

    const response = await getArchive(`?digest=${DIGEST}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    // The client cannot tell this from a live extraction — the whole point.
    expect(body.data.metadata.pdfImages).toEqual([
      { id: 'img_1', src: `data:image/png;base64,${bytes.toString('base64')}`, pageNumber: 2 },
    ]);
    expect(mocks.readMaterialImageBlobs).toHaveBeenCalledWith({}, ['a'.repeat(64)]);
  });

  it('answers 200 with an empty image src when the byte layer no longer holds the bytes', async () => {
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([
      record({ images: [{ id: 'img_1', contentHash: 'b'.repeat(64), pageNumber: 2 }] }),
    ]);
    // A pruned or partially-written blob: the text still generates, the image
    // is simply absent (an empty mapping value is falsy to the vision selector).
    mocks.readMaterialImageBlobs.mockResolvedValue(new Map());

    const response = await getArchive(`?digest=${DIGEST}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.metadata.pdfImages).toEqual([{ id: 'img_1', src: '', pageNumber: 2 }]);
  });

  it('honours the named extractor so several parsers of one file stay separable', async () => {
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([
      record({ extractorId: 'alidocmind', text: 'ocr text' }),
      record({ extractorId: 'unpdf', text: 'plain text' }),
    ]);
    const response = await getArchive(`?digest=${DIGEST}&extractor=unpdf`);
    expect((await response.json()).data.text).toBe('plain text');
  });

  it('falls back to the newest derivation for a device whose settings name another parser', async () => {
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([
      record({ extractorId: 'alidocmind', text: 'ocr text' }),
      record({ extractorId: 'unpdf', text: 'plain text' }),
    ]);
    // `plain-text` never ran on these bytes; refusing here would strand a
    // chapter that is already paid for.
    const response = await getArchive(`?digest=${DIGEST}&extractor=plain-text`);
    expect((await response.json()).data.metadata.extractionCache.extractorId).toBe('alidocmind');
  });

  it('treats an empty extractor parameter as no preference', async () => {
    mocks.listMaterialExtractionsByDigest.mockResolvedValue([record()]);
    const response = await getArchive(`?digest=${DIGEST}&extractor=`);
    expect(response.status).toBe(200);
  });

  it('answers 500 rather than pretending the archive is empty when it cannot be read', async () => {
    mocks.getServerPersistenceProvider.mockRejectedValue(new Error('db down'));
    const response = await getArchive(`?digest=${DIGEST}`);
    expect(response.status).toBe(500);
    expect((await response.json()).reason).toBe('ARCHIVE_UNAVAILABLE');
  });
});
