/**
 * yovoice TTS client — a LOCAL inference server (the yovoice desktop app or
 * `yovoice serve`) exposing an HTTP API on the operator's machine. Unlike the
 * cloud providers this is a single synchronous call: POST /v1/generate with
 * `{text, modelId, voiceId}` returns the finished WAV bytes directly.
 *
 * Endpoint shape (docs `api_zh.md`):
 *   POST {base}/v1/generate   {"text","modelId","voiceId"} → audio/wav
 *   401 bad token · 409 busy (single-task server, no queue) · 504 timeout
 *
 * Fetch policy: the base URL defaults to the operator-owned local endpoint
 * (`host.docker.internal` from the OpenMAIC container), so an EMPTY client
 * baseUrl runs under the operator's ALLOW_LOCAL_NETWORKS opt-in. A
 * client-supplied baseUrl keeps the strict public policy, exactly like every
 * other BYOK provider.
 */
import type { TTSGenerationResult } from '@/lib/audio/tts-providers';
import type { TTSModelConfig } from '@/lib/audio/types';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { audioEndpointPolicy, audioProviderFetch } from '@/lib/server/audio-provider-fetch';

export const YOVOICE_TTS_PROVIDER_ID = 'yovoice-tts' as const;

export type YovoiceErrorCode =
  | 'YOVOICE_CONFIG_MISSING'
  | 'YOVOICE_HTTP_ERROR'
  | 'YOVOICE_BUSY'
  | 'YOVOICE_TIMEOUT'
  | 'YOVOICE_TRANSPORT_ERROR'
  | 'YOVOICE_EMPTY_AUDIO';

export class YovoiceTTSError extends Error {
  constructor(
    public readonly code: YovoiceErrorCode,
    public readonly status?: number,
  ) {
    super(code);
    this.name = 'YovoiceTTSError';
  }
}

/** The single-task server rejects concurrent work with 409; retry briefly. */
export const BUSY_RETRY_ATTEMPTS = 2;
let busyRetryBaseMs = 2000;

/** Test hook: ESM bindings are read-only across modules, so expose a setter. */
export function setBusyRetryBackoffForTests(ms: number): void {
  busyRetryBaseMs = ms;
}

interface YovoiceFetchTarget {
  publicOnly?: boolean;
  managed?: boolean;
}

function resolveBaseUrl(config: TTSModelConfig): string {
  const baseUrl = (
    config.baseUrl?.trim() ||
    TTS_PROVIDERS['yovoice-tts'].defaultBaseUrl ||
    'http://host.docker.internal:8080'
  ).replace(/\/+$/u, '');
  return baseUrl;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function generateYovoiceTTS(
  config: TTSModelConfig,
  text: string,
  signal: AbortSignal,
): Promise<TTSGenerationResult> {
  const voiceId = config.voice?.trim();
  if (!voiceId || voiceId.startsWith('__yovoice')) {
    throw new YovoiceTTSError('YOVOICE_CONFIG_MISSING', 400);
  }
  const baseUrl = resolveBaseUrl(config);
  const modelId = config.modelId?.trim() || 'voxcpm2-orig';
  const target: YovoiceFetchTarget = {
    publicOnly: config.publicOnly,
    managed: config.managed,
  };

  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await audioProviderFetch(
        `${baseUrl}/v1/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(config.apiKey?.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
          },
          body: JSON.stringify({ text, modelId, voiceId }),
          signal,
        },
        audioEndpointPolicy(target as never),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new YovoiceTTSError('YOVOICE_TRANSPORT_ERROR');
    }

    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new YovoiceTTSError('YOVOICE_EMPTY_AUDIO', 502);
      // yovoice always answers /v1/generate with a RIFF/WAVE stream; accept any
      // audio-labelled body too so a future format bump does not wedge here.
      const isRiff =
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!isRiff && !contentType.startsWith('audio/')) {
        throw new YovoiceTTSError('YOVOICE_EMPTY_AUDIO', 502);
      }
      return { audio: bytes, format: 'wav' };
    }

    lastStatus = response.status;
    if (response.status === 409) {
      if (attempt < BUSY_RETRY_ATTEMPTS) {
        await sleep(busyRetryBaseMs * (attempt + 1));
        continue;
      }
      throw new YovoiceTTSError('YOVOICE_BUSY', 409);
    }
    if (response.status === 504) throw new YovoiceTTSError('YOVOICE_TIMEOUT', 504);
    throw new YovoiceTTSError('YOVOICE_HTTP_ERROR', response.status);
  }
  throw new YovoiceTTSError('YOVOICE_BUSY', lastStatus);
}
