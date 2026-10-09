import { createHash } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import {
  isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials,
  resolvePDFApiKey,
  resolvePDFBaseUrl,
} from '@/lib/server/provider-config';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import {
  documentArtifactToParsedPdfContent,
  extractMedia,
  getDocumentExtractorProvider,
  getMediaExtractorProvider,
  selectDocumentExtractorProvider,
} from '@/lib/document';
import type { MediaArtifact } from '@/lib/document';
import { isExtractionFailure } from '@/lib/document/extraction-failure';
import type { ExtractionProgress } from '@/lib/document/types';
import {
  archiveExtractionBestEffort,
  readArchivedExtractionResponseBestEffort,
} from '@/lib/document/extraction-archive';
import { normalizeDocumentMimeType, SUPPORTED_MEDIA_MIME_TYPES } from '@/lib/document/mime';
import { createLogger } from '@/lib/logger';
import {
  resolveServerAsset,
  type ServerAssetResolution,
} from '@/lib/persistence/resolve-server-asset';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import { attachOwnerCookies } from '@/lib/server/identity/with-owner';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  checkClientDocumentExtractorBaseUrl,
  checkClientMediaExtractorBaseUrl,
} from '@/lib/server/client-extractor-endpoint';
import { MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES } from '@/lib/constants/generation';

// The asset-id path resolves bytes from the server asset store, which lives in
// the PostgreSQL persistence backend; it needs the Node runtime, not the edge.
export const runtime = 'nodejs';

const log = createLogger('Extract Document');

/**
 * The media type a client names in `Accept` to get the streamed response:
 * newline-delimited JSON, zero or more `progress` records followed by one
 * `result` record. Opt-in on purpose — a client that does not ask for it keeps
 * receiving exactly the single JSON body this route has always returned, so
 * the route learning a second way to answer changes nothing for anything
 * already calling it.
 */
const EXTRACTION_STREAM_MEDIA_TYPE = 'application/x-ndjson';

/** How a running extraction reports itself, and how a caller resumes one. */
interface ExtractionHooks {
  onProgress?: (progress: ExtractionProgress) => void;
  /**
   * An opaque handle for a job an earlier attempt already submitted. Only the
   * extractor that issued it can honour it; every other extractor ignores it.
   */
  resumeToken?: string;
}

/**
 * A normalized extraction input, independent of how the bytes arrived: either
 * parsed from a multipart upload or resolved from the server asset store by
 * asset id. Both forms then run the same extractor selection below.
 */
interface ExtractSource {
  fileName: string;
  fileSize: number;
  /** Normalized canonical MIME type (see `normalizeDocumentMimeType`). */
  mimeType: string;
  buffer: Buffer;
}

/** Provider configuration fields the client already sends on both forms. */
interface ExtractRequestConfig {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
}

/** JSON body for the asset-id form: an asset id plus the same provider config. */
interface AssetIdExtractRequest extends ExtractRequestConfig {
  assetId?: string;
  fileName?: string;
  mimeType?: string;
  /** Resume handle for a job an earlier attempt already submitted. */
  resumeToken?: string;
}

/** String-only fields the JSON path accepts; wrong types are a 400, not a 500. */
const ASSET_ID_EXTRACT_STRING_FIELDS = [
  'fileName',
  'mimeType',
  'providerId',
  'apiKey',
  'baseUrl',
  'accessKeyId',
  'accessKeySecret',
  'resumeToken',
] as const;

/** Mutable logging context shared with the shared extraction helper. */
interface ExtractLogState {
  fileName?: string;
  resolvedProviderId?: string;
}

function isPdfProviderId(providerId: string): providerId is PDFProviderId {
  return providerId in PDF_PROVIDERS;
}

function supportsMimeType(
  provider: { supportedMimeTypes: readonly string[] },
  mimeType: string,
): boolean {
  return provider.supportedMimeTypes.map((type) => type.toLowerCase()).includes(mimeType);
}

