/**
 * MiMo-V2.5-TTS synthesis client tests — CLONE-ONLY build.
 *
 * Locks the live-probed wire contract (docs/mimo-tts-feasibility-analysis.md):
 * assistant-carries-text, user-carries-style, voice=data-URI sample, inline
 * base64 response — plus the two undocumented behaviors: 429 retry and the
 * corrupt-sample 500 fallback wording. The clone-only decision (2026-10-15)
 * removed the preset catalog and the voicedesign model, so there is exactly
 * one model and a missing sample is a named error, never a silent fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same transport double as the CosyVoice tests: audioProviderFetch goes through
// undici's fetch (pinned dispatcher), and the SSRF guard consults dns.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.stubGlobal('fetch', fetchMock);
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: vi.fn().mockResolvedValue({ address: '1.2.3.4' }) },
  };
});

import { generateMiMoTTS } from '@/lib/audio/mimo-tts';
import { MIMO_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/mimo';

const BASE = 'https://api.xiaomimimo.com/v1';
const CONFIG = {
  providerId: 'mimo-tts' as const,
  voice: 'mimo:profile:p1',
  apiKey: 'sk-test',
  baseUrl: BASE,
};
const CLONE_OPTIONS = {
  voiceMode: 'clone' as const,
  referenceAudioBase64: 'QUJD',
  referenceAudioMimeType: 'audio/wav',
};

function wavB64(): string {
  // minimal RIFF....WAVE header + payload
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return btoa(String.fromCharCode(...bytes));
}

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MiMo TTS (clone-only)', () => {
  it('always speaks through the voiceclone model, sample and all', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { audio: { data: wavB64() } } }] }),
    );
    // Even a stale preset-looking voice id cannot pick another model — the
    // provider has exactly one, and the sample is what makes it speak.
    const result = await generateMiMoTTS(
      { ...CONFIG, voice: '冰糖', providerOptions: CLONE_OPTIONS },
      '你好',
      AbortSignal.timeout(10_000),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe(MIMO_TTS_VOICE_CLONE_MODEL);
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: '你好' });
    expect(body.audio.voice).toBe('data:audio/wav;base64,QUJD');
    expect(result.format).toBe('wav');
  });

  it('assembles the clone data URI with the profile MIME and style instruction', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { audio: { data: wavB64() } } }] }),
    );
    await generateMiMoTTS(
      {
        ...CONFIG,
        providerOptions: {
          ...CLONE_OPTIONS,
          referenceAudioMimeType: 'audio/mpeg',
          styleInstruction: '激动地说',
        },
      },
      '太好了',
      AbortSignal.timeout(10_000),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0]).toEqual({ role: 'user', content: '激动地说' });
    expect(body.audio.voice).toBe('data:audio/mpeg;base64,QUJD');
  });

  it('sends an empty user message when no style instruction is set', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { audio: { data: wavB64() } } }] }),
    );
    await generateMiMoTTS(
      { ...CONFIG, providerOptions: CLONE_OPTIONS },
      '晚安',
      AbortSignal.timeout(10_000),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0]).toEqual({ role: 'user', content: '' });
  });

  it('rejects a clone request whose sample did not accompany the options', async () => {
    // No system voice exists to fall back to, so the missing sample is a named
    // 400 before any network call.
    await expect(
      generateMiMoTTS(
        { ...CONFIG, providerOptions: { voiceMode: 'clone' } },
        'x',
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ code: 'MIMO_CLONE_REQUIRES_SAMPLE', httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries 429 with backoff and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"error":{"code":"429","message":"Too many requests"}}', { status: 429 }),
      )
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { audio: { data: wavB64() } } }] }));
    const pending = generateMiMoTTS(
      { ...CONFIG, providerOptions: CLONE_OPTIONS },
      'hi',
      AbortSignal.timeout(10_000),
    );
    await vi.advanceTimersByTimeAsync(2500);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.format).toBe('wav');
  });

  it('surfaces exhausted 429 as a typed rate-limit error', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":{"code":"429","message":"Too many requests"}}', { status: 429 }),
    );
    const pending = generateMiMoTTS(
      { ...CONFIG, providerOptions: CLONE_OPTIONS },
      'hi',
      AbortSignal.timeout(10_000),
    );
    // Advance past EVERY scheduled backoff (the last retry's sleep must land
    // inside the test window, or its rejection surfaces as an unhandled error
    // after fake timers are restored).
    let rejected = false;
    pending.catch(() => {
      rejected = true;
    });
    for (let i = 0; i < 12 && !rejected; i++) await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).rejects.toMatchObject({ code: 'MIMO_HTTP_ERROR', httpStatus: 429 });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('adds actionable wording to a clone 500 (corrupt sample)', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":{"code":"500","message":"Internal Server Error"}}', { status: 500 }),
    );
    const error = await generateMiMoTTS(
      { ...CONFIG, providerOptions: CLONE_OPTIONS },
      'hi',
      AbortSignal.timeout(10_000),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('could not be decoded');
  });

  it('reports missing inline audio', async () => {
    fetchMock.mockResolvedValue(okResponse({ choices: [{ message: {} }] }));
    await expect(
      generateMiMoTTS(
        { ...CONFIG, providerOptions: CLONE_OPTIONS },
        'hi',
        AbortSignal.timeout(10_000),
      ),
    ).rejects.toMatchObject({ code: 'MIMO_RESPONSE_AUDIO_MISSING' });
  });

  it('detects mp3 output bytes from the frame header', async () => {
    // ID3 header → 'mp3'
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0]);
    fetchMock.mockResolvedValue(
      okResponse({
        choices: [{ message: { audio: { data: btoa(String.fromCharCode(...bytes)) } } }],
      }),
    );
    const result = await generateMiMoTTS(
      { ...CONFIG, providerOptions: CLONE_OPTIONS },
      'hi',
      AbortSignal.timeout(10_000),
    );
    expect(result.format).toBe('mp3');
  });

  it('requires an api key and tolerates a pasted full endpoint url', async () => {
    await expect(
      generateMiMoTTS({ ...CONFIG, apiKey: '' }, 'hi', AbortSignal.timeout(10_000)),
    ).rejects.toMatchObject({ code: 'MIMO_CONFIG_MISSING' });
    fetchMock.mockResolvedValue(
      okResponse({ choices: [{ message: { audio: { data: wavB64() } } }] }),
    );
    await generateMiMoTTS(
      { ...CONFIG, baseUrl: `${BASE}/chat/completions`, providerOptions: CLONE_OPTIONS },
      'hi',
      AbortSignal.timeout(10_000),
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/chat/completions`);
  });
});
