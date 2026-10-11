/**
 * CosyVoice voice enrollment + synthesis (Alibaba Cloud Bailian / DashScope).
 *
 * CosyVoice is a DIFFERENT API contract from Qwen-TTS on the same
 * `/services/audio/tts/customization` endpoint:
 *
 *   Qwen-TTS line     model `qwen-voice-enrollment` · action `create` · audio
 *                     inlined as base64 in `audio.data` · transcript REQUIRED
 *   CosyVoice line    model `voice-enrollment` · action `create_voice` · audio
 *                     inlined in the `url` field as a data URI · NO transcript
 *
 * The `url` field also accepts a plain public `https://` URL, so a caller with
 * publicly reachable audio can skip inlining entirely. Inlining is the default
 * because it needs no extra hosting.
 *
 * ⚠️ The MIME prefix of an inlined data URI is NOT cosmetic — it decides
 * whether the request is accepted. Measured against the live endpoint:
 *
 *   data:audio/mp3;base64,<real speech mp3>   → accepted
 *   data:audio/mpeg;base64,<real speech mp3>  → rejected (ASR 400)
 *   data:audio/wav;base64,<...>               → rejected (ASR 400)
 *   <bare base64, no prefix>                  → rejected ("should start with
 *                                                http or https")
 *
 * `audio/mpeg` and `audio/mp3` differ by one character and behave oppositely.
 * Hence `INLINE_AUDIO_MIME`, and the `toCosyVoiceAudioSource` helper below,
 * which renames the MIME to the one the endpoint actually accepts.
 *
 * ⚠️ Content is gated too: a clip of pure tone or silence is refused
 * (`Audio.AudioShortError` / `Audio.AudioSilentError`), because the endpoint
 * runs the sample through ASR as a sanity check. It must be real speech.
 *
 * Synthesis uses a different path again (`/services/audio/tts/SpeechSynthesizer`,
 * NOT the multimodal-generation endpoint Qwen uses) and returns
 * `output.audio.data` — the audio bytes inline as base64 — alongside an OSS
 * `url`. We prefer `data` and only fall back to downloading `url`.
 */

import type { TTSGenerationResult } from '@/lib/audio/tts-providers';
import {
  audioEndpointPolicy,
  audioProviderFetch,
  resolveAllowLocalNetworks,
  type AudioEndpointTarget,
} from '@/lib/server/audio-provider-fetch';
import {
  findUnsafeNetworkTargetError,
  UnsafeNetworkTargetError,
  validateUrlForSSRFWithPolicy,
} from '@/lib/server/ssrf-guard';

export const COSYVOICE_ENROLLMENT_MODEL = 'voice-enrollment';
export const DEFAULT_COSYVOICE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
/** Enrollment (clip upload / status / delete). Shared host path, NOT the Qwen path. */
const ENROLLMENT_PATH = '/api/v1/services/audio/tts/customization';
/** Synthesis. CosyVoice does not speak the multimodal-generation endpoint. */
const SYNTHESIS_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/**
 * The data-URI MIME the endpoint actually accepts for inlined enrollment audio.
 *
 * Measured: `audio/mp3` is accepted, `audio/mpeg` and `audio/wav` are refused
 * with `request asr failed, http code: 400` even for byte-identical payloads.
 */
export const INLINE_AUDIO_MIME = 'audio/mp3';

const REQUEST_TIMEOUT_MS = 30_000;
const AUDIO_DOWNLOAD_TIMEOUT_MS = 30_000;
const SYNTHESIS_DEADLINE_MS = 24_000;
const MAX_AUDIO_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Enrollment payload budget. DashScope caps the inlined clip well below this. */
const MAX_INLINE_AUDIO_BYTES = 10 * 1024 * 1024;