/**
 * JSON-path-only pre-validation of a requested provider, run BEFORE the shared
 * extraction. The media branch stays pre-blocked, and so does an unknown
 * document provider: both answer a 400 with a generic static message that
 * never echoes the caller's provider id or MIME type, making the shared path's
 * echoing 400s unreachable from the asset-id form. A known document provider
 * that does not support the effective MIME type is NOT pre-blocked: it is a
 * hint, exactly like multipart, and the shared `runExtraction` auto-selects a
 * compatible provider (that path does not echo caller input). The multipart
 * byte form is untouched and keeps its behavior exactly.
 */
function validateJsonPathProvider(
  providerId: string | undefined,
  mimeType: string,
): NextResponse | null {
  if (!providerId) return null;
  if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
    const mediaProvider = getMediaExtractorProvider(providerId);
    if (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType)) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'The requested extractor cannot process this course material.',
      );
    }
    return null;
  }
  // Document MIME: reject only a provider that does not exist in the document
  // registry (the shared path would echo its id). A known provider that does
  // not support the MIME passes through so `runExtraction` auto-selects.
  if (!getDocumentExtractorProvider(providerId)) {
    return apiError(
      'INVALID_REQUEST',
      400,
      'The requested document extractor cannot process this course material.',
    );
  }
  return null;
}

/**
 * Flatten a MediaArtifact (transcript + keyframes + synopsis) into the
 * text-shaped ParsedPdfContent the generation pipeline consumes. Media takes
 * the same route + downstream path as documents; only the extraction differs.
 */
