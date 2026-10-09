/**
 * AliDocMind (Aliyun DocMind) shared client.
 *
 * Handles the submit → poll → get flow shared by:
 *   - lib/pdf/pdf-providers.ts       (file-mode: layouts[] → ParsedPdfContent)
 *   - lib/media-parse/media-parse-providers.ts (media-mode: segments[] → MediaArtifact)
 *
 * The job is remote and long-running, so this module is also where the two
 * things a waiting person needs come from: a progress report while the job runs
 * (the status API publishes its own percentage) and a resume handle when it
 * fails (`resumeToken` = the job id, which the service keeps queryable for 24
 * hours after the job ends).
 *
 * Docs: https://help.aliyun.com/zh/document-mind/developer-reference/document-parsing-large-model-version
 */

import { Readable } from 'stream';
import Client, * as $Docmind from '@alicloud/docmind-api20220711';
import { Config } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';
import { createLogger } from '@/lib/logger';
import { ALIDOCMIND_DEFAULT_BASE } from '@/lib/pdf/constants';
import {
  ExtractionFailureError,
  normalizeResumeToken,
  type ExtractionFailureKind,
} from '@/lib/document/extraction-failure';
import type { ExtractionProgress } from '@/lib/document/types';

const log = createLogger('AliDocMind');

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_MS = 15 * 60 * 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fixed verification messages: SDK and service error text stays in the log.
const PROBE_REJECTED_MESSAGE =
  'AliDocMind rejected the request, please check that the AccessKey has DocMind permission';
const PROBE_FAILED_MESSAGE =
  'Could not verify with AliDocMind, please check the AccessKey ID/Secret and endpoint';

export interface AliDocMindCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  endpoint?: string;
  /**
   * Allow falling back to ALIDOCMIND_ACCESS_KEY_ID/SECRET env vars when the
   * caller supplies no AK/SK. Defaults to false so an unauthenticated client
   * request cannot silently run on the server's Aliyun account. Set true only
   * in a server-managed/trusted context (or local dev/tests via env).
   */
  allowEnvFallback?: boolean;
}

export interface AliDocMindSubmitOptions {
  buffer: Buffer;
  fileName: string;
  /** Extension without dot, e.g. 'pdf', 'mp4'. If omitted, inferred from fileName. */
  fileNameExtension?: string;
  /** Enable LLM-based layout/OCR enhancement (file mode). */
  llmEnhancement?: boolean;
  /** 'VLM' to use multimodal LLM for layout analysis (file mode). */
  enhancementMode?: 'VLM';
  /** 'base' (default) or 'advance' (adds synopsis for media). */
  option?: 'base' | 'advance';
  /** Media-only: extra parameters. */
  multimediaParameters?: {
    enableSynopsisParse?: boolean;
    vlParsePrompt?: string;
  };
  outputHtmlTable?: boolean;
}

export interface AliDocMindResult {
  jobId: string;
  data: Record<string, unknown>;
  paragraphCount?: number;
  pageCountEstimate?: number;
  imageCount?: number;
  tableCount?: number;
  tokens?: number;
}