export type CosyVoiceErrorCode =
  | 'COSYVOICE_CONFIG_MISSING'
  | 'COSYVOICE_ENDPOINT_INVALID'
  | 'COSYVOICE_HTTP_ERROR'
  | 'COSYVOICE_TIMEOUT'
  | 'COSYVOICE_TRANSPORT_ERROR'
  | 'COSYVOICE_RESPONSE_JSON_INVALID'
  | 'COSYVOICE_RESPONSE_VOICE_MISSING'
  | 'COSYVOICE_RESPONSE_AUDIO_MISSING'
  | 'COSYVOICE_AUDIO_URL_INVALID'
  | 'COSYVOICE_AUDIO_DOWNLOAD_FAILED'
  | 'COSYVOICE_AUDIO_TOO_LARGE'
  | 'COSYVOICE_AUDIO_EMPTY'
  | 'COSYVOICE_AUDIO_TOO_LONG'
  | 'COSYVOICE_VOICE_NOT_FOUND'
  | 'COSYVOICE_VOICE_NOT_READY'
  | 'COSYVOICE_BOOTSTRAP_UNSUPPORTED';

export class CosyVoiceError extends Error {
  constructor(
    readonly code: CosyVoiceErrorCode,
    readonly httpStatus?: number,
    readonly vendorCode?: string,
    /** The provider's own rejection reason, captured from `message`. */
    readonly vendorMessage?: string,
    /** Which provider call failed; set by `postJson`, absent for local validation. */
    readonly operation?: CosyVoiceOperation,
  ) {
    super(vendorMessage ? `${code}: ${vendorMessage}` : code);
    this.name = 'CosyVoiceError';
  }
}

export interface CosyVoiceConfig {
  apiKey?: string;
  baseUrl?: string;
  targetModel?: string;
  /** `true` pins a client BYOK endpoint to the strict public policy. */
  publicOnly?: boolean;
  /** `true` for a server-configured provider. */
  managed?: boolean;
}

interface CosyVoiceResponse {
  output?: {
    voice_id?: unknown;
    voice?: unknown;
    status?: unknown;
    target_model?: unknown;
    gmt_create?: unknown;
    preview_audio?: unknown;
    audio?: { url?: unknown; data?: unknown; format?: unknown; expires_at?: unknown };
    voice_list?: Array<{ voice_id?: unknown; target_model?: unknown; status?: unknown }>;
    page_index?: unknown;
    page_size?: unknown;
    total_count?: unknown;
  };
  code?: unknown;
  message?: unknown;
}

export type CosyVoiceOperation = 'enrollment' | 'synthesis';

const ERROR_MESSAGES: Record<CosyVoiceErrorCode, string> = {
  COSYVOICE_CONFIG_MISSING: 'CosyVoice is missing required configuration.',
  COSYVOICE_ENDPOINT_INVALID: 'The configured CosyVoice endpoint is invalid.',
  COSYVOICE_HTTP_ERROR: 'The voice service rejected the request.',
  COSYVOICE_TIMEOUT: 'The voice service request timed out.',
  COSYVOICE_TRANSPORT_ERROR: 'Could not reach the voice service.',
  COSYVOICE_RESPONSE_JSON_INVALID: 'The voice service returned an invalid response.',
  COSYVOICE_RESPONSE_VOICE_MISSING: 'The voice service did not return a voice ID.',
  COSYVOICE_RESPONSE_AUDIO_MISSING: 'The voice service did not return audio.',
  COSYVOICE_AUDIO_URL_INVALID: 'The voice service returned an untrusted audio URL.',
  COSYVOICE_AUDIO_DOWNLOAD_FAILED: 'The generated audio could not be downloaded.',
  COSYVOICE_AUDIO_TOO_LARGE: 'The generated audio exceeds the size limit.',
  COSYVOICE_AUDIO_EMPTY: 'The voice service returned empty audio.',
  COSYVOICE_AUDIO_TOO_LONG: 'The reference audio is longer than the enrollment limit.',
  COSYVOICE_VOICE_NOT_FOUND: 'This cloned voice no longer exists.',
  COSYVOICE_VOICE_NOT_READY: 'This cloned voice is still being prepared.',
  COSYVOICE_BOOTSTRAP_UNSUPPORTED: 'Voice cloning requires reference audio.',
};