function mediaArtifactToText(artifact: MediaArtifact): string {
  const parts: string[] = [];

  const synopsis =
    artifact.providerRaw &&
    typeof artifact.providerRaw === 'object' &&
    'synopsis' in artifact.providerRaw
      ? String((artifact.providerRaw as { synopsis?: unknown }).synopsis ?? '')
      : '';
  if (synopsis.trim()) {
    parts.push(`## Synopsis\n\n${synopsis.trim()}`);
  }

  if (artifact.transcript?.length) {
    const lines = artifact.transcript
      .filter((seg) => seg.text?.trim())
      .map((seg) => {
        const ts = formatTimestamp(seg.startMs);
        const speaker = seg.speaker ? `${seg.speaker}: ` : '';
        return `[${ts}] ${speaker}${seg.text.trim()}`;
      });
    if (lines.length) parts.push(`## Transcript\n\n${lines.join('\n')}`);
  }

  if (artifact.keyframes?.length) {
    const lines = artifact.keyframes
      .filter((kf) => (kf.description || kf.ocrText)?.trim())
      .map((kf) => {
        const ts = formatTimestamp(kf.timeMs);
        return `[${ts}] ${(kf.description || kf.ocrText || '').trim()}`;
      });
    if (lines.length) parts.push(`## Keyframes\n\n${lines.join('\n')}`);
  }

  return parts.join('\n\n');
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  // Use HH:MM:SS once past an hour so a 75-minute video reads 01:15:03, not 75:03.
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Run extractor selection and extraction over a normalized input. Shared by
 * the multipart byte form and the asset-id form so the two paths cannot drift.
 * `isAssetIdForm` only switches the handful of messages that must stay generic
 * on the asset-id form (no caller-controlled text echoed); multipart keeps its
 * exact current messages.
 *
 * `extractionOwnerId` is the resolved owner when this deployment keeps the
 * derivation archive (`lib/persistence/material-extraction.ts`); absent means
 * no archive — either the deployment has no database or the request resolved
 * no owner. It is passed in rather than resolved here so both request forms
 * share one resolution, and so this function stays free of identity concerns.
 *
 * `hooks` carries what only this run can produce: progress while it is still
 * running, and the resume handle of the job it is working on. Both are
 * optional and both are simply forwarded to the extractor — a provider that
 * cannot report progress or resume a job ignores them, which is why no branch
 * here is needed to tell the two kinds of provider apart.
 */
async function runExtraction(
  source: ExtractSource,
  requestConfig: ExtractRequestConfig,
  logState: ExtractLogState,
  isAssetIdForm: boolean,
  extractionOwnerId: string | undefined,
  hooks: ExtractionHooks = {},
) {
  const { fileName, fileSize, mimeType, buffer } = source;
  // Hash the bytes once, and only when something will store them: the digest is
  // the stable half of the derivation key (the extractor identity is the other
  // half), so it is computed from the original bytes and never from a guess.
  const contentDigest = extractionOwnerId
    ? createHash('sha256').update(buffer).digest('hex')
    : undefined;

  // Media (audio/video) takes the media extraction path → MediaArtifact,
  // flattened to the same text shape documents produce. Same route, same
  // downstream generation path.
  if (SUPPORTED_MEDIA_MIME_TYPES.includes(mimeType)) {
    logState.resolvedProviderId = requestConfig.providerId || '';
    // Reject a document-only provider (e.g. unpdf/alidocmind) for a media upload
    // with a clear 4xx instead of forwarding it into the media registry and
    // surfacing an opaque 500.
    const mediaProvider = requestConfig.providerId
      ? getMediaExtractorProvider(requestConfig.providerId)
      : undefined;
    if (
      requestConfig.providerId &&
      (!mediaProvider || !mediaProvider.supportedMimeTypes.includes(mimeType))
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Provider "${requestConfig.providerId}" cannot extract ${mimeType}. Choose a media-capable provider (AliDocMind or local ffmpeg).`,
      );
    }
    // Derivation-cache read, conservatively: only a request that named a media
    // extractor the registry knows about has an identity that can be named
    // BEFORE extraction. Without one the provider is auto-selected from the
    // request's MIME type and its runtime availability, and a key guessed here
    // could serve a different provider's transcript — so the read is skipped
    // and the parse runs (the result is still archived below).
    if (extractionOwnerId && contentDigest && mediaProvider) {
      const cached = await readArchivedExtractionResponseBestEffort({
        ownerId: extractionOwnerId,
        contentDigest,
        extractorId: mediaProvider.id,
        extractorVersion: mediaProvider.version,
      });
      if (cached) return apiSuccess({ data: cached });
    }
    const mediaManaged =
      requestConfig.providerId !== 'local-ffmpeg' &&
      isServerConfiguredProvider('pdf', 'alidocmind');
    // When managed, resolve the server-owned AK/SK (env OR YAML) explicitly so
    // a YAML-only deployment works — the client-level env fallback reads env
    // vars only. Client-entered creds are used only when unmanaged.
    const mediaManagedCreds = mediaManaged ? resolveManagedAliDocMindCredentials() : undefined;
    let mediaClientBaseUrl = mediaManaged ? undefined : requestConfig.baseUrl || undefined;
    // A client-supplied media extractor endpoint must pass the extractor's
    // endpoint rule (see checkClientMediaExtractorBaseUrl).
    if (mediaClientBaseUrl) {
      const checked = checkClientMediaExtractorBaseUrl(mediaClientBaseUrl);
      if (!checked.ok) {
        return apiError('INVALID_URL', 403, checked.message);
      }
      mediaClientBaseUrl = checked.baseUrl;
    }
    const mediaArtifact = await extractMedia({
      buffer,
      fileName,
      fileSize,
      mimeType,
      config: {
        providerId: requestConfig.providerId || '',
        apiKey: mediaManaged ? undefined : requestConfig.apiKey || undefined,
        baseUrl: mediaManaged ? mediaManagedCreds?.baseUrl : mediaClientBaseUrl,
        accessKeyId: mediaManaged
          ? mediaManagedCreds?.accessKeyId
          : requestConfig.accessKeyId || undefined,
        accessKeySecret: mediaManaged
          ? mediaManagedCreds?.accessKeySecret
          : requestConfig.accessKeySecret || undefined,
        // Env fallback is a last resort for a managed provider whose creds
        // weren't resolved above (defensive; resolver already covers env+YAML).
        allowEnvFallback: mediaManaged,
      },
    });
    logState.resolvedProviderId =
      mediaArtifact.metadata.providerId || requestConfig.providerId || '';

    const mediaText = mediaArtifactToText(mediaArtifact);
    // An artifact with no transcript, keyframes, or synopsis carries no usable
    // content. Returning empty text as 200 would silently generate from
    // nothing — surface a parse error instead. The asset-id form uses a
    // generic static message so the caller-controlled file name is not echoed.
    if (!mediaText.trim()) {
      return apiError(
        'PARSE_FAILED',
        422,
        isAssetIdForm
          ? 'No transcript, keyframes, or synopsis could be extracted from this course material.'
          : `No transcript, keyframes, or synopsis could be extracted from "${fileName}".`,
      );
    }
    const mediaResult: ParsedPdfContent = {
      text: mediaText,
      images: [],
      metadata: {
        pageCount: 0,
        fileName,
        fileSize,
        mimeType,
        parser: mediaArtifact.metadata.providerId ?? logState.resolvedProviderId,
      },
    };
    // The effective media extractor is the one that reported the artifact, not
    // the one the request named: an auto-selected or substituted provider must
    // key its own derivation. No registry entry means no declared version, and
    // an unversioned key would silently collide across output changes, so the
    // archive is skipped instead of guessed.
    const effectiveMediaId = mediaArtifact.metadata.providerId ?? logState.resolvedProviderId;
    const mediaExtractorVersion = getMediaExtractorProvider(effectiveMediaId)?.version;
    if (extractionOwnerId && contentDigest && mediaExtractorVersion) {
      await archiveExtractionBestEffort({
        ownerId: extractionOwnerId,
        contentDigest,
        extractorId: effectiveMediaId,
        extractorVersion: mediaExtractorVersion,
        byteSize: fileSize,
        fileName,
        mimeType,
        result: mediaResult,
      });
    }
    return apiSuccess({ data: mediaResult });
  }

  let provider = requestConfig.providerId
    ? getDocumentExtractorProvider(requestConfig.providerId)
    : undefined;
  if (requestConfig.providerId && !provider) {
    return apiError(
      'INVALID_REQUEST',
      400,
      `Unknown document extractor provider: ${requestConfig.providerId}`,
    );
  }

  if (provider && !supportsMimeType(provider, mimeType)) provider = undefined;

  try {
    provider =
      provider ||
      selectDocumentExtractorProvider({
        mimeType,
        requiredCapabilities: { text: true },
      });
  } catch (error) {
    // With no provider hint and an unrecognized MIME, selection throws the
    // extractor registry's interpolated message (it carries the caller's MIME
    // type). The asset-id form must not echo caller-controlled input, so it
    // answers this catch with a generic static message; multipart keeps the
    // interpolated message byte-for-byte.
    return apiError(
      'INVALID_REQUEST',
      400,
      isAssetIdForm
        ? 'The requested document extractor cannot process this course material.'
        : error instanceof Error
          ? error.message
          : `Unsupported course material type "${mimeType}"`,
    );
  }
  logState.resolvedProviderId = provider.id;

  const managed = isPdfProviderId(provider.id) && isServerConfiguredProvider('pdf', provider.id);
  let clientBaseUrl = managed ? undefined : requestConfig.baseUrl || undefined;
  // Derivation-cache read, and deliberately BEFORE the endpoint check below:
  // `provider` is final here (auto-selection has already run), and a hit must
  // not depend on the extractor's endpoint being reachable — that is the whole
  // point of the archive. An extractor endpoint that was configured when these
  // bytes were parsed and is unreachable today still answers from its own
  // earlier result, and no request is made to the client-supplied URL, so
  // skipping its validation takes nothing away.
  if (extractionOwnerId && contentDigest) {
    const cached = await readArchivedExtractionResponseBestEffort({
      ownerId: extractionOwnerId,
      contentDigest,
      extractorId: provider.id,
      extractorVersion: provider.version,
    });
    if (cached) return apiSuccess({ data: cached });
  }
  if (clientBaseUrl) {
    const checked = await checkClientDocumentExtractorBaseUrl(provider.id, clientBaseUrl);
    if (!checked.ok) {
      return apiError('INVALID_URL', 403, checked.message);
    }
    clientBaseUrl = checked.baseUrl;
  }

  // For a managed AliDocMind provider, resolve server-owned AK/SK (env OR
  // YAML) explicitly so a YAML-only deployment extracts successfully — the
  // client-level env fallback reads env vars only.
  const managedAliCreds =
    managed && provider.id === 'alidocmind' ? resolveManagedAliDocMindCredentials() : undefined;
  const config = {
    providerId: provider.id,
    apiKey: isPdfProviderId(provider.id)
      ? resolvePDFApiKey(provider.id, managed ? undefined : requestConfig.apiKey || undefined)
      : requestConfig.apiKey || undefined,
    baseUrl: isPdfProviderId(provider.id)
      ? (managedAliCreds?.baseUrl ?? resolvePDFBaseUrl(provider.id, clientBaseUrl))
      : clientBaseUrl,
    // AliDocMind uses AK/SK: managed → server-owned creds; else client values.
    accessKeyId: managed ? managedAliCreds?.accessKeyId : requestConfig.accessKeyId || undefined,
    accessKeySecret: managed
      ? managedAliCreds?.accessKeySecret
      : requestConfig.accessKeySecret || undefined,
    // Env fallback is a last resort for a managed provider (defensive; the
    // resolver already covers env+YAML).
    allowEnvFallback: managed,
    managed,
  };

  const artifact = await provider.extract({
    buffer,
    fileName,
    fileSize,
    mimeType,
    config,
    ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
    ...(hooks.resumeToken ? { resumeToken: hooks.resumeToken } : {}),
  });
  const result = documentArtifactToParsedPdfContent(artifact);

  const resultWithMetadata: ParsedPdfContent = {
    ...result,
    metadata: {
      ...result.metadata,
      pageCount: result.metadata?.pageCount ?? 0,
      fileName,
      fileSize,
      mimeType,
      parser: result.metadata?.parser ?? provider.id,
    },
  };

  // `provider` here is the extractor that actually ran — post auto-selection —
  // so its id and version are the
  // authoritative identity half of the derivation key. The extractor's own
  // reported `metadata.parser` is NOT used for this: it is self-reported and
  // at least one provider reports a fixed label regardless of which backend
  // served the request.
  if (extractionOwnerId && contentDigest) {
    await archiveExtractionBestEffort({
      ownerId: extractionOwnerId,
      contentDigest,
      extractorId: provider.id,
      extractorVersion: provider.version,
      byteSize: fileSize,
      fileName,
      mimeType,
      result: resultWithMetadata,
    });
  }

  return apiSuccess({ data: resultWithMetadata });
}

/**
 * Whether this request asked for the streamed response. Only an explicit
 * `Accept` for the streamed media type counts, so the single-body form stays
 * the default even for a caller that sends no `Accept` at all.
 */
function acceptsExtractionStream(req: NextRequest): boolean {
  return (req.headers.get('accept') ?? '').includes(EXTRACTION_STREAM_MEDIA_TYPE);
}

/**
 * The caller's resume handle for an in-flight extraction, if it sent one.
 *
 * It is an opaque upstream id that downstream becomes one URL path segment, so
 * it is bounded and character-checked here rather than escaped later. A value
 * that does not fit is dropped, not refused: starting over is always a valid
 * answer, and a malformed handle is not worth failing an otherwise good
 * extraction request over.
 */
function readResumeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The response to a failed extraction, shared by the single-body form and the
 * streamed one (whose last record carries this same body).
 *
 * A classified failure contributes two machine-readable fields: `reason` names
 * the failure kind, and `details` carries the handle for resuming the job the
 * failure belongs to. A client uses the first to pick a localized, actionable
 * message and the second to offer continuing the job rather than starting it
 * over. Everything else keeps each form's existing behavior — the byte form
 * relays the extractor's own message, and the asset-id form answers a fixed
 * generic one because it must not echo server internals.
 */
function failureResponse(
  error: unknown,
  logState: ExtractLogState,
  isAssetIdForm: boolean,
): NextResponse {
  log.error(
    `Document extraction failed [provider=${logState.resolvedProviderId ?? 'unknown'}, file="${sanitizeLogValue(
      logState.fileName ?? 'unknown',
    )}"]:`,
    error,
  );
  const failure = isExtractionFailure(error) ? error : undefined;
  if (isAssetIdForm) {
    return apiError(
      'PARSE_FAILED',
      500,
      'The course material could not be parsed. Please try again later.',
      failure?.resumeToken,
      failure?.kind,
    );
  }
  return apiError(
    'PARSE_FAILED',
    500,
    error instanceof Error ? error.message : 'Unknown error',
    failure?.resumeToken,
    failure?.kind,
  );
}

/**
 * Run an extraction whose answer is a newline-delimited JSON stream: zero or
 * more `progress` records, then exactly one `result` record whose `body` is
 * the same JSON the single-body form would have returned.
 *
 * The status line is always 200, and that is the protocol's one real cost: a
 * failure cannot be signalled by the status, because the status is already on
 * the wire by the time the extraction can fail. It rides the final record's
 * `success: false` instead — which is the very thing the client already checks
 * on the single-body form, so one reader consumes both.
 *
 * A client that disconnects mid-stream does not cancel the extraction. It must
 * not: finishing is what archives the derivation server-side, so the run goes
 * on and only the reporting stops.
 */
function streamExtraction(
  context: { logState: ExtractLogState; isAssetIdForm: boolean },
  run: (report: (progress: ExtractionProgress) => void) => Promise<Response>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (record: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
        } catch {
          open = false;
        }
      };
      try {
        const response = await run((progress) => send({ type: 'progress', progress }));
        send({ type: 'result', body: await response.json() });
      } catch (error) {
        send({
          type: 'result',
          body: await failureResponse(error, context.logState, context.isAssetIdForm).json(),
        });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // The stream was cancelled; there is nothing to close.
        }
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': EXTRACTION_STREAM_MEDIA_TYPE,
      'Cache-Control': 'no-store',
      // A proxy that buffers by default would defeat the point of streaming.
      'X-Accel-Buffering': 'no',
    },
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const ownerCookies: OwnerCookies = {};
  // The asset-id form resolves the request owner: every answer after that,
  // success or error, carries the resolution's cookies (the anonymous
  // owner's renewal).
  return attachOwnerCookies(await extract(req, ownerCookies), ownerCookies.setCookies);
}

