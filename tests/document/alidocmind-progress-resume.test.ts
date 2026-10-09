/**
 * The parts of the AliDocMind client that only matter for a long remote job:
 * reporting progress while it runs, resuming a job an earlier attempt already
 * submitted, and classifying a failure into something a caller — and ultimately
 * a user — can act on.
 *
 * The credential probe lives in `alidocmind-verify.test.ts` and the live
 * end-to-end path in `alidocmind.smoke.test.ts`; these tests stub the SDK and
 * drive the submit → poll → get flow directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the Aliyun SDK so we can drive the flow deterministically.
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

import { parseWithAliDocMindClient } from '@/lib/pdf/alidocmind-client';
import { ExtractionFailureError } from '@/lib/document/extraction-failure';
import type { ExtractionProgress } from '@/lib/document/types';

const CREDS = { accessKeyId: 'ak', accessKeySecret: 'sk' };
const SUBMIT = { buffer: Buffer.from('%PDF-1.4'), fileName: 'lesson.pdf' };

/** A minimal successful result body: one layout block, one page. */
const RESULT_OK = {
  code: '200',
  data: { layouts: [{ type: 'text', markdownContent: '# Lesson', pageNum: 0 }] },
};

function submitted(id: string) {
  return { body: { code: '200', data: { id } } };
}

/** Poll the service with `responses`, one per poll, the last one repeating. */
function repliesWith(...responses: Array<Record<string, unknown>>) {
  responses.forEach((body) => queryDocParserStatus.mockResolvedValueOnce({ body }));
  queryDocParserStatus.mockResolvedValue({ body: responses[responses.length - 1] });
}