/** Operation-specific wording for the codes whose text would otherwise mislead. */
const OPERATION_MESSAGES: Partial<Record<CosyVoiceErrorCode, Record<CosyVoiceOperation, string>>> =
  {
    COSYVOICE_HTTP_ERROR: {
      enrollment: 'The voice service rejected the enrollment request.',
      synthesis: 'The voice service rejected the speech synthesis request.',
    },
    COSYVOICE_TIMEOUT: {
      enrollment: 'The voice enrollment request timed out.',
      synthesis: 'The speech synthesis request timed out.',
    },
    COSYVOICE_TRANSPORT_ERROR: {
      enrollment: 'Could not reach the voice enrollment service.',
      synthesis: 'Could not reach the speech synthesis service.',
    },
  };

/**
 * The user-facing text, suffixed with the provider's own code/message so a
 * rejection is actionable instead of a generic refusal.
 */
export function cosyVoiceErrorMessage(
  error: CosyVoiceError,
  operation?: CosyVoiceOperation,
): string {
  const base =
    (operation && OPERATION_MESSAGES[error.code]?.[operation]) || ERROR_MESSAGES[error.code];
  const vendor = error.vendorMessage || error.vendorCode;
  return vendor ? `${base} (${vendor})` : base;
}

/**
 * Vendor rejections that mean "the sample audio is unusable". The endpoint ASRs
 * the clip, so a tone/silence/wrong-format upload lands here with an opaque
 * `request asr failed`. Surfacing it as a clip problem — the actual cause — saves
 * the user from re-uploading the same file blind.
 */
function isReferenceAudioRejection(body: CosyVoiceResponse): boolean {
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';
  return (
    /^audio\.(audioshorterror|audiosilenterror|.*invalid.*)$/iu.test(code) ||
    /audio url should start with|valid audio too short|silent audio error|request asr failed/iu.test(
      message,
    )
  );
}

function isUnknownVoiceResponse(body: CosyVoiceResponse): boolean {
  const code = typeof body.code === 'string' ? body.code : '';
  const message = typeof body.message === 'string' ? body.message : '';
  return (
    /^(?:voice[_-]?(?:not[_-]?found|not[_-]?exist|invalid)|invalid[_-]?voice)$/iu.test(code) ||
    /voice.{0,40}(?:not found|not exist|does not exist|invalid)/iu.test(message)
  );
}

/** A 5xx or transport error leaves existence undetermined, not disproven. */
function isTransientLookupFailure(error: unknown): boolean {
  return (
    error instanceof CosyVoiceError &&
    (error.code === 'COSYVOICE_TRANSPORT_ERROR' ||
      (error.code === 'COSYVOICE_HTTP_ERROR' &&
        typeof error.httpStatus === 'number' &&
        error.httpStatus >= 500))
  );
}

function resolveConfig(config: CosyVoiceConfig): {
  apiKey: string;
  baseUrl: URL;
  targetModel: string;
  publicOnly?: boolean;
  managed?: boolean;
} {
  const apiKey = config.apiKey?.trim() || '';
  const targetModel = config.targetModel?.trim() || '';
  if (!apiKey || !targetModel) throw new CosyVoiceError('COSYVOICE_CONFIG_MISSING', 400);

  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl?.trim() || DEFAULT_COSYVOICE_BASE_URL);
  } catch {
    throw new CosyVoiceError('COSYVOICE_ENDPOINT_INVALID', 400);
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.hostname !== 'localhost') {
    throw new CosyVoiceError('COSYVOICE_ENDPOINT_INVALID', 400);
  }
  return { apiKey, baseUrl, targetModel, publicOnly: config.publicOnly, managed: config.managed };
}

function endpoint(baseUrl: URL, path: string): URL {
  const normalized = new URL(baseUrl);
  const basePath = normalized.pathname.replace(/\/$/u, '');
  const suffix =
    basePath.endsWith('/api/v1') && path.startsWith('/api/v1/')
      ? path.slice('/api/v1'.length)
      : path;
  normalized.pathname = `${basePath}${suffix}`;
  normalized.search = '';
  normalized.hash = '';
  return normalized;
}