function resolveCredentials(creds: Partial<AliDocMindCredentials>): AliDocMindCredentials {
  const allowEnv = creds.allowEnvFallback ?? false;
  const accessKeyId =
    creds.accessKeyId || (allowEnv ? process.env.ALIDOCMIND_ACCESS_KEY_ID : undefined);
  const accessKeySecret =
    creds.accessKeySecret || (allowEnv ? process.env.ALIDOCMIND_ACCESS_KEY_SECRET : undefined);
  if (!accessKeyId || !accessKeySecret) {
    // A missing credential is an auth failure by definition: the caller has to
    // supply a key, and no retry of this request can.
    throw new ExtractionFailureError(
      'AliDocMind credentials missing: provide accessKeyId + accessKeySecret',
      { kind: 'auth' },
    );
  }
  const endpoint = (creds.endpoint || ALIDOCMIND_DEFAULT_BASE).replace(/^https?:\/\//, '');
  return { accessKeyId, accessKeySecret, endpoint };
}

function createClient(creds: AliDocMindCredentials): Client {
  const config = new Config({
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    endpoint: creds.endpoint,
  });
  return new Client(config);
}

function inferExtension(fileName: string, explicit?: string): string {
  if (explicit) return explicit.replace(/^\./, '').toLowerCase();
  const ext = fileName.split('.').pop();
  if (!ext || ext === fileName) throw new Error(`Cannot infer file extension from "${fileName}"`);
  return ext.toLowerCase();
}

// ── Run options ───────────────────────────────────────────────────────────────

/**
 * Options that shape one parse run without changing what it parses.
 */
export interface AliDocMindParseOptions {
  /** Called whenever the service reports a new stage or a new percentage. */
  onProgress?: (progress: ExtractionProgress) => void;
  /**
   * The job id of an earlier attempt whose document is already queued. When
   * present, the run skips submission and polls that job directly: the bytes
   * are already with the service, so re-submitting them would pay for a second
   * parse of the same document while the first one may still be running.
   */
  resumeJobId?: string;
}

// ── Failure classification ────────────────────────────────────────────────────

/**
 * Map the service's own error code and message onto the failure vocabulary.
 *
 * Deliberately narrow, for the same reason as the other providers: the SDK
 * signals most conditions with prose, so only unambiguous phrases are named and
 * anything unrecognised stays `failed`. Sending someone to wait out an outage
 * that is really a rejected key costs them the one remedy that would have
 * worked.
 *
 * The codes recognised here are the gateway's documented common ones —
 * `Throttling*`, `InvalidAccessKeyId.NotFound`, `SignatureDoesNotMatch`,
 * `Forbidden`, `NoPermission`, `SecurityToken*`, `ServiceUnavailable`,
 * `InternalError` — matched case-insensitively, since the same condition is
 * spelled `NoPermission` in a body and `noPermission` in other places.
 */
function classifyAliDocMindFailure(code: unknown, message: unknown): ExtractionFailureKind {
  const codeText = code === undefined || code === null ? '' : String(code);
  const messageText = typeof message === 'string' ? message : '';
  const haystack = `${codeText} ${messageText}`.toLowerCase();
  // Out of quota, rate-limited, or an account in arrears. Re-issuing this
  // request changes nothing; the account or the moment has to.
  if (/throttl|quota|rate.?limit|too many requests|limitexceed|arrears|欠费|额度/.test(haystack)) {
    return 'quota';
  }
  // The service refused us: a mistyped AK/SK, a key without DocMind permission
  // (an OSS-only key), an expired security token, or a credential that was
  // never supplied. Every one of them is fixed in the settings, not by retrying.
  if (
    /invalidaccesskeyid|signaturedoesnotmatch|forbidden|unauthorized|nopermission|not authorized|securitytoken|accesskey|credential/.test(
      haystack,
    )
  ) {
    return 'auth';
  }
  // Reachable but not serving: retrying later is the only remedy.
  if (/serviceunavailable|internalerror|unavailable|server error/.test(haystack)) {
    return 'service-unavailable';
  }
  return 'failed';
}

/**
 * Give a failure a classification, and the resume handle when a job had already
 * been submitted.
 *
 * The SDK's own thrown errors arrive unclassified, carrying their condition in
 * `code` and `message` — which is exactly what the classifier reads, so they go
 * through the same funnel as the ones this module raises.
 */
function toExtractionFailure(error: unknown, resumeToken?: string): unknown {
  if (error instanceof ExtractionFailureError) {
    if (error.resumeToken || !resumeToken) return error;
    return new ExtractionFailureError(error.message, {
      kind: error.kind,
      resumeToken,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return new ExtractionFailureError(message, {
    kind: classifyAliDocMindFailure(code, message),
    ...(resumeToken ? { resumeToken } : {}),
    cause: error,
  });
}

/** Report progress, containing a reporter's failure: it must not break the run. */
function reportProgress(
  onProgress: AliDocMindParseOptions['onProgress'],
  progress: ExtractionProgress,
): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch (error) {
    log.warn('[AliDocMind] A progress reporter threw; the extraction continues:', error);
  }
}

/**
 * The business codes meaning "that id is not here": a job that never existed, or
 * one whose result has aged out of the 24-hour window. Distinct from a refused
 * request — the service understood us perfectly, it simply has nothing for that
 * id — which is why the same codes are also the signal that a credential probe
 * reached the service at all (see {@link verifyAliDocMindCredentials}).
 */
function isUnknownJobCode(codeLower: string): boolean {
  return codeLower.includes('bizidnotexist') || codeLower.includes('resultexpired');
}

// ── Progress from the status API ──────────────────────────────────────────────

/**
 * What the status API publishes while a job runs.
 *
 * `processing` — the service's own percentage of the file — is the progress
 * signal and is carried as itself.
 *
 * `numberOfSuccessfulParsing` is deliberately NOT read: the API documents it as
 * the number of successfully parsed *modules*, not pages, so presenting it as a
 * page counter would be a fabrication that also never reaches its total, since
 * the module count and the page count are different quantities.
 */
function readAliDocMindProgress(data: {
  processing?: unknown;
  pageCountEstimate?: unknown;
}): Pick<ExtractionProgress, 'percent' | 'totalPages'> {
  const processing = Number(data.processing);
  const pageCountEstimate = Number(data.pageCountEstimate);
  return {
    // A job that has not started reports 0. That is "queued", not "0% done",
    // and the caller's waiting copy says so better than a zero would.
    ...(Number.isFinite(processing) && processing > 0 && processing <= 100
      ? { percent: processing }
      : {}),
    // The estimate is a 0-based page count (a 14-page document reports 13, per
    // the adapter that consumes it), and an estimate of 0 cannot be told apart
    // from "not measured yet" — in doubt, report nothing rather than a count
    // that may be wrong.
    ...(Number.isFinite(pageCountEstimate) && pageCountEstimate > 0
      ? { totalPages: pageCountEstimate + 1 }
      : {}),
  };
}

// ── Submit ────────────────────────────────────────────────────────────────────

/**
 * Submit the document and return the job id.
 *
 * A failure here is deliberately not resumable: no job exists yet, so a token
 * would name nothing — the next attempt has to start over regardless of what it
 * was given.
 */
async function submitJob(client: Client, options: AliDocMindSubmitOptions): Promise<string> {
  const fileNameExtension = inferExtension(options.fileName, options.fileNameExtension);

  const request = new $Docmind.SubmitDocParserJobAdvanceRequest({
    fileName: options.fileName,
    fileNameExtension,
    fileUrlObject: Readable.from(options.buffer),
    llmEnhancement: options.llmEnhancement,
    enhancementMode: options.enhancementMode,
    option: options.option,
    outputHtmlTable: options.outputHtmlTable,
    multimediaParameters: options.multimediaParameters
      ? new $Docmind.SubmitDocParserJobAdvanceRequestMultimediaParameters(
          options.multimediaParameters,
        )
      : undefined,
  });

  const runtime = new RuntimeOptions({
    // Large files need generous read/connect timeouts (default is 3s which
    // fails on multi-MB uploads to the OSS presigned URL).
    connectTimeout: 30_000,
    readTimeout: 5 * 60_000,
  });
  log.info(`Submitting ${options.fileName} (${options.buffer.byteLength} bytes)`);

  try {
    const submitRes = await client.submitDocParserJobAdvance(request, runtime);
    const jobId = submitRes.body?.data?.id;
    if (!jobId) {
      throw new ExtractionFailureError(
        `AliDocMind submit returned no job id: ${JSON.stringify(submitRes.body)}`,
        { kind: 'failed' },
      );
    }
    log.info(`Job ${jobId} submitted, polling…`);
    return jobId;
  } catch (error) {
    throw toExtractionFailure(error);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/** Submit a parse job, poll until done, return the raw `data` map. */
export async function parseWithAliDocMindClient(
  creds: Partial<AliDocMindCredentials>,
  options: AliDocMindSubmitOptions,
  run: AliDocMindParseOptions = {},
): Promise<AliDocMindResult> {
  const resolved = resolveCredentials(creds);
  const client = createClient(resolved);

  const resumeJobId = normalizeResumeToken(run.resumeJobId);
  let jobId: string;
  if (resumeJobId) {
    jobId = resumeJobId;
    log.info(`Job ${jobId} resumed for ${options.fileName} (no upload)`);
  } else {
    jobId = await submitJob(client, options);
  }

  const deadline = Date.now() + POLL_MAX_MS;
  let lastStatus = '';
  // Most polls report nothing new, and the caller renders whatever the last
  // reported progress says and nothing else, so only a change is worth
  // reporting.
  let lastProgressKey = '';

  while (Date.now() < deadline) {
    let statusRes: Awaited<ReturnType<Client['queryDocParserStatus']>>;
    try {
      statusRes = await client.queryDocParserStatus(
        new $Docmind.QueryDocParserStatusRequest({ id: jobId }),
      );
    } catch (error) {
      // The document is already with the service, so this failure is resumable.
      throw toExtractionFailure(error, jobId);
    }
    // A body-level error (NoPermission, throttling, expired job, …) carries a
    // non-benign code and often no status — surface it now instead of polling
    // for the full timeout waiting for a status that will never arrive. Treat
    // success-shaped codes as benign (matches verifyAliDocMindCredentials) so a
    // `code: "success"`/"200" response isn't misread as a fatal error.
    const code = statusRes.body?.code;
    if (code !== undefined && code !== null) {
      const lower = String(code).toLowerCase();
      const benign = lower === '200' || lower === 'success';
      if (!benign) {
        // The service's own wording goes to the log; the caller gets a class.
        log.warn(
          `Job ${jobId} status query rejected [code=${code}]: ${statusRes.body?.message ?? ''}`,
        );
        throw new ExtractionFailureError(`AliDocMind status query failed (code ${code})`, {
          kind: classifyAliDocMindFailure(code, statusRes.body?.message),
          // A handle the service says it does not have must not travel with the
          // failure: the caller keeps a handle it is given and hands it back on
          // the next attempt, so an unknown job would fail instantly, forever,
          // each failure re-arming the next. Withholding it costs one wasted
          // attempt and the retry after that starts clean.
          ...(isUnknownJobCode(lower) ? {} : { resumeToken: jobId }),
        });
      }
    }
    const data = statusRes.body?.data;
    const status = (data?.status ?? '').toLowerCase();
    if (status && status !== lastStatus) {
      log.info(`Job ${jobId} → ${status}`);
      lastStatus = status;
    }

    const progress = readAliDocMindProgress(data ?? {});
    const progressKey = `${status}|${progress.percent ?? ''}|${progress.totalPages ?? ''}`;
    if (progressKey !== lastProgressKey) {
      lastProgressKey = progressKey;
      reportProgress(run.onProgress, { ...(status ? { stage: status } : {}), ...progress });
    }

    if (status === 'fail' || status === 'failed') {
      log.warn(`Job ${jobId} failed: ${statusRes.body?.message ?? ''}`);
      // Resumable, like the other providers: a retry that resumes a job the
      // service already terminated fails immediately and visibly, instead of
      // queueing a fresh copy of the same document behind the same wall.
      throw new ExtractionFailureError('AliDocMind parsing failed', {
        kind: classifyAliDocMindFailure(undefined, statusRes.body?.message),
        resumeToken: jobId,
      });
    }
    if (status === 'success') {
      let result: Record<string, unknown>;
      try {
        result = await fetchResult(client, jobId);
      } catch (error) {
        // The parse itself succeeded; only the hand-over failed. Resuming polls
        // the finished job again and re-reads the result, at no parsing cost.
        throw toExtractionFailure(error, jobId);
      }
      return {
        jobId,
        data: result,
        paragraphCount: data?.paragraphCount,
        pageCountEstimate: data?.pageCountEstimate,
        imageCount: data?.imageCount,
        tableCount: data?.tableCount,
        tokens: data?.tokens,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  log.warn(`Job ${jobId} timed out`);
  throw new ExtractionFailureError(
    `AliDocMind job ${jobId} timed out after ${POLL_MAX_MS / 1000}s`,
    {
      kind: 'timeout',
      resumeToken: jobId,
    },
  );
}

async function fetchResult(client: Client, jobId: string): Promise<Record<string, unknown>> {
  const STEP = 100;
  const merged: {
    layouts?: unknown[];
    segments?: unknown[];
    synopsis_result?: string;
    [k: string]: unknown;
  } = {};
  let layoutNum = 0;

  while (true) {
    const res = await client.getDocParserResult(
      new $Docmind.GetDocParserResultRequest({
        id: jobId,
        layoutNum,
        layoutStepSize: STEP,
      }),
    );

    // Surface a real API error instead of silently returning empty text.
    // A success job whose result call errors (throttling, expired result,
    // permission) must not look like "extracted nothing".
    const code = res.body?.code;
    if (code !== undefined && code !== null && String(code) !== '200') {
      log.warn(
        `getDocParserResult rejected [code=${code}]: ${res.body?.message ?? ''} (job ${jobId})`,
      );
      throw new ExtractionFailureError(`AliDocMind getDocParserResult failed (code ${code})`, {
        kind: classifyAliDocMindFailure(code, res.body?.message),
      });
    }

    const data = (res.body?.data ?? {}) as Record<string, unknown>;

    const layouts = Array.isArray(data.layouts) ? (data.layouts as unknown[]) : [];
    const segments = Array.isArray(data.segments) ? (data.segments as unknown[]) : [];

    if (layouts.length === 0 && segments.length === 0 && layoutNum > 0) break;

    if (layouts.length) merged.layouts = (merged.layouts ?? []).concat(layouts);
    if (segments.length) merged.segments = (merged.segments ?? []).concat(segments);

    // pass through top-level scalar fields once
    for (const [k, v] of Object.entries(data)) {
      if (k === 'layouts' || k === 'segments') continue;
      if (merged[k] === undefined) merged[k] = v;
    }

    // Media results (segments[]) are not paginated by layoutNum/layoutStepSize —
    // those params address layout blocks. Re-requesting with an advanced offset
    // would return the same segments and loop until the safety cap. Stop after
    // the first page whenever segments are present.
    if (segments.length) break;

    if (layouts.length < STEP) break;
    layoutNum += layouts.length;
    if (layoutNum > 100_000) {
      log.warn(`AliDocMind result exceeded 100k blocks, truncating`);
      break;
    }
  }

  return merged;
}

/**
 * Verify AliDocMind credentials without submitting a real job.
 *
 * Probes with a bogus job id. Empirically (docmind-api.cn-hangzhou):
 *   - creds with DocMind access → the SDK does NOT throw and the response body
 *     carries `code: "BizIdNotExistOrResultExpired"` (auth + DocMind permission
 *     are fine; only the bogus job id is rejected).
 *   - creds WITHOUT DocMind permission → also no throw, but the body carries
 *     `code: "NoPermission"` (OSS-only keys hit this).
 *   - invalid AK/SK → the SDK throws (`InvalidAccessKeyId.NotFound`,
 *     `SignatureDoesNotMatch`, `Forbidden`, …).
 *
 * We accept ONLY a positive signal: a success/200 body, or the explicit
 * job-not-found/expired business code. Every other body code (NoPermission,
 * throttling, …), any thrown error, an unreachable endpoint, or a localized
 * message we can't parse is reported as a failure — so an OSS-only key or a
 * mistyped endpoint can never show "connection successful".
 */
export async function verifyAliDocMindCredentials(
  creds: Partial<AliDocMindCredentials>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const resolved = resolveCredentials(creds);
  const client = createClient(resolved);
  try {
    const res = await client.queryDocParserStatus(
      new $Docmind.QueryDocParserStatusRequest({ id: 'verify-connection-probe' }),
    );
    // No throw = authenticated, but the body may still carry a permission or
    // business error. Only an explicit positive signal proves DocMind is usable
    // with these credentials — the probe uses a bogus job id, so a working key
    // always returns the job-not-found business code (or a 200/success). An
    // empty/absent code (malformed or custom endpoint) is NOT accepted.
    const code = res.body?.code;
    const codeStr = code === undefined || code === null ? '' : String(code);
    const lower = codeStr.toLowerCase();
    const isProbeOk = codeStr === '200' || isUnknownJobCode(lower) || lower === 'success';
    if (isProbeOk) {
      return { ok: true };
    }
    log.warn(`Credential probe rejected [code=${codeStr || 'empty'}]: ${res.body?.message ?? ''}`);
    return {
      ok: false,
      error: codeStr
        ? PROBE_REJECTED_MESSAGE
        : 'AliDocMind returned an unrecognized response (empty status code)',
    };
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : '';
    const msg = err instanceof Error ? err.message : String(err);
    // A thrown "job not found" business error still proves creds + endpoint are
    // good (the request authenticated; only the bogus id was rejected).
    const lower = `${code} ${msg}`.toLowerCase();
    const isBizNotFound =
      lower.includes('bizidnotexist') ||
      lower.includes('does not exist') ||
      lower.includes('resultexpired') ||
      lower.includes('result is expired');
    if (isBizNotFound) {
      return { ok: true };
    }
    // The SDK error (service code, transport errno, TLS or timeout detail) is
    // logged only; the caller gets one fixed message.
    log.warn(`Credential probe failed [code=${code || 'none'}]: ${msg}`);
    return { ok: false, error: PROBE_FAILED_MESSAGE };
  }
}
