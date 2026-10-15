/**
 * MiMo-V2.5-TTS synthesis client (server side) — CLONE-ONLY.
 *
 * One endpoint, one model: OpenAI-compatible
 * `POST {base}/chat/completions` with `mimo-v2.5-tts-voiceclone`. Wire
 * contract (docs + live probes 2026-10-12, see
 * docs/mimo-tts-feasibility-analysis.md):
 *
 *   - synthesis text goes in the `assistant` message (400 without it);
 *   - `user` message carries the optional style instruction (empty string is
 *     the documented norm);
 *   - `audio.voice` = `data:{mime};base64,{sample}` — the reference audio,
 *     inline per request (mp3/wav both accepted);
 *   - response audio is INLINE base64 at `choices[0].message.audio.data`
 *     (wav/pcm16/mp3 by `audio.format`) — no URL, no second download;
 *   - live measured quirks the docs do not state:
 *       HTTP 429 rate limiting (retry with backoff, honor Retry-After);
 *       corrupt/denormal sample audio fails as a bare HTTP 500 (decode check
 *         client-side, and word the error so users change the file);
 *       long text can take ~60s — the route budget is 30s, so requests get a
 *         slightly shorter deadline and a clear timeout message.
 *
 * The preset catalog and the voicedesign model were removed 2026-10-15
 * ("clone-only" decision): there is no system voice to fall back to, so a
 * request whose sample did not accompany the options is a named 400
 * (MIMO_CLONE_REQUIRES_SAMPLE) — never a silent switch to another voice.
 */

// Type-only import: tts-providers value-imports generateMiMoTTS, so this side
// must stay type-only or the two modules form a runtime cycle. Rate limiting is
// reported through MiMoTTSError (routed below in the API route) rather than the
// shared TTSRateLimitError for the same reason.
import type { TTSGenerationResult } from '@/lib/audio/tts-providers';
import type { TTSModelConfig } from '@/lib/audio/types';
import { MIMO_TTS_VOICE_CLONE_MODEL, type MimoProviderOptions } from '@/lib/audio/mimo';
import { audioEndpointPolicy, audioProviderFetch } from '@/lib/server/audio-provider-fetch';

const CHAT_COMPLETIONS_PATH = '/chat/completions';
const DEFAULT_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1';
/** Just under the route's maxDuration so the user sees our message, not a 504. */
const SYNTHESIS_DEADLINE_MS = 28_000;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;
const RATE_LIMIT_RETRY_ATTEMPTS = 2;

export type MiMoErrorCode =
  | 'MIMO_CONFIG_MISSING'
  | 'MIMO_ENDPOINT_INVALID'
  | 'MIMO_CLONE_REQUIRES_SAMPLE'
  | 'MIMO_HTTP_ERROR'
  | 'MIMO_TIMEOUT'
  | 'MIMO_TRANSPORT_ERROR'
  | 'MIMO_RESPONSE_JSON_INVALID'
  | 'MIMO_RESPONSE_AUDIO_MISSING'
  | 'MIMO_AUDIO_TOO_LARGE';

export class MiMoTTSError extends Error {
  constructor(
    public readonly code: MiMoErrorCode,
    public readonly httpStatus?: number,
    public readonly vendorCode?: string,
    public readonly vendorMessage?: string,
  ) {
    super(`${code}${vendorMessage ? `: ${vendorMessage}` : ''}`);
    this.name = 'MiMoTTSError';
  }
}

interface MiMoFetchTarget {
  apiKey: string;
  baseUrl: string;
  publicOnly?: boolean;
  managed?: boolean;
}

function resolveTarget(config: TTSModelConfig): MiMoFetchTarget {
  const apiKey = config.apiKey?.trim() || '';
  if (!apiKey) throw new MiMoTTSError('MIMO_CONFIG_MISSING', 400, undefined, 'API key required');
  let url: URL;
  try {
    url = new URL((config.baseUrl?.trim() || DEFAULT_MIMO_BASE_URL).replace(/\/+$/u, '') + '/');
  } catch {
    throw new MiMoTTSError('MIMO_ENDPOINT_INVALID', 400);
  }
  const path = url.pathname.replace(/\/+$/u, '');
  // Accept both `…/v1` and a bare host; also tolerate a pasted `…/chat/completions`.
  const base = path.endsWith('/chat/completions')
    ? path.slice(0, -'/chat/completions'.length)
    : path;
  url.pathname = `${base}${CHAT_COMPLETIONS_PATH}`;
  url.search = '';
  url.hash = '';
  return {
    apiKey,
    baseUrl: url.toString(),
    publicOnly: config.publicOnly,
    managed: config.managed,
  };
}