/**
 * The provider-visible voice name: `<prefix>_<audioHash8>`, ASCII-only.
 *
 * CosyVoice derives the returned `voice_id` from `prefix`, so it is the only
 * human-recognisable part of a cloned voice in the provider console.
 *
 * ⚠️ CosyVoice additionally constrains `prefix` to 10 characters and rejects a
 * leading digit, so the hash cannot simply be appended without overflowing the
 * budget — the prefix is shortened to make room for it.
 *
 * ⚠️ A fully non-ASCII name (e.g. `窦老师`) folds to an EMPTY string under the
 * `[^a-z0-9]` rule, collapsing every such voice to the bare prefix `v` —
 * indistinguishable in the console. We keep a short deterministic `u<hash>`
 * prefix derived from the ORIGINAL name so different Chinese names stay
 * distinguishable while remaining ASCII and stable for the same (name, audio).
 */
export function preferredVoiceName(name: string, audio: Uint8Array): string {
  // Imported lazily-shaped: the hash must cover the exact bytes we send, so a
  // stable digest of the audio is what makes the id idempotent per clip.
  const digest = hashAudio(audio);
  let prefix = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 6);
  if (/^[0-9]/u.test(prefix)) prefix = `v${prefix.match(/^[0-9]+/u)?.[0] || ''}`.slice(0, 6);
  else if (!/^[a-z]/u.test(prefix)) {
    const nameDigest = hashName(name);
    prefix = `u${nameDigest}`;
  }
  // CosyVoice: prefix <= 10 chars, letters/digits/underscore, must start with a
  // letter. Keep 2 hex chars of the audio digest so `窦老师_a1` and `刘老师_b2`
  // never collide on the same name.
  const head = prefix.slice(0, 6);
  return `${head}_${digest.slice(0, 4)}`.slice(0, 11);
}

function hashAudio(audio: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < audio.length; i++) {
    h ^= audio[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hashName(name: string): string {
  let h = 0x811c9dc5;
  const normalized = name.normalize('NFKC').trim();
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 4);
}

/**
 * Package reference audio for the enrollment `url` field.
 *
 * Inline payloads carry the MIME the caller declared for its own bytes. The
 * bytes are NOT re-encoded — doing so would need an encoder the server does not
 * carry, and the endpoint sniffs the container itself. Only the declared MIME
 * is policed, and the accepted set is eccentric:
 *
 *   audio/mp3  + real MP3 bytes   → accepted
 *   audio/mpeg + same bytes       → refused (`request asr failed`)
 *   audio/wav  + WAV bytes        → refused on the live endpoint today
 *
 * So the browser-side pipeline records MP3 for this provider; a caller that
 * somehow holds WAV must convert before calling, not lie about the MIME.
 */
export function toCosyVoiceAudioSource(audio: Uint8Array, mimeType?: string): string {
  if (audio.byteLength > MAX_INLINE_AUDIO_BYTES) {
    throw new CosyVoiceError('COSYVOICE_AUDIO_TOO_LARGE', 413);
  }
  const mime = mimeType?.trim().toLowerCase() === 'audio/wav' ? 'audio/wav' : INLINE_AUDIO_MIME;
  return `data:${mime};base64,${Buffer.from(audio).toString('base64')}`;
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function postJson(
  url: URL,
  apiKey: string,
  body: unknown,
  signal?: AbortSignal,
  target?: AudioEndpointTarget,
  operation?: CosyVoiceOperation,
): Promise<CosyVoiceResponse> {
  const timeout = timeoutSignal(signal, REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await audioProviderFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
        },
        audioEndpointPolicy(target),
      );
    } catch (error) {
      const blocked = findUnsafeNetworkTargetError(error);
      if (blocked) throw blocked;
      if (signal?.aborted) throw error;
      throw new CosyVoiceError(
        timeout.timedOut() ? 'COSYVOICE_TIMEOUT' : 'COSYVOICE_TRANSPORT_ERROR',
        timeout.timedOut() ? 504 : 502,
        undefined,
        undefined,
        operation,
      );
    }

    let parsed: CosyVoiceResponse;
    try {
      parsed = (await response.json()) as CosyVoiceResponse;
    } catch {
      if (!response.ok) throw new CosyVoiceError('COSYVOICE_HTTP_ERROR', response.status);
      throw new CosyVoiceError('COSYVOICE_RESPONSE_JSON_INVALID', 502);
    }
    if (!response.ok || (parsed.code !== undefined && !parsed.output)) {
      const vendorCode = typeof parsed.code === 'string' ? parsed.code : undefined;
      const vendorMessage =
        typeof parsed.message === 'string' && parsed.message.trim()
          ? parsed.message.trim()
          : undefined;
      const code: CosyVoiceErrorCode = isUnknownVoiceResponse(parsed)
        ? 'COSYVOICE_VOICE_NOT_FOUND'
        : isReferenceAudioRejection(parsed)
          ? 'COSYVOICE_RESPONSE_VOICE_MISSING'
          : 'COSYVOICE_HTTP_ERROR';
      throw new CosyVoiceError(
        code,
        response.ok ? 502 : response.status,
        vendorCode,
        vendorMessage,
        operation,
      );
    }
    return parsed;
  } finally {
    timeout.cleanup();
  }
}

