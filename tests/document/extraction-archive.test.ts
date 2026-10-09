import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { computeContentDigest } from '@/lib/document/content-digest';
import {
  archivedImagesOf,
  archivedRecordToResponse,
  archivedToParsedPdfContent,
  selectArchivedExtraction,
  toStorageImages,
} from '@/lib/document/extraction-archive';
import type { MaterialExtractionRecord } from '@/lib/persistence/material-extraction';
import type { ParsedPdfContent } from '@/lib/types/pdf';

describe('content digest', () => {
  it('produces the same lowercase hex the server computes for the same bytes', async () => {
    const bytes = new TextEncoder().encode('the same chapter, twice');
    const browserDigest = await computeContentDigest(new Blob([bytes]));
    const serverDigest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    // The two halves of the derivation key are computed by different runtimes;
    // if they ever disagree the archive silently never hits.
    expect(browserDigest).toBe(serverDigest);
  });

  it('reports no digest instead of throwing when this context cannot compute one', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      // A non-secure context: `crypto` present, `subtle` absent.
      Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
      await expect(computeContentDigest(new Blob(['x']))).resolves.toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, 'crypto', original);
    }
  });
});

describe('extraction archive mapping', () => {
  const parsed = (overrides: Partial<ParsedPdfContent> = {}): ParsedPdfContent => ({
    text: '# T',
    images: ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    metadata: {
      pageCount: 3,
      pdfImages: [
        { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 1, description: 'fig' },
        { id: 'img_2', src: 'data:image/png;base64,TWO', pageNumber: 2, width: 4, height: 5 },
      ],
    },
    ...overrides,
  });

  it('prefers the labelled pdfImages array', () => {
    expect(archivedImagesOf(parsed())).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 1, description: 'fig' },
      { id: 'img_2', src: 'data:image/png;base64,TWO', pageNumber: 2, width: 4, height: 5 },
    ]);
  });

  it('falls back to the bare images list, numbered the way the bundle numbers them', () => {
    expect(archivedImagesOf(parsed({ metadata: { pageCount: 1 } }))).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 1 },
      { id: 'img_2', src: 'data:image/png;base64,TWO', pageNumber: 1 },
    ]);
  });

  const record = (overrides: Partial<MaterialExtractionRecord> = {}): MaterialExtractionRecord => ({
    ownerId: 'owner-1',
    contentDigest: 'digest-a',
    extractorId: 'alidocmind',
    extractorVersion: '1',
    fileName: 'chapter-01.pdf',
    mimeType: 'application/pdf',
    byteSize: 4096,
    parser: 'alidocmind',
    pageCount: 12,
    text: '# Chapter 1\n\n![](images/fig-1.jpg)',
    images: [{ id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 4, description: 'fig' }],
    imageCount: 1,
    imagesTruncated: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  it('rebuilds the same response shape a live extraction produces', () => {
    const rebuilt = archivedToParsedPdfContent(record());
    expect(rebuilt.text).toBe('# Chapter 1\n\n![](images/fig-1.jpg)');
    // Both image forms the pipeline reads, exactly as
    // `documentArtifactToParsedPdfContent` builds them.
    expect(rebuilt.images).toEqual(['data:image/png;base64,ONE']);
    expect(rebuilt.metadata?.imageMapping).toEqual({ img_1: 'data:image/png;base64,ONE' });
    expect(rebuilt.metadata?.pdfImages).toEqual([
      {
        id: 'img_1',
        src: 'data:image/png;base64,ONE',
        pageNumber: 4,
        description: 'fig',
      },
    ]);
    expect(rebuilt.metadata?.pageCount).toBe(12);
    expect(rebuilt.metadata?.parser).toBe('alidocmind');
    expect(rebuilt.metadata?.extractionCache).toEqual({
      digest: 'digest-a',
      extractorId: 'alidocmind',
      extractorVersion: '1',
      hit: true,
    });
  });

  it('falls back to the extractor id and zero pages rather than emitting undefined', () => {
    const rebuilt = archivedToParsedPdfContent(record({ parser: null, pageCount: null }));
    expect(rebuilt.metadata?.parser).toBe('alidocmind');
    expect(rebuilt.metadata?.pageCount).toBe(0);
  });
});

