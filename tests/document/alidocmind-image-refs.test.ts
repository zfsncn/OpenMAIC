/**
 * AliDocMind's figure/picture blocks: the text must reference the images it
 * actually produced.
 *
 * The service embeds image URLs in the block's `markdownContent` and the URLs
 * are signed (they expire), so they cannot be emitted verbatim. The earlier
 * behaviour dropped the block entirely, which left the text with no reference
 * to the image while the image itself still landed in `images[]`/
 * `metadata.pdfImages` — nothing in the text could be resolved to it.
 *
 * The ids are only known after every download settles (a failed download drops
 * out of `pdfImages` and shifts the ids after it), so this suite pins both the
 * reference itself and the two-pass id assignment that makes it correct.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const submitDocParserJobAdvance = vi.fn();
const queryDocParserStatus = vi.fn();
const getDocParserResult = vi.fn();

vi.mock('@alicloud/docmind-api20220711', () => {
  class Client {
    submitDocParserJobAdvance = submitDocParserJobAdvance;
    queryDocParserStatus = queryDocParserStatus;
    getDocParserResult = getDocParserResult;
  }
  class Request {
    constructor(public args: unknown) {}
  }
  return {
    default: Client,
    SubmitDocParserJobAdvanceRequest: Request,
    SubmitDocParserJobAdvanceRequestMultimediaParameters: Request,
    QueryDocParserStatusRequest: Request,
    GetDocParserResultRequest: Request,
  };
});
vi.mock('@alicloud/openapi-client', () => ({
  Config: class {
    constructor(public args: unknown) {}
  },
}));
vi.mock('@alicloud/tea-util', () => ({
  RuntimeOptions: class {
    constructor(public args: unknown) {}
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// sharp only needs to produce *some* PNG bytes; the identity of the bytes is
// irrelevant to which id a reference resolves to.
vi.mock('sharp', () => ({
  default: () => ({ png: () => ({ toBuffer: async () => Buffer.from([1, 2, 3]) }) }),
}));

import { parsePDF } from '@/lib/pdf/pdf-providers';

const A = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/a.png?sig=1';
const B = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/b.png?sig=1';

const CONFIG = { providerId: 'alidocmind' as const, accessKeyId: 'ak', accessKeySecret: 'sk' };
const BUFFER = Buffer.from('%PDF-1.4');

const realFetch = global.fetch;

/** Serve every OSS image, except the ones listed in `failing`. */
function serveImages(failing: string[] = []): void {
  global.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (failing.some((f) => url.includes(f))) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-length': '4' },
    });
  }) as unknown as typeof fetch;
}

/** Drive one successful job whose result carries `layouts`. */
async function parseLayouts(layouts: Array<Record<string, unknown>>) {
  submitDocParserJobAdvance.mockResolvedValue({ body: { code: '200', data: { id: 'job-1' } } });
  queryDocParserStatus.mockResolvedValue({ body: { code: '200', data: { status: 'success' } } });
  getDocParserResult.mockResolvedValue({ body: { code: '200', data: { layouts } } });
  return parsePDF(CONFIG, BUFFER, { fileName: 'lesson.pdf', mimeType: 'application/pdf' });
}

describe('AliDocMind image references in the extracted text', () => {
  afterEach(() => {
    global.fetch = realFetch;
    submitDocParserJobAdvance.mockReset();
    queryDocParserStatus.mockReset();
    getDocParserResult.mockReset();
    vi.restoreAllMocks();
  });

  it("emits ![](img_N) in the block's own position, not a signed URL", async () => {
    serveImages();
    const parsed = await parseLayouts([
      { type: 'title', markdownContent: '# Lesson', pageNum: 0 },
      { type: 'text', markdownContent: 'Body paragraph.', pageNum: 0 },
      { type: 'figure', markdownContent: `![](${A})`, pageNum: 0 },
      { type: 'text', markdownContent: 'After the figure.', pageNum: 1 },
    ]);

    expect(parsed.text).toBe('# Lesson\n\nBody paragraph.\n\n![](img_1)\n\nAfter the figure.');
    // The reference resolves to something: an id that is in `images[]` and in
    // `metadata.imageMapping` — that agreement is the whole point.
    expect(parsed.images).toHaveLength(1);
    expect(parsed.metadata?.imageMapping).toHaveProperty('img_1');
    expect(parsed.metadata?.pdfImages?.[0]).toMatchObject({ id: 'img_1', pageNumber: 1 });
    // A signed URL expires, so it must never reach the text.
    expect(parsed.text).not.toContain('aliyuncs.com');
  });

  it('keeps references and ids aligned when an earlier download fails', async () => {
    serveImages(['/a.png']);
    const parsed = await parseLayouts([
      { type: 'figure', markdownContent: `![](${A})`, pageNum: 0 },
      { type: 'figure', markdownContent: `![](${B})`, pageNum: 1 },
    ]);

    // Only the second image survives, so it takes img_1 — and the reference
    // that pointed at it must say img_1 too, not img_2.
    expect(parsed.images).toHaveLength(1);
    expect(parsed.metadata?.pdfImages?.[0]).toMatchObject({ id: 'img_1', pageNumber: 2 });
    expect(parsed.text).toBe('![](img_1)');
  });

  it('drops the whole block when its only image fails, leaving no blank paragraph', async () => {
    serveImages(['/a.png']);
    const parsed = await parseLayouts([
      { type: 'text', markdownContent: 'Before.', pageNum: 0 },
      { type: 'figure', markdownContent: `![](${A})`, pageNum: 0 },
      { type: 'text', markdownContent: 'After.', pageNum: 0 },
    ]);

    expect(parsed.images).toHaveLength(0);
    expect(parsed.text).toBe('Before.\n\nAfter.');
  });

  it("keeps a chart figure's llmResult alongside its reference", async () => {
    serveImages();
    const parsed = await parseLayouts([
      {
        type: 'figure',
        markdownContent: `![](${A})`,
        llmResult: '| q | v |\n| - | - |',
        pageNum: 0,
      },
    ]);

    expect(parsed.text).toBe('![](img_1)\n\n| q | v |\n| - | - |');
  });

  it('does not duplicate llmResult when it already carries the block text', async () => {
    serveImages();
    const parsed = await parseLayouts([
      { type: 'figure', markdownContent: '', llmResult: 'A described figure.', pageNum: 0 },
    ]);

    expect(parsed.text).toBe('A described figure.');
    expect(parsed.images).toHaveLength(0);
  });

  it('never leaks an internal resolution token into the text', async () => {
    serveImages();
    const parsed = await parseLayouts([
      { type: 'figure', markdownContent: `![](${A})`, pageNum: 0 },
      { type: 'figure', markdownContent: `![](${B})`, pageNum: 1 },
    ]);

    expect(parsed.text).not.toContain('\u0000');
    expect(parsed.text).toBe('![](img_1)\n\n![](img_2)');
  });
});