/** Enrollment status returned by the provider for a submitted clip. */
export type CosyVoiceVoiceStatus = 'OK' | 'UNDEPLOYED' | 'PENDING' | 'unknown';

export async function registerCosyVoice(
  config: CosyVoiceConfig,
  input: { name: string; audio: Uint8Array; mimeType?: string },
  signal?: AbortSignal,
): Promise<{ voiceId: string; targetModel: string; status: CosyVoiceVoiceStatus }> {
  const resolved = resolveConfig(config);
  const body = await postJson(
    endpoint(resolved.baseUrl, ENROLLMENT_PATH),
    resolved.apiKey,
    {
      model: COSYVOICE_ENROLLMENT_MODEL,
      input: {
        action: 'create_voice',
        target_model: resolved.targetModel,
        prefix: preferredVoiceName(input.name, input.audio),
        url: toCosyVoiceAudioSource(input.audio, input.mimeType),
      },
    },
    signal,
    resolved,
    'enrollment',
  );
  const voiceId = typeof body.output?.voice_id === 'string' ? body.output.voice_id.trim() : '';
  if (!voiceId) throw new CosyVoiceError('COSYVOICE_RESPONSE_VOICE_MISSING', 502);
  return { voiceId, targetModel: resolved.targetModel, status: 'PENDING' };
}

/**
 * Poll one enrollment's status. `create_voice` returns immediately with an id
 * while the clip is still being processed, so synthesis must wait for `OK`.
 */
