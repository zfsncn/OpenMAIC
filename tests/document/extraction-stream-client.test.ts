/**
 * The browser's reader for the streamed extraction response.
 *
 * The route promises newline-delimited JSON — progress records, then one
 * result record. These tests pin the reader's side of that contract: records
 * are handed over as they arrive, a record split across two chunks is still
 * read, and the result is narrowed by the same rules the archive client uses,
 * so an unreadable body degrades to "failed" rather than to a half-built
 * extraction the generation pipeline would try to render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  EXTRACTION_STREAM_MEDIA_TYPE,
  requestCourseMaterialExtraction,
} from '@/lib/document/extraction-stream-client';
import type { ExtractionProgress } from '@/lib/document/types';

function streamResponse(chunks: string[], contentType = EXTRACTION_STREAM_MEDIA_TYPE): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': contentType } },
  );
}

function ndjson(records: unknown[]): Response {
  return streamResponse(records.map((record) => `${JSON.stringify(record)}\n`));
}

const RESULT_RECORD = {
  type: 'result',
  body: {
    success: true,
    data: { text: 'parsed lesson', metadata: { pageCount: 3 } },
  },
};

describe('requestCourseMaterialExtraction', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the stream and reports progress before the result', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ndjson([
        { type: 'progress', progress: { stage: 'pending' } },
        { type: 'progress', progress: { stage: 'running', completedPages: 2, totalPages: 3 } },
        RESULT_RECORD,
      ]),
    );

    const reports: ExtractionProgress[] = [];
    const outcome = await requestCourseMaterialExtraction(new FormData(), {
      onProgress: (progress) => reports.push(progress),
    });

    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: EXTRACTION_STREAM_MEDIA_TYPE,
    });
    expect(reports).toEqual([
      { stage: 'pending' },
      { stage: 'running', completedPages: 2, totalPages: 3 },
    ]);
    expect(outcome).toEqual({
      status: 'ok',
      data: { text: 'parsed lesson', metadata: { pageCount: 3 } },
    });
  });

  it('carries a service percentage through, and drops one that cannot be true', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ndjson([
        { type: 'progress', progress: { stage: 'processing', percent: 42.5 } },
        // The reader re-derives every field it names and drops the rest, so a
        // value it cannot believe is dropped rather than rendered as-is. That
        // same property is how a field the reader does *not* name goes missing
        // in silence, which is what this whole case exists to pin down.
        { type: 'progress', progress: { stage: 'processing', percent: 0 } },
        { type: 'progress', progress: { stage: 'processing', percent: 140 } },
        { type: 'progress', progress: { stage: 'processing', percent: 'not a number' } },
        RESULT_RECORD,
      ]),
    );

    const reports: ExtractionProgress[] = [];
    await requestCourseMaterialExtraction(new FormData(), {
      onProgress: (progress) => reports.push(progress),
    });

    expect(reports).toEqual([
      { stage: 'processing', percent: 42.5 },
      { stage: 'processing' },
      { stage: 'processing' },
      { stage: 'processing' },
    ]);
  });

  it('reads a record that a chunk boundary split in half', async () => {
    const line = `${JSON.stringify(RESULT_RECORD)}\n`;
    const split = Math.floor(line.length / 2);

    vi.mocked(fetch).mockResolvedValue(streamResponse([line.slice(0, split), line.slice(split)]));

    const outcome = await requestCourseMaterialExtraction(new FormData());

    expect(outcome).toEqual({
      status: 'ok',
      data: { text: 'parsed lesson', metadata: { pageCount: 3 } },
    });
  });

  it('carries the classified failure and its resume handle', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ndjson([
        {
          type: 'result',
          body: {
            success: false,
            errorCode: 'PARSE_FAILED',
            error: 'AliDocMind timed out after 900s',
            reason: 'timeout',
            details: 'b7',
          },
        },
      ]),
    );

    const outcome = await requestCourseMaterialExtraction(new FormData());

    expect(outcome).toEqual({
      status: 'failed',
      kind: 'timeout',
      resumeToken: 'b7',
      message: 'AliDocMind timed out after 900s',
    });
  });

  it('reports failure when the stream ends without a result', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ndjson([{ type: 'progress', progress: { stage: 'running' } }]),
    );

    expect(await requestCourseMaterialExtraction(new FormData())).toEqual({
      status: 'failed',
    });
  });

  it('still reads a plain JSON body from a server that ignored the media type', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(RESULT_RECORD.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const outcome = await requestCourseMaterialExtraction(new FormData());

    expect(outcome).toEqual({
      status: 'ok',
      data: { text: 'parsed lesson', metadata: { pageCount: 3 } },
    });
  });

  it('does not let a throwing progress callback break the extraction', async () => {
    vi.mocked(fetch).mockResolvedValue(
      ndjson([{ type: 'progress', progress: { stage: 'running' } }, RESULT_RECORD]),
    );

    const outcome = await requestCourseMaterialExtraction(new FormData(), {
      onProgress: () => {
        throw new Error('a caller bug');
      },
    });

    expect(outcome.status).toBe('ok');
  });
});