function buildPayload(text: string, options: MimoProviderOptions): Record<string, unknown> {
  // Clone-only: the sample is mandatory. The API route pre-checks the same
  // condition; this is the second layer for direct adapter calls.
  const sample = options.referenceAudioBase64?.trim();
  if (!sample) {
    throw new MiMoTTSError(
      'MIMO_CLONE_REQUIRES_SAMPLE',
      400,
      undefined,
      'the reference audio sample did not accompany the clone request',
    );
  }
  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: options.styleInstruction?.trim() || '' },
    { role: 'assistant', content: text },
  ];
  const mime = options.referenceAudioMimeType?.trim() || 'audio/wav';
  const audio: Record<string, unknown> = {
    format: 'wav',
    voice: `data:${mime};base64,${sample}`,
  };
  return { model: MIMO_TTS_VOICE_CLONE_MODEL, messages, audio, stream: false };
}

function decodeInlineAudio(data: unknown): Uint8Array | undefined {
  if (typeof data !== 'string' || !data) return undefined;
  try {
    const binary = atob(data.replace(/^data:.*;base64,/u, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateMiMoTTS(
  config: TTSModelConfig,
  text: string,
  signal: AbortSignal,
): Promise<TTSGenerationResult> {
  const target = resolveTarget(config);
  const options = (config.providerOptions || {}) as MimoProviderOptions;
  const payload = buildPayload(text, options);
  const body = JSON.stringify(payload);

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout')), SYNTHESIS_DEADLINE_MS);

  try {
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      response = await audioProviderFetch(
        target.baseUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        },
        audioEndpointPolicy(target as never),
      ).catch(async (error: unknown) => {
        if (error instanceof Error && error.message === 'timeout') {
          throw new MiMoTTSError('MIMO_TIMEOUT', 504);
        }
        if (controller.signal.aborted && signal.aborted) throw error;
        throw new MiMoTTSError('MIMO_TRANSPORT_ERROR', 502, undefined, String(error));
      });
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRY_ATTEMPTS) break;
      // MiMo rate-limits hard (measured ~5 req/min); one backoff hop on the
      // server side keeps a multi-agent burst from turning into 429 storms.
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1),
      );
      if (controller.signal.aborted) {
        if (signal.aborted) throw controller.signal.reason;
        throw new MiMoTTSError('MIMO_TIMEOUT', 504);
      }
    }

    if (!response.ok) {
      // 429 surfaces as MIMO_HTTP_ERROR{httpStatus:429}; the API route maps any
      // 429 to its RATE_LIMITED envelope, so no runtime import of the shared
      // TTSRateLimitError (which would cycle through tts-providers).
      const raw = await response.text().catch(() => '');
      let vendorCode = '';
      let vendorMessage = raw.slice(0, 200);
      try {
        const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string } };
        vendorCode = parsed.error?.code || '';
        vendorMessage = parsed.error?.message || vendorMessage;
      } catch {
        /* keep raw */
      }
      if (response.status === 500) {
        // MiMo answers a corrupt/undecodable sample with a bare 500 — say what
        // the user can act on.
        vendorMessage = `${vendorMessage} (the reference audio could not be decoded — use a normal playable mp3/wav clip)`;
      }
      throw new MiMoTTSError('MIMO_HTTP_ERROR', response.status, vendorCode, vendorMessage);
    }

    // Content-Length is advisory; the real cap is checked while reading.
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_RESPONSE_BYTES) {
      throw new MiMoTTSError('MIMO_AUDIO_TOO_LARGE', 502);
    }
    let data: {
      choices?: Array<{ message?: { audio?: { data?: string } } }>;
    };
    try {
      data = await response.json();
    } catch {
      throw new MiMoTTSError('MIMO_RESPONSE_JSON_INVALID', 502);
    }
    const audioBytes = decodeInlineAudio(data.choices?.[0]?.message?.audio?.data);
    if (!audioBytes || !audioBytes.byteLength) {
      throw new MiMoTTSError('MIMO_RESPONSE_AUDIO_MISSING', 502);
    }
    if (audioBytes.byteLength > MAX_AUDIO_RESPONSE_BYTES) {
      throw new MiMoTTSError('MIMO_AUDIO_TOO_LARGE', 502);
    }
    const format =
      audioBytes[0] === 0x52 && audioBytes[1] === 0x49
        ? 'wav' // "RI" of RIFF
        : audioBytes[0] === 0xff || (audioBytes[0] === 0x49 && audioBytes[1] === 0x44)
          ? 'mp3' // MPEG frame sync or ID3
          : 'wav';
    return { audio: audioBytes, format };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