export async function queryCosyVoice(
  config: CosyVoiceConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<CosyVoiceVoiceStatus> {
  const resolved = resolveConfig(config);
  const wanted = voiceId.trim();
  if (!wanted) return 'unknown';
  const body = await postJson(
    endpoint(resolved.baseUrl, ENROLLMENT_PATH),
    resolved.apiKey,
    {
      model: COSYVOICE_ENROLLMENT_MODEL,
      input: { action: 'query_voice', voice_id: wanted },
    },
    signal,
    resolved,
    'enrollment',
  );
  const status = typeof body.output?.status === 'string' ? body.output.status : '';
  if (status === 'OK') return 'OK';
  if (status === 'UNDEPLOYED') return 'UNDEPLOYED';
  return status ? 'PENDING' : 'unknown';
}

/** Delete a CosyVoice-cloned voice from the provider account. */
export async function deleteCosyVoice(
  config: CosyVoiceConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  const resolved = resolveConfig(config);
  const voice = voiceId.trim();
  if (!voice) throw new CosyVoiceError('COSYVOICE_CONFIG_MISSING', 400);
  await postJson(
    endpoint(resolved.baseUrl, ENROLLMENT_PATH),
    resolved.apiKey,
    { model: COSYVOICE_ENROLLMENT_MODEL, input: { action: 'delete_voice', voice_id: voice } },
    signal,
    resolved,
    'enrollment',
  );
}

/**
 * Look a voice up in the account's enrollment list. This is the provider-backed
 * existence check (`list_voice`, not the Qwen line's `list`).
 */
export async function cosyVoiceExists(
  config: CosyVoiceConfig,
  voiceId: string,
  signal?: AbortSignal,
): Promise<boolean | 'unknown'> {
  const resolved = resolveConfig(config);
  const wanted = voiceId.trim();
  if (!wanted) return false;
  const pageSize = 100;
  let fetched = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    let body: CosyVoiceResponse;
    try {
      body = await postJson(
        endpoint(resolved.baseUrl, ENROLLMENT_PATH),
        resolved.apiKey,
        {
          model: COSYVOICE_ENROLLMENT_MODEL,
          input: { action: 'list_voice', page_size: pageSize, page_index: pageIndex },
        },
        signal,
        resolved,
        'enrollment',
      );
    } catch (error) {
      if (isTransientLookupFailure(error)) return 'unknown';
      throw error;
    }
    const voices = Array.isArray(body.output?.voice_list) ? body.output.voice_list : [];
    if (
      voices.some(
        (item) =>
          typeof item?.voice_id === 'string' &&
          item.voice_id === wanted &&
          item.target_model === resolved.targetModel,
      )
    ) {
      return true;
    }
    fetched += voices.length;
    const total =
      typeof body.output?.total_count === 'number' ? body.output.total_count : undefined;
    if (voices.length === 0) return total !== undefined && fetched < total ? 'unknown' : false;
    if (total !== undefined && fetched >= total) return false;
  }
  return 'unknown';
}

function decodeInlineAudio(data: unknown): Uint8Array | undefined {
  if (typeof data !== 'string' || !data.trim()) return undefined;
  try {
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    return bytes.byteLength ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export async function downloadAudio(
  rawUrl: string,
  signal?: AbortSignal,
  effectiveBaseUrl?: string | URL,
  publicOnly?: boolean,
): Promise<{ bytes: Uint8Array; contentType: string | null; url: URL }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CosyVoiceError('COSYVOICE_AUDIO_URL_INVALID', 502);
  }
  // Verified against live vendor responses (dashscope-result-bj.oss-cn-beijing).
  const trustedHost = /^dashscope-result-[a-z0-9-]+\.oss-[a-z]{2}-[a-z0-9-]+\.aliyuncs\.com$/u.test(
    url.hostname,
  );
  let trustedCustomEndpoint = false;
  if (effectiveBaseUrl) {
    try {
      const configured = new URL(effectiveBaseUrl);
      const defaultEndpoint = new URL(DEFAULT_COSYVOICE_BASE_URL);
      trustedCustomEndpoint =
        configured.origin !== defaultEndpoint.origin &&
        url.host === configured.host &&
        url.protocol === configured.protocol;
    } catch {
      throw new CosyVoiceError('COSYVOICE_ENDPOINT_INVALID', 400);
    }
  }
  if (
    (!trustedHost && !trustedCustomEndpoint) ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (trustedHost && url.port && url.port !== '80' && url.port !== '443')
  ) {
    throw new CosyVoiceError('COSYVOICE_AUDIO_URL_INVALID', 502);
  }
  if (trustedHost && url.protocol === 'http:') url.protocol = 'https:';

  const allowLocalNetworks = resolveAllowLocalNetworks(publicOnly ? false : undefined);
  const timeout = timeoutSignal(signal, AUDIO_DOWNLOAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      const ssrfError = await validateUrlForSSRFWithPolicy(url.href, { allowLocalNetworks });
      if (ssrfError) throw new UnsafeNetworkTargetError(ssrfError);
      response = await audioProviderFetch(
        url,
        { signal: timeout.signal, redirect: 'error' },
        { allowLocalNetworks: publicOnly ? false : undefined, rejectRedirects: true },
      );
    } catch (error) {
      const blocked = findUnsafeNetworkTargetError(error);
      if (blocked) throw blocked;
      if (signal?.aborted) throw error;
      throw new CosyVoiceError(
        timeout.timedOut() ? 'COSYVOICE_TIMEOUT' : 'COSYVOICE_AUDIO_DOWNLOAD_FAILED',
        timeout.timedOut() ? 504 : 502,
        undefined,
        undefined,
        'synthesis',
      );
    }
    if (!response.ok) {
      throw new CosyVoiceError('COSYVOICE_AUDIO_DOWNLOAD_FAILED', response.status);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_RESPONSE_BYTES) {
      throw new CosyVoiceError('COSYVOICE_AUDIO_TOO_LARGE', 502);
    }
    if (!response.body) throw new CosyVoiceError('COSYVOICE_AUDIO_EMPTY', 502);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_AUDIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CosyVoiceError('COSYVOICE_AUDIO_TOO_LARGE', 502);
      }
      chunks.push(value);
    }
    if (!totalBytes) throw new CosyVoiceError('COSYVOICE_AUDIO_EMPTY', 502);
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType: response.headers.get('content-type'), url };
  } finally {
    timeout.cleanup();
  }
}