/** Filled in once the asset-id form has resolved the request owner. */
interface OwnerCookies {
  setCookies?: readonly string[];
}

async function extract(req: NextRequest, ownerCookies: OwnerCookies): Promise<Response> {
  const logState: ExtractLogState = {};
  // Whether this request took the asset-id (JSON) form. The multipart byte
  // form's observable behavior is frozen; a few JSON-path-only responses use
  // this to stay generic (no caller input or raw extractor text echoed).
  let isAssetIdForm = false;
  // Whether this request asked for the streamed answer instead of a single
  // body, and the resume handle it offered, if any.
  const streaming = acceptsExtractionStream(req);
  let resumeToken: string | undefined;
  try {
    const contentType = req.headers.get('content-type') || '';
    let source: ExtractSource;
    let requestConfig: ExtractRequestConfig;

    if (contentType.includes('multipart/form-data')) {
      // Legacy byte form: the client uploads the original bytes, used by
      // browser-backed (self-deploy) pools where the server cannot resolve a
      // browser-side asset.
      const formData = await req.formData();
      const documentFile = (formData.get('file') || formData.get('pdf')) as File | null;
      resumeToken = readResumeToken(formData.get('resumeToken'));
      requestConfig = {
        providerId: (formData.get('providerId') as string | null) ?? undefined,
        apiKey: (formData.get('apiKey') as string | null) ?? undefined,
        baseUrl: (formData.get('baseUrl') as string | null) ?? undefined,
        accessKeyId: (formData.get('accessKeyId') as string | null) ?? undefined,
        accessKeySecret: (formData.get('accessKeySecret') as string | null) ?? undefined,
      };

      if (!documentFile) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No course material file provided');
      }

      logState.fileName = documentFile.name;
      const mimeType = normalizeDocumentMimeType({
        mimeType: documentFile.type,
        fileName: documentFile.name,
      });
      if (!mimeType) {
        return apiError(
          'INVALID_REQUEST',
          400,
          `Unsupported course material type for "${documentFile.name}"`,
        );
      }
      if (documentFile.size > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      source = {
        fileName: documentFile.name,
        fileSize: documentFile.size,
        mimeType,
        buffer: Buffer.from(await documentFile.arrayBuffer()),
      };
    } else if (contentType.includes('application/json')) {
      // Asset-id form: the client names the pool asset allocated at upload and
      // the server resolves the bytes from the server asset store. Only used
      // when the deployment's pool is server-backed; the browser-backed
      // client never sends this shape.
      isAssetIdForm = true;
      let body: AssetIdExtractRequest;
      try {
        body = (await req.json()) as AssetIdExtractRequest;
      } catch {
        return apiError('INVALID_REQUEST', 400, 'Invalid JSON body for asset-id extraction.');
      }

      // A parsed JSON body that is not a plain object (null, array, string,
      // number) must not fall through to field access — that would throw a raw
      // TypeError before the first guard. It is a malformed request, not a
      // server error; the message stays generic and static.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return apiError('INVALID_REQUEST', 400, 'Invalid request body for asset-id extraction');
      }

      // Validate the body's field types before use: a wrong-typed field is a
      // malformed request, not a server error. The 400 stays generic — never
      // echo the offending value back to the caller.
      if (typeof body.assetId !== 'string' || body.assetId.length === 0) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'No asset id provided');
      }
      for (const field of ASSET_ID_EXTRACT_STRING_FIELDS) {
        const value = (body as unknown as Record<string, unknown>)[field];
        if (value !== undefined && typeof value !== 'string') {
          return apiError('INVALID_REQUEST', 400, 'Invalid request body for asset-id extraction');
        }
      }

      let resolution: ServerAssetResolution;
      try {
        resolution = await resolveServerAsset(
          body.assetId,
          req,
          MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES,
        );
        ownerCookies.setCookies = resolution.setCookies;
      } catch (error) {
        // A failure from the server asset store (DB outage, registry failure)
        // must not reach the client as raw `error.message`; log the real error
        // server-side only and answer a fixed generic 500.
        log.error('Failed to resolve course material asset from the server store:', error);
        return apiError(
          'INTERNAL_ERROR',
          500,
          'The server asset store is unavailable. Please try again later.',
        );
      }
      if (resolution.status === 'unconfigured') {
        return apiError(
          'INVALID_REQUEST',
          503,
          'Server persistence is not configured; asset-id extraction requires a server-backed asset pool.',
        );
      }
      if (resolution.status === 'unauthenticated') {
        return apiError(
          'UNAUTHENTICATED',
          401,
          'Asset-id extraction requires a valid owner credential.',
        );
      }
      if (resolution.status === 'missing') {
        return apiError(
          'ASSET_NOT_FOUND',
          404,
          'No course material asset was found for the requested asset id.',
        );
      }
      if (resolution.status === 'too_large') {
        // The asset store reported the recorded byte length above the cap
        // before materializing the bytes; reject without ever reading them.
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      // The client carries the original display name and normalized MIME type
      // in the session; the asset store records only the blob MIME type, so
      // the request values win and the recorded type is the fallback.
      const fileName = body.fileName || 'document';
      logState.fileName = fileName;
      const mimeType = normalizeDocumentMimeType({
        mimeType: body.mimeType ?? resolution.mimeType,
        fileName,
      });
      if (!mimeType) {
        return apiError('INVALID_REQUEST', 400, 'Unsupported course material type.');
      }
      // JSON-path-only pre-validation: an unknown provider (or a provider that
      // cannot handle a media MIME) is pre-blocked with a generic 400 — the
      // shared path's echoing 400s for these cases are unreachable from the
      // asset-id form. A known document provider that does not support the MIME
      // is passed through as a hint, exactly like multipart (see
      // `validateJsonPathProvider`); multipart keeps its behavior exactly.
      const providerValidationError = validateJsonPathProvider(body.providerId, mimeType);
      if (providerValidationError) return providerValidationError;
      if (resolution.buffer.length > MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES) {
        return apiError(
          'INVALID_REQUEST',
          413,
          `Course material file is too large. Maximum size is ${Math.floor(
            MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES / 1024 / 1024,
          )}MB.`,
        );
      }

      source = {
        fileName,
        fileSize: resolution.buffer.length,
        mimeType,
        buffer: resolution.buffer,
      };
      requestConfig = {
        providerId: body.providerId,
        apiKey: body.apiKey,
        baseUrl: body.baseUrl,
        accessKeyId: body.accessKeyId,
        accessKeySecret: body.accessKeySecret,
      };
      resumeToken = readResumeToken(body.resumeToken);
    } else {
      log.error('Invalid Content-Type for document upload:', contentType);
      return apiError(
        'INVALID_REQUEST',
        400,
        `Invalid Content-Type: expected multipart/form-data or application/json, got "${contentType}"`,
      );
    }

    const extractionOwnerId = await resolveExtractionOwnerId(req, ownerCookies);
    const hooks: ExtractionHooks = { ...(resumeToken ? { resumeToken } : {}) };
    if (streaming) {
      // The stream is the response: the extraction runs inside it, reporting
      // as it goes and writing its outcome (success or failure) into the final
      // record, because by then the status line has already been sent.
      return streamExtraction({ logState, isAssetIdForm }, (report) =>
        runExtraction(source, requestConfig, logState, isAssetIdForm, extractionOwnerId, {
          ...hooks,
          onProgress: report,
        }),
      );
    }
    return await runExtraction(
      source,
      requestConfig,
      logState,
      isAssetIdForm,
      extractionOwnerId,
      hooks,
    );
  } catch (error) {
    return failureResponse(error, logState, isAssetIdForm);
  }
}

