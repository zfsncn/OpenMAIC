/**
 * The streamed form of `POST /api/extract-document`.
 *
 * A client that asks for `application/x-ndjson` gets progress records while
 * the extraction runs and one final `result` record carrying the body the
 * single-body form would have returned. These tests pin the three things that
 * make that contract usable from the browser:
 *
 *  - the record sequence (progress…, then exactly one result, status 200);
 *  - that a failure is classified into `reason` with its resume handle in
 *    `details` — the two fields the client picks an actionable message and a
 *    resumable retry from;
 *  - that the client's `resumeToken` reaches the extractor.
 *
 * The single-body form is covered by `extract-document-route.test.ts`; the
 * same fixtures drive both, so a drift between the two answers is a failure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ExtractionProgress } from '@/lib/document/types';

const STREAM_MEDIA_TYPE = 'application/x-ndjson';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(() => false),
  resolveManagedAliDocMindCredentials: vi.fn(() => undefined),
  resolvePDFApiKey: vi.fn((_providerId: string, clientKey?: string) => clientKey || ''),
  resolvePDFBaseUrl: vi.fn((_providerId: string, clientBaseUrl?: string) => clientBaseUrl),
  parsePDF: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

// AliDocMind is the only extractor that can stream progress or resume a job,
// and it reaches the vendor through `parsePDF`. Mocking that seam keeps the
// route's hook forwarding observable without any network call.
vi.mock('@/lib/pdf/pdf-providers', () => ({
  parsePDF: mocks.parsePDF,
}));

/**
 * The extras the PDF extractor receives as its third argument — the channels a
 * long-running remote provider reports progress on and resumes from.
 */
interface ParseOptions {
  fileName?: string;
  mimeType?: string;
  onProgress?: (progress: ExtractionProgress) => void;
  resumeToken?: string;
}

/** The options object the extractor call carries as its last argument. */
function parseOptions(): ParseOptions {
  return mocks.parsePDF.mock.calls[0]?.[2] as ParseOptions;
}

async function post(formData: FormData, accept?: string) {
  const { POST } = await import('@/app/api/extract-document/route');
  return POST(
    new Request('http://localhost/api/extract-document', {
      method: 'POST',
      ...(accept ? { headers: { accept } } : {}),
      body: formData,
    }) as unknown as NextRequest,
  );
}

function lessonForm(): FormData {
  const formData = new FormData();
  formData.append('file', new File(['%PDF-1.4'], 'lesson.pdf', { type: 'application/pdf' }));
  formData.append('providerId', 'alidocmind');
  formData.append('accessKeyId', 'ak');
  formData.append('accessKeySecret', 'sk');
  return formData;
}

/** Parse a newline-delimited JSON body into its records. */
async function readRecords(response: Response): Promise<Array<Record<string, unknown>>> {
  return (await response.text())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('POST /api/extract-document (streamed form)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolveManagedAliDocMindCredentials.mockReturnValue(undefined);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientKey?: string) => clientKey || '',
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.parsePDF.mockReset();
    mocks.parsePDF.mockResolvedValue({
      text: 'streamed text',
      images: [],
      metadata: { pageCount: 20, parser: 'alidocmind' },
    });
  });

  it('sends progress records and then exactly one result record', async () => {
    mocks.parsePDF.mockImplementation(
      async (_config: unknown, _buffer: unknown, options: ParseOptions | undefined) => {
        options?.onProgress?.({ stage: 'pending' });
        options?.onProgress?.({ stage: 'running', completedPages: 5, totalPages: 20 });
        return {
          text: 'streamed text',
          images: [],
          metadata: { pageCount: 20, parser: 'alidocmind' },
        };
      },
    );

    const response = await post(lessonForm(), STREAM_MEDIA_TYPE);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(STREAM_MEDIA_TYPE);

    const records = await readRecords(response);
    expect(records.map((record) => record.type)).toEqual(['progress', 'progress', 'result']);
    expect(records[0]).toMatchObject({ progress: { stage: 'pending' } });
    expect(records[1]).toMatchObject({
      progress: { stage: 'running', completedPages: 5, totalPages: 20 },
    });
    expect(records[2]).toMatchObject({
      body: { success: true, data: { text: 'streamed text' } },
    });
  });

  it('relays a classified failure and its resume handle in the final record', async () => {
    // Imported after `resetModules` so the error is an instance of the class
    // the freshly loaded route checks against — the module registry hands out
    // a new class identity per generation.
    const { ExtractionFailureError } = await import('@/lib/document/extraction-failure');
    mocks.parsePDF.mockRejectedValue(
      new ExtractionFailureError('timed out', { kind: 'timeout', resumeToken: 'b7' }),
    );

    const response = await post(lessonForm(), STREAM_MEDIA_TYPE);

    // The status is already on the wire by the time the extraction can fail,
    // so the failure rides the record instead of the status line.
    expect(response.status).toBe(200);
    const records = await readRecords(response);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'result',
      body: {
        success: false,
        errorCode: 'PARSE_FAILED',
        reason: 'timeout',
        details: 'b7',
      },
    });
  });

  it('forwards the client resume handle to the extractor', async () => {
    const formData = lessonForm();
    formData.append('resumeToken', 'batch-42');

    await post(formData, STREAM_MEDIA_TYPE);

    expect(parseOptions().resumeToken).toBe('batch-42');
  });

  it('drops a resume handle that could not be one', async () => {
    const formData = lessonForm();
    formData.append('resumeToken', '../../etc/passwd');

    await post(formData, STREAM_MEDIA_TYPE);

    // Starting over is always a valid answer, so a malformed handle is ignored
    // rather than refused — and never reaches the extractor.
    expect(parseOptions().resumeToken).toBeUndefined();
  });

  it('classifies a failure on the single-body form too', async () => {
    const { ExtractionFailureError } = await import('@/lib/document/extraction-failure');
    mocks.parsePDF.mockRejectedValue(
      new ExtractionFailureError('out of quota', { kind: 'quota', resumeToken: 'b9' }),
    );

    const response = await post(lessonForm());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, reason: 'quota', details: 'b9' });
    // The extractor's own message still reaches a byte-form caller.
    expect(body.error).toBe('out of quota');
  });
});