describe('parseWithAliDocMindClient — long-running jobs', () => {
  afterEach(() => {
    submitDocParserJobAdvance.mockReset();
    queryDocParserStatus.mockReset();
    getDocParserResult.mockReset();
  });

  it('reports the service percentage, and only when it changes', async () => {
    submitDocParserJobAdvance.mockResolvedValue(submitted('job-1'));
    repliesWith(
      // Queued: the service reports neither a percentage nor a page estimate,
      // and its "0%" means "not started" — which is what the caller's waiting
      // copy says far better than a zero would.
      { code: '200', data: { status: 'Init' } },
      // pageCountEstimate is a 0-based page count: 23 means 24 pages.
      { code: '200', data: { status: 'Processing', processing: 42.5, pageCountEstimate: 23 } },
      // Identical counters: reporting them again would make the client
      // re-render an identical line every few seconds.
      { code: '200', data: { status: 'Processing', processing: 42.5, pageCountEstimate: 23 } },
      { code: '200', data: { status: 'success', processing: 100 } },
    );
    getDocParserResult.mockResolvedValue({ body: RESULT_OK });

    const reports: ExtractionProgress[] = [];
    const result = await parseWithAliDocMindClient(CREDS, SUBMIT, {
      onProgress: (progress) => reports.push(progress),
    });

    expect(result.jobId).toBe('job-1');
    expect(reports).toEqual([
      { stage: 'init' },
      { stage: 'processing', percent: 42.5, totalPages: 24 },
      { stage: 'success', percent: 100 },
    ]);
  });

  it('resumes an earlier job without re-submitting the document', async () => {
    repliesWith({ code: '200', data: { status: 'success' } });
    getDocParserResult.mockResolvedValue({ body: RESULT_OK });

    const result = await parseWithAliDocMindClient(CREDS, SUBMIT, { resumeJobId: 'job-7' });

    expect(result.jobId).toBe('job-7');
    // The whole point of resuming: the bytes are already with the service, so
    // the document is not submitted a second time.
    expect(submitDocParserJobAdvance).not.toHaveBeenCalled();
    expect(queryDocParserStatus.mock.calls[0][0]).toMatchObject({ args: { id: 'job-7' } });
  });

  it('ignores a resume handle that could not have come from this client', async () => {
    submitDocParserJobAdvance.mockResolvedValue(submitted('job-9'));
    repliesWith({ code: '200', data: { status: 'success' } });
    getDocParserResult.mockResolvedValue({ body: RESULT_OK });

    const result = await parseWithAliDocMindClient(CREDS, SUBMIT, {
      resumeJobId: '../../etc/passwd',
    });

    // An unusable handle means "start over", which always works — and it must
    // never reach a request.
    expect(submitDocParserJobAdvance).toHaveBeenCalledTimes(1);
    expect(queryDocParserStatus.mock.calls[0][0]).toMatchObject({ args: { id: 'job-9' } });
    expect(result.jobId).toBe('job-9');
  });

  it.each([
    ['NoPermission', 'You are not authorized to operate DocMind.', 'auth'],
    ['Throttling.User', 'Request was denied due to user flow control.', 'quota'],
    [
      'ServiceUnavailable',
      'The request failed because the server is unavailable.',
      'service-unavailable',
    ],
    ['InvalidParameter', 'The specified parameter is not valid.', 'failed'],
  ])('classifies a rejected status query (%s) as %s', async (code, message, kind) => {
    submitDocParserJobAdvance.mockResolvedValue(submitted('job-2'));
    repliesWith({ code, message });

    // The job is already submitted, so the handle travels with the failure: a
    // retry that resumes it picks up where this one stopped instead of paying
    // for a second parse.
    await expect(parseWithAliDocMindClient(CREDS, SUBMIT)).rejects.toMatchObject({
      name: 'ExtractionFailureError',
      kind,
      resumeToken: 'job-2',
    });
  });

  it('withholds a handle the service says it does not have', async () => {
    repliesWith({ code: 'BizIdNotExistOrResultExpired', message: 'The bizId does not exist.' });

    const rejection = await parseWithAliDocMindClient(CREDS, SUBMIT, {
      resumeJobId: 'job-8',
    }).catch((error) => error);

    expect(rejection).toMatchObject({ name: 'ExtractionFailureError', kind: 'failed' });
    // A caller keeps whatever handle it is given and hands it back next time, so
    // returning this one would make every retry fail instantly on the same
    // missing job while re-arming the next. Better one wasted attempt.
    expect((rejection as ExtractionFailureError).resumeToken).toBeUndefined();
  });

  it('classifies a failed job by the message the service attached to it', async () => {
    submitDocParserJobAdvance.mockResolvedValue(submitted('job-3'));
    repliesWith({
      code: '200',
      message: 'quota exhausted for this account',
      data: { status: 'Fail' },
    });

    await expect(parseWithAliDocMindClient(CREDS, SUBMIT)).rejects.toMatchObject({
      name: 'ExtractionFailureError',
      kind: 'quota',
      resumeToken: 'job-3',
    });
  });

  it('classifies a submit failure as auth, and offers no handle', async () => {
    submitDocParserJobAdvance.mockRejectedValue(
      Object.assign(new Error('Specified access key is not found'), {
        code: 'InvalidAccessKeyId.NotFound',
      }),
    );

    const rejection = await parseWithAliDocMindClient(CREDS, SUBMIT).catch((error) => error);

    expect(rejection).toBeInstanceOf(ExtractionFailureError);
    expect((rejection as ExtractionFailureError).kind).toBe('auth');
    // Nothing was submitted, so there is nothing a handle could name.
    expect((rejection as ExtractionFailureError).resumeToken).toBeUndefined();
  });

  it('classifies missing credentials as auth', async () => {
    const rejection = await parseWithAliDocMindClient({}, SUBMIT).catch((error) => error);

    expect(rejection).toMatchObject({ name: 'ExtractionFailureError', kind: 'auth' });
    expect(submitDocParserJobAdvance).not.toHaveBeenCalled();
  });

  it('keeps extracting when a progress reporter throws', async () => {
    submitDocParserJobAdvance.mockResolvedValue(submitted('job-4'));
    repliesWith({ code: '200', data: { status: 'success' } });
    getDocParserResult.mockResolvedValue({ body: RESULT_OK });

    // A reporting channel that can break the work it reports on is worse than
    // no channel at all.
    const result = await parseWithAliDocMindClient(CREDS, SUBMIT, {
      onProgress: () => {
        throw new Error('renderer exploded');
      },
    });

    expect(result.jobId).toBe('job-4');
  });

  it('classifies an exhausted deadline as a timeout that can be resumed', async () => {
    vi.useFakeTimers();
    try {
      submitDocParserJobAdvance.mockResolvedValue(submitted('job-5'));
      // Still working when the deadline passes.
      queryDocParserStatus.mockResolvedValue({
        body: { code: '200', data: { status: 'Processing', processing: 10 } },
      });

      const promise = parseWithAliDocMindClient(CREDS, SUBMIT);
      // Attach the rejection expectation before advancing, so the rejection is
      // never briefly unhandled.
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'ExtractionFailureError',
        kind: 'timeout',
        resumeToken: 'job-5',
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