/**
 * Resolve the owner whose derivation archive this extraction belongs to.
 *
 * Deliberately best-effort, and best-effort for a specific reason: extraction
 * has never required an owner, and it must not start to. A deployment whose
 * anonymous fallback is off, or whose identity resolution fails, still gets
 * the parse it asked for — it simply gets no archive row. The multipart byte
 * form is what makes this rule necessary: the asset-id form already answers
 * 401 when it cannot resolve an owner, but multipart is the browser-backed
 * path and has always worked without one.
 *
 * The resolution is the request's own (memoized in `resolveRequestOwner`), so
 * the asset-id form's earlier resolution is reused rather than repeated, and
 * any cookies it minted ride the response exactly as before.
 */
async function resolveExtractionOwnerId(
  req: NextRequest,
  ownerCookies: OwnerCookies,
): Promise<string | undefined> {
  if (!process.env.DATABASE_URL?.trim()) return undefined;
  try {
    const outcome = await resolveRequestOwner(req);
    if (!outcome.ok) return undefined;
    if (outcome.setCookies?.length) ownerCookies.setCookies = outcome.setCookies;
    return outcome.principal.ownerId;
  } catch (error) {
    log.warn('Could not resolve the owner for the extraction archive:', error);
    return undefined;
  }
}

/** Strip line-breaking control characters from caller-controlled log values. */
function sanitizeLogValue(value: string): string {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ');
}