function audioFormat(contentType: string | null, vendorFormat: unknown, url: URL): string {
  if (typeof vendorFormat === 'string' && /^[a-z0-9]+$/iu.test(vendorFormat)) {
    return vendorFormat.toLowerCase();
  }
  const normalizedType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedType === 'audio/mpeg' || normalizedType === 'audio/mp3') return 'mp3';
  if (normalizedType === 'audio/wav' || normalizedType === 'audio/x-wav') return 'wav';
  if (normalizedType?.startsWith('audio/')) return normalizedType.slice('audio/'.length);
  return url.pathname.match(/\.([a-z0-9]{2,5})$/iu)?.[1]?.toLowerCase() || 'mp3';
}

/**
 * Synthesize speech with a cloned (or system) CosyVoice voice.
 *
 * Uses the `SpeechSynthesizer` path — CosyVoice does NOT speak the multimodal
 * generation endpoint that Qwen-TTS uses, and mixing them yields a confusing
 * `Model not exist.` from the gateway.
 */
export async function synthesizeCosyVoice(
  config: CosyVoiceConfig,
  text: string,
  voiceId: string,
  speed = 1,
  signal?: AbortSignal,
): Promise<TTSGenerationResult> {
  const resolved = resolveConfig(config);
  const voice = voiceId.trim();
  if (!voice) throw new CosyVoiceError('COSYVOICE_CONFIG_MISSING', 400);
  void speed; // CosyVoice has no rate parameter on this path.

  const deadline = timeoutSignal(signal, SYNTHESIS_DEADLINE_MS);
  try {
    const body = await postJson(
      endpoint(resolved.baseUrl, SYNTHESIS_PATH),
      resolved.apiKey,
      {
        model: resolved.targetModel,
        input: { text, voice, format: 'mp3', sample_rate: 22050 },
      },
      deadline.signal,
      resolved,
      'synthesis',
    );

    // `data` carries the audio inline as base64; prefer it and skip the fetch.
    const inline = decodeInlineAudio(body.output?.audio?.data);
    if (inline) {
      // The request pinned `format: 'mp3'`, so the inline bytes are MP3. The
      // vendor `format` field is absent on this response shape, hence the
      // explicit default rather than a content-type/URL sniff.
      return { audio: inline, format: 'mp3' };
    }

    const rawAudioUrl =
      typeof body.output?.audio?.url === 'string' ? body.output.audio.url.trim() : '';
    if (!rawAudioUrl) {
      throw new CosyVoiceError('COSYVOICE_RESPONSE_AUDIO_MISSING', 502);
    }
    const downloaded = await downloadAudio(
      rawAudioUrl,
      deadline.signal,
      resolved.baseUrl,
      resolved.publicOnly,
    );
    return {
      audio: downloaded.bytes,
      format: audioFormat(downloaded.contentType, body.output?.audio?.format, downloaded.url),
    };
  } catch (error) {
    if (deadline.timedOut()) throw new CosyVoiceError('COSYVOICE_TIMEOUT', 504);
    throw error;
  } finally {
    deadline.cleanup();
  }
}
