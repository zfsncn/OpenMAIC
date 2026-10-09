/**
 * The browser's side of the streamed course-material extraction.
 *
 * ## Why this exists next to the plain call
 *
 * `POST /api/extract-document` answers a single JSON body, which is fine for
 * every extractor that returns in a second and useless for one that queues the
 * document on a remote service and polls it for up to fifteen minutes: the
 * browser holds a fetch open with nothing to show and no way to tell "queued",
 * "running", "stuck" and "dead" apart. Asking for `EXTRACTION_STREAM_MEDIA_TYPE`
 * opts the request into newline-delimited JSON instead — progress records while
 * the extraction runs, then one result record — so the page can render a real
 * status line. The single-body form is untouched, and a server or proxy that
 * does not know the media type answers it, which the reader below handles
 * without a second code path.
 *
 * ## Why nothing here throws on a failed extraction
 *
 * A failed extraction and a failed *request* are different things, and only
 * the caller knows how to present them: the failure comes back as
 * `{ status: 'failed' }` with the server's classification, so the caller can
 * choose a localized, actionable message. Only a transport fault that leaves
 * no answer at all — and an abort, which the caller owns — propagates.
 */
import { createLogger } from '@/lib/logger';
import { readArchivedExtraction, type ArchivedExtraction } from './extraction-archive-client';
import type { ExtractionFailureKind } from './extraction-failure';
import type { ExtractionProgress } from './types';

const log = createLogger('ExtractionStreamClient');

/**
 * The media type a streaming extraction request asks for. Kept in lockstep
 * with the route's own constant by construction of the protocol, not by
 * import: the route is a server module and this one is bundled into the client.
 */
export const EXTRACTION_STREAM_MEDIA_TYPE = 'application/x-ndjson';

/** The failure kinds the route can relay; anything else stays unclassified. */
const FAILURE_KINDS: ReadonlySet<string> = new Set([
  'timeout',
  'service-unavailable',
  'quota',
  'auth',
  'failed',
]);

export type ExtractionCallOutcome =
  | { status: 'ok'; data: ArchivedExtraction }
  | {
      status: 'failed';
      /** Classified cause, when the server reported one. */
      kind?: ExtractionFailureKind;
      /**
       * Handle for resuming the same remote job on the next attempt (see
       * `ExtractionFailureError.resumeToken`). Absent means "start over".
       */
      resumeToken?: string;
      /** The server's own message. Unlocalized, so a caller's last resort. */
      message?: string;
    };

export interface ExtractionStreamCallbacks {
  onProgress?: (progress: ExtractionProgress) => void;
  signal?: AbortSignal;
}

/**
 * Send one course material to the extraction route, reporting progress as it
 * arrives and resolving with the outcome.
 */
export async function requestCourseMaterialExtraction(
  formData: FormData,
  callbacks: ExtractionStreamCallbacks = {},
): Promise<ExtractionCallOutcome> {
  let response: Response;
  try {
    response = await fetch('/api/extract-document', {
      method: 'POST',
      body: formData,
      signal: callbacks.signal,
      headers: { Accept: EXTRACTION_STREAM_MEDIA_TYPE },
    });
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    log.warn('The course material extraction request could not be sent:', error);
    return { status: 'failed' };
  }

  const streaming = (response.headers.get('content-type') ?? '').includes(
    EXTRACTION_STREAM_MEDIA_TYPE,
  );
  if (!streaming || !response.body) {
    // A server that answered the plain form, or a response with no body: read
    // it as the single JSON body it is. The outcome reader does not care which
    // form the record arrived in.
    return outcomeFromBody(await readJson(response));
  }

  try {
    const result = await readStream(response.body, callbacks.onProgress);
    if (result === undefined) {
      log.warn('The course material extraction stream ended without a result record');
      return { status: 'failed' };
    }
    return outcomeFromBody(result);
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    log.warn('The course material extraction stream ended early:', error);
    return { status: 'failed' };
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

interface StreamRecord {
  type: string;
  progress?: unknown;
  body?: unknown;
}

/**
 * Read newline-delimited JSON records off a response body, handing each
 * progress record to `onProgress` and returning the `result` record's body
 * (`undefined` when the stream ended without one).
 *
 * A record is only complete once its terminator is seen, so a chunk boundary
 * that splits one is held in `buffer` until the rest arrives; the trailing
 * fragment after the last newline is still parsed, because a stream that ends
 * without a final newline is a well-formed body with a sloppy writer.
 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (progress: ExtractionProgress) => void,
): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: unknown;

  // Progress is a reporting channel: a caller's callback throwing must not
  // abort the extraction it was reporting on, so it is contained here.
  const handle = (record: StreamRecord) => {
    if (record.type === 'progress') {
      if (!onProgress) return;
      try {
        onProgress(readProgress(record.progress));
      } catch (error) {
        log.debug('A progress callback threw; the extraction continues:', error);
      }
      return;
    }
    if (record.type === 'result') result = record.body;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const record = parseRecord(buffer.slice(0, newline));
        if (record) handle(record);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    const tail = parseRecord(buffer);
    if (tail) handle(tail);
  } finally {
    reader.releaseLock();
  }

  return result;
}

function parseRecord(line: string): StreamRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof value?.type !== 'string') return null;
    return value as unknown as StreamRecord;
  } catch {
    // A malformed line is skipped rather than fatal: the result record is the
    // one thing this reader cannot do without, and it carries its own framing.
    return null;
  }
}

/**
 * Narrow an untrusted progress record; an empty object means "nothing known".
 *
 * Every field is re-derived from the wire value rather than copied, which is
 * also why this is the one place a new progress field has to be added: a field
 * the reader does not name is dropped silently — the page would simply render
 * the waiting copy forever while the server was sending a percentage.
 */
function readProgress(value: unknown): ExtractionProgress {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const completed = Number(record.completedPages);
  const total = Number(record.totalPages);
  const percent = Number(record.percent);
  return {
    ...(typeof record.stage === 'string' && record.stage ? { stage: record.stage } : {}),
    ...(Number.isFinite(completed) && completed >= 0 ? { completedPages: completed } : {}),
    ...(Number.isFinite(total) && total > 0 ? { totalPages: total } : {}),
    ...(Number.isFinite(percent) && percent > 0 && percent <= 100 ? { percent } : {}),
  };
}

/**
 * Read a result body into an outcome. A body the archive reader can narrow is
 * a success by definition (`readArchivedExtraction` requires `success: true`
 * and a text field), so there is exactly one success test, shared with the
 * archive client.
 */
function outcomeFromBody(body: unknown): ExtractionCallOutcome {
  const data = readArchivedExtraction(body);
  if (data) return { status: 'ok', data };
  if (typeof body !== 'object' || body === null) return { status: 'failed' };
  const record = body as Record<string, unknown>;
  const kind =
    typeof record.reason === 'string' && FAILURE_KINDS.has(record.reason)
      ? (record.reason as ExtractionFailureKind)
      : undefined;
  return {
    status: 'failed',
    ...(kind ? { kind } : {}),
    ...(typeof record.details === 'string' && record.details
      ? { resumeToken: record.details }
      : {}),
    ...(typeof record.error === 'string' && record.error ? { message: record.error } : {}),
  };
}
