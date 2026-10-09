import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchArchivedExtraction,
  hasUsableArchivedExtraction,
} from '@/lib/document/extraction-archive-client';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const DIGEST = 'a'.repeat(64);

const archivedBody = {
  success: true,
  data: {
    text: '# Chapter 1',
    images: ['data:image/png;base64,ONE'],
    metadata: {
      pageCount: 7,
      pdfImages: [
        { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 3, width: 8, height: 9 },
      ],
      extractionCache: {
        digest: DIGEST,
        extractorId: 'alidocmind',
        extractorVersion: '1',
        hit: true,
      },
    },
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchArchivedExtraction', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the archive response into the shape the generation pipeline consumes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(archivedBody));
    const result = await fetchArchivedExtraction({ contentDigest: DIGEST });

    expect(result?.text).toBe('# Chapter 1');
    expect(result?.images).toEqual(['data:image/png;base64,ONE']);
    expect(result?.metadata?.pageCount).toBe(7);
    expect(result?.metadata?.pdfImages).toEqual([
      { id: 'img_1', src: 'data:image/png;base64,ONE', pageNumber: 3, width: 8, height: 9 },
    ]);
    expect(result?.metadata?.extractionCache?.extractorId).toBe('alidocmind');
  });

  it('addresses the row by digest, and carries the preferred extractor when there is one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(archivedBody));
    await fetchArchivedExtraction({ contentDigest: DIGEST, extractorId: 'unpdf' });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(`digest=${DIGEST}`);
    // The preference is a preference, not a requirement: the server decides
    // whether it can be honoured (`selectArchivedExtraction`).
    expect(url).toContain('extractor=unpdf');
  });

  it('omits the extractor parameter entirely when none is named', async () => {
    fetchMock.mockResolvedValue(jsonResponse(archivedBody));
    await fetchArchivedExtraction({ contentDigest: DIGEST });

    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('extractor=');
  });

  it('answers null for a chapter the archive does not hold, rather than throwing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, errorCode: 'ASSET_NOT_FOUND', error: 'nope', reason: 'NOT_ARCHIVED' },
        404,
      ),
    );
    await expect(fetchArchivedExtraction({ contentDigest: DIGEST })).resolves.toBeNull();
  });

  it('answers null when the deployment serves no archive route at all', async () => {
    fetchMock.mockResolvedValue(new Response('Not found', { status: 404 }));
    await expect(fetchArchivedExtraction({ contentDigest: DIGEST })).resolves.toBeNull();
  });

  it('answers null when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchArchivedExtraction({ contentDigest: DIGEST })).resolves.toBeNull();
  });

  it('answers null for a body it cannot read, never a half-built extraction', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { text: 42 } }));
    await expect(fetchArchivedExtraction({ contentDigest: DIGEST })).resolves.toBeNull();

    fetchMock.mockResolvedValue(new Response('{not json', { status: 200 }));
    await expect(fetchArchivedExtraction({ contentDigest: DIGEST })).resolves.toBeNull();
  });

  it('drops an image without an id instead of handing the bundle a nameless one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { text: 't', metadata: { pdfImages: [{ src: 'x' }, { id: 'img_1', src: 'x' }] } },
      }),
    );
    const result = await fetchArchivedExtraction({ contentDigest: DIGEST });
    expect(result?.metadata?.pdfImages).toEqual([{ id: 'img_1', src: 'x' }]);
  });

  it('stays quiet about an aborted generation: the caller owns that cancel', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    await expect(
      fetchArchivedExtraction({ contentDigest: DIGEST, signal: controller.signal }),
    ).resolves.toBeNull();
  });
});

describe('hasUsableArchivedExtraction', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** An archive answer carrying `text` and naming `extractorId`. */
  function archived(text: string, extractorId: string | undefined, hit = true) {
    return jsonResponse({
      success: true,
      data: {
        text,
        metadata: extractorId
          ? { extractionCache: { digest: DIGEST, extractorId, extractorVersion: '1', hit } }
          : {},
      },
    });
  }

  it('is true when the extractor the caller selected produced the text', async () => {
    fetchMock.mockResolvedValue(archived('# Chapter 1', 'alidocmind'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'alidocmind' }),
    ).resolves.toBe(true);
  });

  it('is false when the archive holds nothing for these bytes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: false, errorCode: 'ASSET_NOT_FOUND', error: 'nope', reason: 'NOT_ARCHIVED' },
        404,
      ),
    );
    await expect(hasUsableArchivedExtraction({ contentDigest: DIGEST })).resolves.toBe(false);
  });

  it('is false when the request itself failed — an unreachable archive is not a derivation', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'alidocmind' }),
    ).resolves.toBe(false);
  });

  it('is false for a successful parse that returned no text', async () => {
    // A scanned PDF through a text-only parser: the archive serves this row
    // and answers 200, because the server does not judge a named extractor's
    // text. Treating it as parsed would skip the very extraction it needs.
    fetchMock.mockResolvedValue(archived(' ', 'unpdf'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'unpdf' }),
    ).resolves.toBe(false);

    fetchMock.mockResolvedValue(archived('', 'unpdf'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'unpdf' }),
    ).resolves.toBe(false);

    fetchMock.mockResolvedValue(archived('\n\t  \n', 'unpdf'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'unpdf' }),
    ).resolves.toBe(false);
  });

  it('is false when the answer came from a different extractor than the one selected', async () => {
    // The server falls back to the newest non-empty derivation on a named miss
    // (`selectArchivedExtraction`), so this is an ordinary answer — and it must
    // not count as "the selected parser already ran", which is what the caller
    // is asking. Otherwise re-uploading to re-extract is silently skipped.
    fetchMock.mockResolvedValue(archived('# Chapter 1', 'plain-text'));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'alidocmind' }),
    ).resolves.toBe(false);
  });

  it('is true when no extractor was named and there is text to use', async () => {
    fetchMock.mockResolvedValue(archived('# Chapter 1', 'alidocmind'));
    await expect(hasUsableArchivedExtraction({ contentDigest: DIGEST })).resolves.toBe(true);
  });

  it('trusts the text when the answer does not name the extractor that produced it', async () => {
    // A server that omits the name cannot be checked against, and refusing to
    // act on it would re-extract material that is demonstrably archived.
    fetchMock.mockResolvedValue(archived('# Chapter 1', undefined));
    await expect(
      hasUsableArchivedExtraction({ contentDigest: DIGEST, extractorId: 'alidocmind' }),
    ).resolves.toBe(true);
  });
});