describe('choosing which archived derivation answers', () => {
  // `listMaterialExtractionsByDigest` orders newest-first, so these are too.
  const rows = (...specs: Array<[string, string]>): MaterialExtractionRecord[] =>
    specs.map(([extractorId, text], index) => ({
      ownerId: 'owner-1',
      contentDigest: 'digest-a',
      extractorId,
      extractorVersion: '1',
      fileName: 'chapter-01.pdf',
      mimeType: 'application/pdf',
      byteSize: 4096,
      parser: extractorId,
      pageCount: 1,
      text,
      images: [],
      imageCount: 0,
      imagesTruncated: false,
      createdAt: index,
      updatedAt: index,
    }));

  it('answers with the requested extractor when it has one', () => {
    const all = rows(['alidocmind', 'ocr text'], ['unpdf', 'plain text']);
    expect(selectArchivedExtraction(all, 'unpdf')?.text).toBe('plain text');
  });

  it('falls back to the newest non-empty derivation when the requested one is absent', () => {
    // The cross-device case: the settings on the device asking are not the
    // settings the uploading device had, so the named extractor has no row.
    const all = rows(['alidocmind', 'ocr text'], ['unpdf', 'plain text']);
    expect(selectArchivedExtraction(all, 'plain-text')?.extractorId).toBe('alidocmind');
  });

  it('skips an empty derivation when falling back: an empty chapter is worse than a miss', () => {
    const all = rows(['unpdf', '   '], ['alidocmind', 'ocr text']);
    expect(selectArchivedExtraction(all, 'plain-text')?.text).toBe('ocr text');
  });

  it('answers with nothing when every derivation is empty, so the caller can ask for the file', () => {
    expect(
      selectArchivedExtraction(rows(['unpdf', ''], ['alidocmind', '\n']), undefined),
    ).toBeNull();
  });

  it('answers with nothing when the owner holds no derivation for these bytes', () => {
    expect(selectArchivedExtraction([], 'unpdf')).toBeNull();
  });

  it('serves the newest non-empty derivation to a caller that names no extractor', () => {
    const all = rows(['alidocmind', 'ocr text'], ['unpdf', 'plain text']);
    expect(selectArchivedExtraction(all, undefined)?.extractorId).toBe('alidocmind');
  });
});

describe('materializing archived images from the byte layer', () => {
  const bytes = Buffer.from([1, 2, 3]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;

  const hashedRecord = (
    overrides: Partial<MaterialExtractionRecord> = {},
  ): MaterialExtractionRecord => ({
    ownerId: 'owner-1',
    contentDigest: 'digest-a',
    extractorId: 'alidocmind',
    extractorVersion: '1',
    fileName: 'chapter-01.pdf',
    mimeType: 'application/pdf',
    byteSize: 4096,
    parser: 'alidocmind',
    pageCount: 12,
    text: '# Chapter 1',
    images: [{ id: 'img_1', contentHash: hash, pageNumber: 4 }],
    imageCount: 1,
    imagesTruncated: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });

  it('decodes a data URL into raw bytes, tagged with its MIME type', () => {
    expect(
      toStorageImages([
        { id: 'img_1', src: dataUrl, pageNumber: 2, description: 'fig', width: 3, height: 4 },
      ]),
    ).toEqual([
      {
        id: 'img_1',
        pageNumber: 2,
        description: 'fig',
        width: 3,
        height: 4,
        bytes,
        mime: 'image/png',
      },
    ]);
  });

  it('keeps a src that is not a data URL verbatim, so no image is silently lost', () => {
    expect(
      toStorageImages([{ id: 'img_1', src: 'https://example.test/a.png', pageNumber: 1 }]),
    ).toEqual([{ id: 'img_1', pageNumber: 1, src: 'https://example.test/a.png' }]);
  });

  it('rehydrates a contentHash back into the data URL a live extraction would have sent', () => {
    const rebuilt = archivedToParsedPdfContent(hashedRecord(), (image) =>
      image.contentHash === hash ? dataUrl : '',
    );
    expect(rebuilt.images).toEqual([dataUrl]);
    expect(rebuilt.metadata?.imageMapping).toEqual({ img_1: dataUrl });
    expect(rebuilt.metadata?.pdfImages).toEqual([{ id: 'img_1', src: dataUrl, pageNumber: 4 }]);
  });

  it('degrades a hash with no stored bytes to an empty src rather than failing the read', () => {
    const rebuilt = archivedToParsedPdfContent(hashedRecord(), () => '');
    expect(rebuilt.images).toEqual(['']);
    // An empty mapping value is falsy, so the vision selector drops the image.
    expect(rebuilt.metadata?.imageMapping).toEqual({ img_1: '' });
  });

  it('reads the bytes and rebuilds the response in one call', async () => {
    const queryable = {
      query: async () => ({ rows: [{ content_hash: hash, mime: 'image/png', bytes }] }),
    };
    const rebuilt = await archivedRecordToResponse(queryable as never, hashedRecord());
    expect(rebuilt.metadata?.pdfImages).toEqual([{ id: 'img_1', src: dataUrl, pageNumber: 4 }]);
  });

  it('does not touch the byte layer for a row that carries a verbatim src', async () => {
    let called = false;
    const queryable = {
      query: async () => {
        called = true;
        return { rows: [] };
      },
    };
    const rebuilt = await archivedRecordToResponse(
      queryable as never,
      hashedRecord({ images: [{ id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 1 }] }),
    );
    expect(called).toBe(false);
    expect(rebuilt.images).toEqual(['data:image/png;base64,ONE']);
  });
});
